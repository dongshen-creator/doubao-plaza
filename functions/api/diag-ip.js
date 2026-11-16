// 临时诊断端点（V12.3 排查用，验证完即删除）
// 仅回显本次请求的来源头、解析出的 IP、以及 DP_PROXY_TOKEN 是否绑定
import { resolveClientIp } from './_lib/clientip.js';

export async function onRequest(context) {
  const { request, env } = context;
  const h = (k) => request.headers.get(k) || '';
  const token = typeof env.DP_PROXY_TOKEN === 'string' ? env.DP_PROXY_TOKEN : '';
  return Response.json({
    ok: true,
    edge: h('CF-Connecting-IP'),
    forwarded: h('X-DP-Real-IP'),
    proxyTokenHeaderLen: h('X-DP-Proxy-Token').length,
    proxyTokenEnvLen: token.length,
    proxyTokenEnvTrimLen: token.trim().length,
    tokenMatch:
      token.trim() !== '' && token.trim() === h('X-DP-Proxy-Token').trim(),
    resolvedFirst: resolveClientIp(request, env),
    resolvedSecond: resolveClientIp(request),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
