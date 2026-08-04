// Mossland (MOSI) 语音转文本转接端点
// POST /api/moss/stt
// 支持两种输入：
//   1. multipart/form-data: 字段 file=<音频文件>（浏览器录音 blob 直传），可选 model
//   2. application/json: { url: "公网音频URL" } 或 { file_id: "已上传文件ID" }
// 返回: { success: true, text: "识别文本" }
// 文档: https://platform.mosi.cn/docs/reference/transcriptions
// 密钥仅保存在后端（Cloudflare 环境变量 MOSS_API_KEY，回退硬编码），前端不暴露。

const MOSS_BASE = 'https://api.mosi.cn/v1';
const MAX_BYTES = 20 * 1024 * 1024; // 最大 20MB 音频

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
  const contentType = request.headers.get('Content-Type') || '';

  try {
    let upstreamBody;
    let upstreamContentType;

    if (contentType.includes('multipart/form-data')) {
      // 方式1: 浏览器录音 blob 以 multipart 上传（file 字段）
      const formData = await request.formData().catch(() => null);
      if (!formData) {
        return jsonResponse({ success: false, error: 'multipart 表单解析失败' }, 400);
      }
      const file = formData.get('file');
      if (!file) {
        return jsonResponse({ success: false, error: '缺少 file 字段（音频文件）' }, 400);
      }
      if (file.size > MAX_BYTES) {
        return jsonResponse({ success: false, error: '音频文件过大（最大20MB）' }, 413);
      }
      const model = formData.get('model') || 'moss-transcribe';
      const response_format = formData.get('response_format') || 'json';

      // 重新组装 multipart，避免透传前端不可信的表单字段
      const out = new FormData();
      out.append('file', file, file.name || 'recording.webm');
      out.append('model', model);
      out.append('response_format', response_format);
      upstreamBody = out;
      upstreamContentType = null; // 让 fetch 自动设置 multipart boundary
    } else {
      // 方式2: JSON { url } 或 { file_id }
      const body = await request.json().catch(() => ({}));
      if (!body.url && !body.file_id) {
        return jsonResponse({ success: false, error: '请提供 multipart file，或 JSON { url } / { file_id }' }, 400);
      }
      const payload = { model: 'moss-transcribe', response_format: 'json' };
      if (body.url) payload.url = body.url;
      if (body.file_id) payload.file_id = body.file_id;
      upstreamBody = JSON.stringify(payload);
      upstreamContentType = 'application/json';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);

    const headers = { 'Authorization': 'Bearer ' + getApiKey(env) };
    if (upstreamContentType) headers['Content-Type'] = upstreamContentType;

    const resp = await fetch(`${MOSS_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: upstreamBody,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return jsonResponse({ success: false, error: `MOSS STT 上游返回 ${resp.status}`, detail: errText.slice(0, 500) }, 502);
    }

    const data = await resp.json().catch(() => ({}));
    if (!data || typeof data.text !== 'string') {
      return jsonResponse({ success: false, error: 'MOSS STT 返回数据格式异常', detail: JSON.stringify(data).slice(0, 500) }, 502);
    }
    return jsonResponse({ success: true, text: data.text, ...data });
  } catch (err) {
    if (err.name === 'AbortError') {
      return jsonResponse({ success: false, error: 'MOSS STT 响应超时（25秒）' }, 504);
    }
    return jsonResponse({ success: false, error: 'MOSS STT 请求失败: ' + (err.message || '未知错误') }, 502);
  }
}
