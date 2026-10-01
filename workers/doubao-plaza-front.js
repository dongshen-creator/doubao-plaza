// Cloudflare Worker - doubao-plaza-front（v9.1 反向代理：cf.gallopingroad.top -> doubao-plaza.pages.dev）
// 背景：路由 `cf.gallopingroad.top/*` + DNS 灰云指向优选 IP，消除 Error 1000；
//       本 Worker 把 alias 流量原样转发到上游 Pages 项目，保持门禁/限流/蜜罐全部生效。
// 职责：
//   1) Origin 改写：仅当 Origin === 'https://cf.gallopingroad.top' 时改为上游域，
//      使 Pages 中间件 originOk（Origin 必须等于本请求 origin）判定成立；
//      其它 Origin 原样透传 → 上游判定失败 403，防止恶意源借代理洗白。
//   2) Location 回写：上游 3xx 的绝对 Location（pages.dev）改回 alias，避免跳走。
//   3) 其余请求头/响应头/响应体流式透传（含 SSE）；Set-Cookie 均无 Domain 属性，
//      host-only cookie 自然归属 alias，无需改写；Host 头删除由 fetch 按目标 URL 重设。
//   4) 上游异常 → 502（错误体例保持纯文本网关错误，不冒充 API JSON）。
const ALIAS_ORIGIN = 'https://cf.gallopingroad.top';
const UPSTREAM_ORIGIN = 'https://doubao-plaza.pages.dev';

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  try {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, UPSTREAM_ORIGIN);

    const headers = new Headers(request.headers);
    headers.delete('Host');
    // 真实客户端 IP 透传（V9.1）：子请求进入 pages.dev 边缘时 CF-Connecting-IP 会被
    // 边缘无条件改写为 Worker 出口 IP（显式 set 无效，已实测），故改写入自定义头
    // X-DP-Real-IP；先 delete 客户端注入的同名头再 set，保证覆盖。Functions 侧仅当
    // 边缘 CF-Connecting-IP 属 CF 官方网段时才信任该头（见 functions/api/_lib/clientip.js）。
    headers.delete('X-DP-Real-IP');
    const clientIp = request.headers.get('CF-Connecting-IP');
    if (clientIp) {
      headers.set('X-DP-Real-IP', clientIp);
    }
    const origin = headers.get('Origin');
    if (origin === ALIAS_ORIGIN) {
      headers.set('Origin', UPSTREAM_ORIGIN);
    }

    const init = {
      method: request.method,
      headers,
      redirect: 'manual',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }

    const resp = await fetch(target.toString(), init);

    const respHeaders = new Headers(resp.headers);
    const location = respHeaders.get('Location');
    if (location) {
      respHeaders.set('Location', location.replace(UPSTREAM_ORIGIN, ALIAS_ORIGIN));
    }

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
    });
  } catch (err) {
    return new Response('Bad Gateway: ' + (err && err.message ? err.message : 'upstream error'), {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
