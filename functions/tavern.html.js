// tavern.html — Pages Function 专属路由
// 背景：Cloudflare Pages 的 _headers 对同一 header 在多个匹配规则中采用「值逗号拼接」的合并语义，
// 多 CSP 策略会被浏览器同时强制执行 = 取交集 = 最严格策略仍生效，因此无法通过 _headers 单独放宽某个文件。
// 且 _headers 不适用于 Pages Function 的响应。故用本函数服务 /tavern.html：
// 取回静态资源后直接在响应头覆写一套独立的、宽松的 CSP，恢复嵌入模式（?embed=1）下
// 外部直连 AI API（SiliconFlow / OpenRouter 直连、CORS 代理 /api/proxy 等）的可用性。
// 站内 AI（/api/tools/ai）为同源请求，本策略亦覆盖。

// Tavern 专属宽松 CSP（相较全局严格策略，主要放宽 connect-src 至 https: wss:）
function tavernCSP() {
  return [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com 'unsafe-inline'",
    "script-src-elem 'self' https://challenges.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "style-src-elem 'self' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
    "connect-src 'self' https: wss:",
    "frame-src 'self' https://challenges.cloudflare.com",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests"
  ].join('; ');
}

// 仅处理 GET；其余交回静态处理
export async function onRequestGet(context) {
  const { env, request } = context;

  // 取回静态资源（不会再次进入本函数）
  const asset = await env.ASSETS.fetch(request);
  if (!asset || !asset.ok) {
    return new Response('Not Found', { status: 404 });
  }

  // 创建新的 Response，复制原 asset 的 body 与全部响应头，再覆写安全头
  const response = new Response(asset.body, asset);

  // 覆写安全头（_headers 不适用于 Function 响应，需在此完整给出）
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  response.headers.set('Content-Security-Policy', tavernCSP());

  return response;
}