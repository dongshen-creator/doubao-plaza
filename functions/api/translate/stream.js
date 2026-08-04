// Cloudflare Pages Function - 流式翻译代理（uapis.cn SSE，中英互译，打字机效果）
// POST /api/translate/stream - 服务端透传 SSE 流（解决前端 CORS；密钥仅存后端）
// 文档: https://uapis.cn/docs/api-reference/post-translate-stream
// 注意: uapis 流式仅支持 中文↔英文；其余语言互译请用 POST /api/translate（niutrans，支持 455+ 语种）
// 参数: { text, from_lang?, to_lang }
//   from_lang: 'Chinese' | 'English' | 'auto'（默认 auto）
//   to_lang: 'Chinese' | 'English'（必填）
// 返回: SSE 流（text/event-stream），事件格式见 uapis 文档：
//   event: start -> data: ok
//   event: message -> data: {"content":"...增量翻译..."}
//   event: audio -> data: {"speak_url":"..."}
//   event: end -> data: ok

const UAPI_KEY = 'uapi-kpr0iybzWiUTw19yZkbtcevG8aq47DPCvpVUEwTe';
const UAPI_STREAM_URL = 'https://uapis.cn/api/v1/translate/stream';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
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
  const { text, from_lang = 'auto', to_lang } = body;

  if (!text || typeof text !== 'string') {
    return jsonResponse({ success: false, error: '缺少 text 参数' }, 400);
  }
  if (!to_lang) {
    return jsonResponse({ success: false, error: '缺少 to_lang 参数（Chinese / English）' }, 400);
  }
  if (to_lang !== 'Chinese' && to_lang !== 'English') {
    return jsonResponse({ success: false, error: '流式翻译仅支持中文↔英文，to_lang 只能是 Chinese 或 English；其他语言请用 POST /api/translate' }, 400);
  }
  if (from_lang && !['Chinese', 'English', 'auto'].includes(from_lang)) {
    return jsonResponse({ success: false, error: 'from_lang 只能是 Chinese / English / auto' }, 400);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (env?.UAPI_API_KEY || UAPI_KEY),
    };

    const upstream = await fetch(UAPI_STREAM_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: text, from_lang, to_lang }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      return jsonResponse({ success: false, error: `uapis 返回 ${upstream.status}`, detail: errText.slice(0, 500) }, 502);
    }

    // 透传 SSE 流
    const respHeaders = new Headers();
    respHeaders.set('Content-Type', 'text/event-stream');
    respHeaders.set('Access-Control-Allow-Origin', '*');
    respHeaders.set('Cache-Control', 'no-cache');
    respHeaders.set('Connection', 'keep-alive');
    respHeaders.set('X-Accel-Buffering', 'no');

    return new Response(upstream.body, { status: 200, headers: respHeaders });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return jsonResponse({ success: false, error: 'uapis 流式响应超时（25秒未收到响应头）' }, 504);
    }
    return jsonResponse({ success: false, error: '流式翻译请求失败: ' + (err.message || '未知错误') }, 502);
  }
}