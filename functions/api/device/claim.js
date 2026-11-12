// V8.0 设备标记签发/续期 - POST /api/device/claim
// - 已有有效标记：更新 last_seen，幂等返回 { fresh: false }
// - 无标记/无效：服务端签发高熵标记并下发 __Host-dp_device Cookie
// - 签发限流：同 IP 每小时 5 个、每天 15 个，超出返回 429（防脚本清 Cookie 批量白嫖标记）
// - 领取行为写入 risk_events（fresh / 重领 都是风控信号，不阻塞正常用户）

import {
  resolveAuthDevice,
  observeDeviceSignals,
  logRiskEvent,
  getClientIp,
  cfMeta,
} from '../_lib/device.js';

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) {
    return Response.json({ success: false, error: '数据库未绑定' }, { status: 500 });
  }

  const ip = getClientIp(request);
  const meta = cfMeta(request);
  const ua = request.headers.get('User-Agent') || '';

  try {
    const hints = await request.json().catch(() => ({}));
    const dev = await resolveAuthDevice(env, request, ip, hints);
    if (dev.banned) {
      await logRiskEvent(env, {
        event_type: 'device_claim', device_id: dev.device && dev.device.id,
        ip, ...meta, ua, action: 'blocked', risk_score: 70,
        detail: { reason: 'banned_device', recovered: !!dev.recovered },
      });
      return Response.json({ success: false, error: '设备已被限制' }, { status: 403 });
    }
    if (dev.rateLimited || !dev.device) {
      await logRiskEvent(env, {
        event_type: 'device_claim', ip, ...meta, ua,
        action: 'blocked', risk_score: 30, detail: { reason: 'claim_rate_limited' },
      });
      return Response.json({ success: false, error: '设备签发过于频繁，请稍后再试' }, { status: 429 });
    }

    await observeDeviceSignals(env, dev.device.id, hints, request, ip);
    await logRiskEvent(env, {
      event_type: 'device_claim', device_id: dev.device.id,
      ip, ...meta, ua, action: 'allowed', risk_score: dev.recovered ? 25 : (dev.fresh ? 5 : 0),
      canvas_hash: hints.canvas_hash ? String(hints.canvas_hash).slice(0, 64) : null,
      detail: {
        fresh: !!dev.fresh && !dev.recovered,
        recovered: !!dev.recovered,
        match_score: dev.matchScore || 0,
        matched_signals: dev.matchedSignals || [],
      },
    });

    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (dev.header) headers['Set-Cookie'] = dev.header;
    return new Response(
      JSON.stringify({ success: true, fresh: !!dev.fresh && !dev.recovered, recovered: !!dev.recovered }),
      { status: 200, headers }
    );
  } catch (e) {
    console.error('[DEVICE] claim error:', e.message);
    return Response.json({ success: false, error: '设备签发失败，请重试' }, { status: 500 });
  }
}
