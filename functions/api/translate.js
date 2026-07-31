// Cloudflare Pages Function - 翻译 API 代理
// POST /api/translate - 翻译文本（服务端代理，解决前端CORS问题）
// 使用 MyMemory Translation API（免费、无需API Key、支持多语种）
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

// MyMemory 翻译 API（主用）
// 文档: https://mymemory.translated.net/doc/spec.php
// 格式: https://api.mymemory.translated.net/get?q=TEXT&langpair=SOURCE|TARGET
// source 支持自动检测时用 autodetect
async function translateWithMyMemory(text, sourceLang, targetLang) {
  const sl = sourceLang === 'auto' ? 'Autodetect' : sourceLang;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sl}|${targetLang}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!response.ok) {
    throw new Error(`MyMemory API 返回 ${response.status}`);
  }
  const data = await response.json();
  if (!data || !data.responseData) {
    throw new Error('MyMemory 返回数据格式异常');
  }
  if (data.responseStatus !== 200 && data.responseStatus !== '200') {
    // 有些情况 responseStatus 不是 200 但仍有翻译结果
    if (!data.responseData.translatedText) {
      throw new Error(data.responseDetails || 'MyMemory 翻译失败');
    }
  }
  const translated = data.responseData.translatedText || '';
  // MyMemory 不直接返回检测语言，尝试从 matches 中获取
  let detectedLang = sourceLang;
  if (sourceLang === 'auto' && data.matches && data.matches.length > 0) {
    // matches[0].source 可能包含检测到的源语言
    if (data.matches[0] && data.matches[0].source) {
      const srcMatch = String(data.matches[0].source).match(/([a-z]{2})-/i);
      if (srcMatch) detectedLang = srcMatch[1].toLowerCase();
    }
  }
  return { translated, detectedLang };
}

// Google Translate 备用（通过不同端点尝试）
async function translateWithGoogle(text, sourceLang, targetLang) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!response.ok) {
    throw new Error(`Google Translate API 返回 ${response.status}`);
  }
  const data = await response.json();
  let translated = '';
  if (data && Array.isArray(data[0])) {
    for (let i = 0; i < data[0].length; i++) {
      if (data[0][i] && data[0][i][0]) translated += data[0][i][0];
    }
  }
  const detectedLang = (data && data[2]) ? data[2] : sourceLang;
  return { translated, detectedLang };
}

export async function onRequestPost(context) {
  try {
    const { request } = context;
    const body = await request.json().catch(() => ({}));
    const { text, source_lang = 'auto', target_lang = 'zh' } = body;

    if (!text || typeof text !== 'string') {
      return jsonResponse({ success: false, error: '缺少text参数' }, 400);
    }

    // 限制文本长度
    if (text.length > 5000) {
      return jsonResponse({ success: false, error: '文本过长（最多5000字符）' }, 400);
    }

    let result = null;
    let lastError = '';

    // 优先使用 MyMemory API
    try {
      result = await translateWithMyMemory(text, source_lang, target_lang);
    } catch (e) {
      lastError = e.message;
      // 备用：Google Translate
      try {
        result = await translateWithGoogle(text, source_lang, target_lang);
      } catch (e2) {
        lastError = lastError + '; Google: ' + e2.message;
      }
    }

    if (!result || !result.translated) {
      return jsonResponse({ success: false, error: '翻译失败: ' + (lastError || '所有翻译API均不可用') }, 502);
    }

    return jsonResponse({
      success: true,
      translated: result.translated,
      detected_lang: result.detectedLang || source_lang
    });
  } catch (e) {
    return jsonResponse({ success: false, error: '翻译服务异常: ' + (e.message || '未知错误') }, 500);
  }
}
