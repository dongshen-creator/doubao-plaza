// Mossland (MOSI) 文本转语音转接端点
// POST /api/moss/tts
// 参数: { text, voice_id, response_format?, delivery_method?, async?, webhook_url? }
//   - text: 待合成文本（必填）
//   - voice_id: 音色 ID（必填，可通过 GET /api/moss/voices 获取）
//   - response_format: mp3（默认）/ wav
//   - delivery_method: audio（默认，直接返回音频二进制）/ url（返回 JSON + 结果 URL）
//   - async: 是否异步任务（默认 false）
// 文档: https://platform.mosi.cn/docs/reference/speech
// 密钥仅保存在后端（Cloudflare 环境变量 MOSS_API_KEY，回退硬编码），前端不暴露。

const MOSS_BASE = 'https://api.mosi.cn/v1';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function getApiKey(env) {
  return env?.MOSS_API_KEY || 'sk-1975f45d46a62ad18a1c12983c4df85484a7310de434b59c';
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => ({}));
  const { text, voice_id, response_format = 'mp3', delivery_method = 'audio', async = false, webhook_url } = body;

  if (!text || typeof text !== 'string') {
    return jsonResponse({ success: false, error: '缺少 text 参数' }, 400);
  }
  if (!voice_id || typeof voice_id !== 'string') {
    return jsonResponse({ success: false, error: '缺少 voice_id 参数（可通过 GET /api/moss/voices 获取音色列表）' }, 400);
  }
  if (text.length > 5000) {
    return jsonResponse({ success: false, error: '文本过长（最多5000字符）' }, 400);
  }

  const payload = {
    model: 'moss-tts',
    input: text,
    voice_id,
    response_format,
    delivery_method,
    async,
  };
  if (webhook_url) payload.webhook_url = webhook_url;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const resp = await fetch(`${MOSS_BASE}/audio/speech`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + getApiKey(env),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return jsonResponse({ success: false, error: `MOSS TTS 上游返回 ${resp.status}`, detail: errText.slice(0, 500) }, 502);
    }

    const ctype = resp.headers.get('Content-Type') || '';
    // delivery_method=audio → 直接透传音频二进制
    if (delivery_method === 'audio' && !ctype.includes('application/json')) {
      return new Response(resp.body, {
        status: 200,
        headers: {
          'Content-Type': ctype,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // delivery_method=url 或异步 → 透传 JSON
    const data = await resp.json().catch(() => ({}));
    return jsonResponse({ success: true, ...data });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return jsonResponse({ success: false, error: 'MOSS TTS 响应超时（25秒）' }, 504);
    }
    return jsonResponse({ success: false, error: 'MOSS TTS 请求失败: ' + (err.message || '未知错误') }, 502);
  }
}
