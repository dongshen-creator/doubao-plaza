// 临时诊断端点（V12.3 排查用，验证完即删除）
// 仅回显本次请求的来源头、解析出的 IP、以及跨模块取 IP 是否一致
import { resolveClientIp } from './_lib/clientip.js';
import { getClientIp } from './_lib/device.js';

export async function onRequest(context) {
  const { request, env } = context;
  const h = (k) => request.headers.get(k) || '';
  const token = typeof env.DP_PROXY_TOKEN === 'string' ? env.DP_PROXY_TOKEN : '';
  const forwarded = h('X-DP-Real-IP');
  let counts = null;
  try {
    counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM devices WHERE created_ip = ? AND created_at > datetime('now','-1 hour')) AS hour_total,
         (SELECT COUNT(*) FROM devices WHERE created_ip = ? AND created_at > datetime('now','-24 hours')) AS day_total,
         (SELECT COUNT(*) FROM devices WHERE created_ip = ?) AS all_total`
    ).bind(forwarded, forwarded, forwarded).first();
  } catch (e) { counts = { error: e.message }; }
  return Response.json({
    ok: true,
    edge: h('CF-Connecting-IP'),
    forwarded,
    tokenMatch: token.trim() !== '' && token.trim() === h('X-DP-Proxy-Token').trim(),
    resolvedWithEnv: resolveClientIp(request, env),
    resolvedHelper: getClientIp(request),
    countsForForwardedIp: counts,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
