// 图片代理：浏览器端外部图片统一走本站域名（/api/img-proxy?url=...），
// 规避浏览器 Private Network Access (PNA) / CORS 对外部图片的拦截。
// 部署在 Cloudflare Pages Functions，fetch 从 Cloudflare 网络发起，不受客户端 DNS/代理影响。

const MAX_BYTES = 10 * 1024 * 1024; // 最大转发 10MB

function isPrivateHost(host) {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
  // IPv4 私网/保留段
  if (/^0\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^127\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d)\./.test(host)) return true; // CGNAT
  if (/^::ffff:(10\.|127\.|192\.168\.|169\.254\.)/i.test(host)) return true;
  return false;
}

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target) {
    return Response.json({ error: '缺少 url 参数。用法: /api/img-proxy?url=<编码后的图片地址>' }, { status: 400 });
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return Response.json({ error: '无效的 url' }, { status: 400 });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return Response.json({ error: '仅支持 http/https 协议' }, { status: 400 });
  }
  if (isPrivateHost(parsed.hostname)) {
    return Response.json({ error: '禁止访问内网地址' }, { status: 403 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(target, {
      method: 'GET',
      // 不带 Referer（绕过部分图床防盗链）；带常见 UA
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!resp.ok) {
      return new Response('上游返回 ' + resp.status, { status: 502 });
    }
    const ctype = resp.headers.get('Content-Type') || '';
    // 只转发图片内容（部分图床用 octet-stream，一并放行；img 解码失败会自行触发 onerror 回退）
    if (!ctype.startsWith('image/') && ctype !== 'application/octet-stream') {
      return new Response('非图片内容', { status: 502 });
    }
    const len = parseInt(resp.headers.get('Content-Length') || '0', 10);
    if (len > MAX_BYTES) {
      return new Response('图片过大', { status: 413 });
    }

    const headers = new Headers();
    headers.set('Content-Type', ctype);
    headers.set('Cache-Control', 'public, max-age=86400'); // CDN 缓存 1 天，减少重复转发
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(resp.body, { status: 200, headers });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return new Response('上游响应超时', { status: 504 });
    }
    return new Response('代理失败: ' + (err.message || '未知错误'), { status: 502 });
  }
}
