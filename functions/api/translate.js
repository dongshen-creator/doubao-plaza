// Cloudflare Pages Function - 翻译 API 代理
// POST /api/translate - 翻译文本（服务端代理，解决前端直接调用Google Translate的CORS问题）
// 参数: { text, source_lang, target_lang }
// 返回: { success, translated, detected_lang }

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
  try {
    const { request } = context;
    const body = await request.json().catch(() => ({}));
    const { text, source_lang = 'auto', target_lang = 'zh' } = body;

    if (!text || typeof text !== 'string') {
      return jsonResponse({ success: false, error: '缺少text参数' }, 400);
    }

    // 限制文本长度（防止滥用）
    if (text.length > 5000) {
      return jsonResponse({ success: false, error: '文本过长（最多5000字符）' }, 400);
    }

    const encodedText = encodeURIComponent(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source_lang}&tl=${target_lang}&dt=t&q=${encodedText}`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });

    if (!response.ok) {
      return jsonResponse({ success: false, error: `翻译API请求失败 (${response.status})` }, 502);
    }

    const data = await response.json();

    // 提取翻译结果
    let translated = '';
    if (data && Array.isArray(data[0])) {
      for (let i = 0; i < data[0].length; i++) {
        if (data[0][i] && data[0][i][0]) translated += data[0][i][0];
      }
    }

    const detectedLang = (data && data[2]) ? data[2] : source_lang;

    return jsonResponse({
      success: true,
      translated,
      detected_lang: detectedLang
    });
  } catch (e) {
    return jsonResponse({ success: false, error: '翻译失败: ' + (e.message || '未知错误') }, 500);
  }
}
