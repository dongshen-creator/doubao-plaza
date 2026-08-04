// Cloudflare Pages Function - 翻译 API 代理（v5 重写：小牛翻译 NiuTrans 主用 + MyMemory/Google 兜底）
// POST /api/translate - 翻译文本（服务端代理，解决前端CORS问题；密钥仅存后端）
// 主引擎: 小牛翻译 v2 文本接口 https://api.niutrans.com/v2/text/translate
//   - 支持 455+ 语种任意互译（from=auto 自动识别），文档: transapi_text_v2
//   - 鉴权: authStr = MD5(参数按 ASCII 排序拼接，含 apikey)（对 UTF-8 字节计算）
// 兜底: MyMemory / Google Translate（免费接口，健壮性）
// 参数: { text, source_lang, target_lang }
// 返回: { success, translated, detected_lang }

// ===== 后端密钥（仅此文件持有，前端不暴露；优先读环境变量）=====
const NIUTRANS_API_KEY = '2d6d4868aa915324dbbe1b6622fac2e6';
const NIUTRANS_APP_ID = 'npT1785804378460';

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

// ===== MD5（Myers 核心，字节输入，UTF-8 安全）=====
// 计算字符串（UTF-8 编码后）的 MD5 hex。Cloudflare Workers 的 WebCrypto 不支持 MD5，
// 因此内联经典实现（Joseph Myers / pajhome.org.uk），并用 TextEncoder 保证 UTF-8 正确性。
function md5Utf8(str) {
  return md5Bytes(new TextEncoder().encode(str));
}

function md5Bytes(bytes) {
  const ADD = (a, b) => (a + b) & 0xffffffff;

  function cycle(x, k) {
    let a = x[0], b = x[1], c = x[2], d = x[3];

    const cmn = (q, aa, bb, xx, s, t) => {
      aa = ADD(ADD(aa, q), ADD(xx, t));
      return ADD((aa << s) | (aa >>> (32 - s)), bb);
    };
    const ff = (a, b, c, d, x, s, t) => cmn((b & c) | (~b & d), a, b, x, s, t);
    const gg = (a, b, c, d, x, s, t) => cmn((b & d) | (c & ~d), a, b, x, s, t);
    const hh = (a, b, c, d, x, s, t) => cmn(b ^ c ^ d, a, b, x, s, t);
    const ii = (a, b, c, d, x, s, t) => cmn(c ^ (b | ~d), a, b, x, s, t);

    a = ff(a, b, c, d, k[0], 7, -680876936);  d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);  b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);  d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);  d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);

    a = gg(a, b, c, d, k[1], 5, -165796510);   d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);  b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);   d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);  b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);  b = gg(b, c, d, a, k[12], 20, -1926607734);

    a = hh(a, b, c, d, k[5], 4, -378558);       d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);   d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);   b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);   b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);   b = hh(b, c, d, a, k[2], 23, -995338651);

    a = ii(a, b, c, d, k[0], 6, -198630844);    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);   d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);  b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);    b = ii(b, c, d, a, k[9], 21, -343485551);

    x[0] = ADD(a, x[0]); x[1] = ADD(b, x[1]); x[2] = ADD(c, x[2]); x[3] = ADD(d, x[3]);
  }

  const n = bytes.length;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let i = 64;
  for (i = 64; i <= n; i += 64) {
    const blk = new Array(16);
    for (let j = 0; j < 16; j++) {
      const o = i - 64 + j * 4;
      blk[j] = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
    }
    cycle(state, blk);
  }
  const rem = n - (i - 64);
  const tail = new Array(16).fill(0);
  for (let j = 0; j < rem; j++) {
    tail[j >> 2] |= bytes[i - 64 + j] << ((j % 4) << 3);
  }
  tail[rem >> 2] |= 0x80 << ((rem % 4) << 3);
  if (rem > 55) {
    cycle(state, tail);
    for (let j = 0; j < 16; j++) tail[j] = 0;
  }
  // 低 32 位比特长度（bytes.length * 8；文本 < 512MB 时安全）
  tail[14] = n * 8;
  cycle(state, tail);

  const hexChr = '0123456789abcdef';
  let out = '';
  for (let j = 0; j < 4; j++) {
    const w = state[j];
    for (let k = 0; k < 4; k++) {
      const b = (w >>> (k * 8)) & 0xff;
      out += hexChr[(b >> 4) & 0x0f] + hexChr[b & 0x0f];
    }
  }
  return out;
}

// ===== NiuTrans v2（主引擎，任意语言互译）=====
// 权限字符串: 将 apikey 及发送参数按参数名 ASCII 升序排列，键值对拼接后用 MD5 加密
async function translateWithNiuTrans(text, sourceLang, targetLang, env) {
  const apikey = env?.NIUTRANS_API_KEY || NIUTRANS_API_KEY;
  const appId = env?.NIUTRANS_APP_ID || NIUTRANS_APP_ID;
  const from = sourceLang === 'auto' ? 'auto' : sourceLang;
  const to = targetLang === 'auto' ? 'zh' : targetLang;
  // 秒级时间戳（与线上可用的 KiraTrans 实现一致）
  const timestamp = String(Math.floor(Date.now() / 1000));

  const authParams = { apikey, appId, from, srcText: text, timestamp, to };
  const authKeys = Object.keys(authParams).sort();
  const paramStr = authKeys.map(k => k + '=' + authParams[k]).join('&');
  const authStr = md5Utf8(paramStr);

  const payload = { from, to, srcText: text, appId, timestamp, authStr };
  const response = await fetch('https://api.niutrans.com/v2/text/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(payload).toString(),
  });
  if (!response.ok) {
    throw new Error(`NiuTrans API 返回 ${response.status}`);
  }
  const data = await response.json();
  if (data.errorCode && data.errorCode !== '0' && data.errorCode !== 0) {
    throw new Error(`NiuTrans: ${data.errorMsg || data.errorCode}`);
  }
  const translated = data.tgtText || '';
  if (!translated) {
    throw new Error('NiuTrans 返回空结果');
  }
  return { translated, detectedLang: data.from || from, engine: 'niutrans' };
}

// MyMemory 翻译 API（兜底）
async function translateWithMyMemory(text, sourceLang, targetLang) {
  const sl = sourceLang === 'auto' ? 'Autodetect' : sourceLang;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sl}|${targetLang}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!response.ok) throw new Error(`MyMemory API 返回 ${response.status}`);
  const data = await response.json();
  const translated = data?.responseData?.translatedText || '';
  if (!translated) throw new Error(data?.responseDetails || 'MyMemory 翻译失败');
  let detectedLang = sourceLang;
  if (sourceLang === 'auto' && data.matches && data.matches.length) {
    const srcMatch = String(data.matches[0]?.source || '').match(/([a-z]{2})-/i);
    if (srcMatch) detectedLang = srcMatch[1].toLowerCase();
  }
  return { translated, detectedLang, engine: 'mymemory' };
}

// Google Translate 兜底
async function translateWithGoogle(text, sourceLang, targetLang) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!response.ok) throw new Error(`Google Translate API 返回 ${response.status}`);
  const data = await response.json();
  let translated = '';
  if (data && Array.isArray(data[0])) {
    for (const seg of data[0]) {
      if (seg && seg[0]) translated += seg[0];
    }
  }
  if (!translated) throw new Error('Google 翻译返回空');
  return { translated, detectedLang: data && data[2] ? data[2] : sourceLang, engine: 'google' };
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const body = await request.json().catch(() => ({}));
    const { text, source_lang = 'auto', target_lang = 'zh' } = body;

    if (!text || typeof text !== 'string') {
      return jsonResponse({ success: false, error: '缺少text参数' }, 400);
    }
    if (text.length > 5000) {
      return jsonResponse({ success: false, error: '文本过长（最多5000字符）' }, 400);
    }

    let result = null;
    let lastError = '';

    // 主用: NiuTrans（任意语言互译）
    try {
      result = await translateWithNiuTrans(text, source_lang, target_lang, env);
    } catch (e) {
      lastError = e.message;
      try {
        result = await translateWithMyMemory(text, source_lang, target_lang);
      } catch (e2) {
        lastError = lastError + '; MyMemory: ' + e2.message;
        try {
          result = await translateWithGoogle(text, source_lang, target_lang);
        } catch (e3) {
          lastError = lastError + '; Google: ' + e3.message;
        }
      }
    }

    if (!result || !result.translated) {
      return jsonResponse({ success: false, error: '翻译失败: ' + (lastError || '所有翻译API均不可用') }, 502);
    }

    return jsonResponse({
      success: true,
      translated: result.translated,
      detected_lang: result.detectedLang || source_lang,
      engine: result.engine || 'niutrans',
    });
  } catch (e) {
    return jsonResponse({ success: false, error: '翻译服务异常: ' + (e.message || '未知错误') }, 500);
  }
}