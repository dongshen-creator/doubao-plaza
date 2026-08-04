// Mossland (MOSI) 音色管理转接端点
// GET  /api/moss/voices - 查询当前账号可用音色列表
// POST /api/moss/voices - 以音频样本创建/克隆音色（multipart: audio_sample 文件 + name）
// 返回 GET: { success: true, voices: [...] } / POST: { success: true, voice_id, name }
// 文档: https://platform.mosi.cn/docs/reference/voices-list
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

// POST：以音频样本创建/克隆音色（multipart: audio_sample + 可选 name）
export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const formData = await request.formData().catch(() => null);
    if (!formData) return jsonResponse({ success: false, error: 'multipart 表单解析失败' }, 400);

    const audioSample = formData.get('audio_sample');
    if (!audioSample) return jsonResponse({ success: false, error: '缺少 audio_sample 字段（参考音频文件）' }, 400);
    if (audioSample.size > 20 * 1024 * 1024) return jsonResponse({ success: false, error: '音频文件过大（最大20MB）' }, 413);

    const out = new FormData();
    out.append('audio_sample', audioSample, audioSample.name || 'sample.wav');
    const name = formData.get('name');
    if (name) out.append('name', name);
    const description = formData.get('description');
    if (description) out.append('description', description);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    const resp = await fetch(`${MOSS_BASE}/audio/voices`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + getApiKey(env) },
      body: out,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return jsonResponse({ success: false, error: `MOSS 创建音色上游返回 ${resp.status}`, detail: JSON.stringify(data).slice(0, 500) }, 502);
    }
    return jsonResponse({ success: true, voice_id: data.id || '', name: data.name || (name || '') , ...data });
  } catch (err) {
    if (err.name === 'AbortError') return jsonResponse({ success: false, error: 'MOSS 创建音色响应超时（30秒）' }, 504);
    return jsonResponse({ success: false, error: 'MOSS 创建音色失败: ' + (err.message || '未知错误') }, 502);
  }
}

export async function onRequestGet(context) {
  const { env } = context;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(`${MOSS_BASE}/audio/voices`, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + getApiKey(env) },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return jsonResponse({ success: false, error: `MOSS 上游返回 ${resp.status}`, detail: errText.slice(0, 500) }, 502);
    }

    const data = await resp.json().catch(() => ({}));
    return jsonResponse({ success: true, ...data });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return jsonResponse({ success: false, error: 'MOSS 音色列表响应超时' }, 504);
    }
    return jsonResponse({ success: false, error: 'MOSS 请求失败: ' + (err.message || '未知错误') }, 502);
  }
}
