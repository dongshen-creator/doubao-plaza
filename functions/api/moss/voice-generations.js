// Mossland (MOSI) 音色设计（自然语言描述声音风格生成语音）
// POST /api/moss/voice-generations
// 参数: { input, instruction, response_format?, delivery_method?, async? }
//   - input: 待生成语音的文字（必填）
//   - instruction: 自然语言声音风格描述，如「一个温柔、自然、略带微笑感的年轻女声」（必填）
//   - response_format: mp3（默认）/ wav
//   - delivery_method: url（默认，返回 JSON + 结果 URL）/ audio（直接返回音频二进制）
// 文档: https://platform.mosi.cn/docs/scenarios/voice-design
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
  const { input, instruction, response_format = 'mp3', delivery_method = 'url', async = false } = body;

  if (!input || typeof input !== 'string') {
    return jsonResponse({ success: false, error: '缺少 input 参数（待生成语音的文字）' }, 400);
  }
  if (!instruction || typeof instruction !== 'string') {
    return jsonResponse({ success: false, error: '缺少 instruction 参数（声音风格描述）' }, 400);
  }
  if (input.length > 5000) {
    return jsonResponse({ success: false, error: '文本过长（最多5000字符）' }, 400);
  }

  const payload = {
    model: 'moss-voice-generator',
    input,
    instruction,
    response_format,
    delivery_method,
    async,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const resp = await fetch(`${MOSS_BASE}/audio/voice/generations`, {
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
      return jsonResponse({ success: false, error: `MOSS 音色设计上游返回 ${resp.status}`, detail: errText.slice(0, 500) }, 502);
    }

    const ctype = resp.headers.get('Content-Type') || '';
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

    const data = await resp.json().catch(() => ({}));
    return jsonResponse({ success: true, ...data });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return jsonResponse({ success: false, error: 'MOSS 音色设计响应超时（25秒）' }, 504);
    }
    return jsonResponse({ success: false, error: 'MOSS 请求失败: ' + (err.message || '未知错误') }, 502);
  }
}
