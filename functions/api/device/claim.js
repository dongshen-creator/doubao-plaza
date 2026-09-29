// V8.0 设备标记签发/续期 - POST /api/device/claim
// - 已有有效标记：更新 last_seen，幂等返回 { fresh: false }
// - 无标记/无效：服务端签发高熵标记并下发 __Host-dp_device Cookie
// - 签发限流：同 IP 每小时 5 个、每天 15 个，超出返回 429（防脚本清 Cookie 批量白嫖标记）
// - 领取行为写入 risk_events（fresh / 重领 都是风控信号，不阻塞正常用户）

import {
  getDeviceByCookie,
  issueDevice,
  deviceSetCookie,
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
    const { raw, device } = await getDeviceByCookie(env, request);

    if (device) {
      if (device.status === 'banned') {
        return Response.json({ success: false, error: '设备已被限制' }, { status: 403 });
      }
      env.DB.prepare(`UPDATE devices SET last_seen_at = datetime('now') WHERE id = ?`)
        .bind(device.id).run().catch(() => {});
      return Response.json({ success: true, fresh: false });
    }

    const issued = await issueDevice(env, { ip });
    if (!issued.ok) {
      if (issued.error === 'rate_limited') {
        await logRiskEvent(env, {
          event_type: 'device_claim',
          ip, ...meta, ua, action: 'blocked', risk_score: 30,
          detail: { reason: 'claim_rate_limited' },
        });
        return Response.json({ success: false, error: '设备签发过于频繁，请稍后再试' }, { status: 429 });
      }
      return Response.json({ success: false, error: '设备签发失败，请重试' }, { status: 500 });
    }

    await logRiskEvent(env, {
      event_type: 'device_claim',
      device_id: issued.id,
      ip, ...meta, ua, action: 'allowed', risk_score: 5,
      detail: { fresh: true },
    });

    return new Response(
      JSON.stringify({ success: true, fresh: true }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Set-Cookie': deviceSetCookie(issued.raw),
        },
      }
    );
  } catch (e) {
    console.error('[DEVICE] claim error:', e.message);
    return Response.json({ success: false, error: '设备签发失败，请重试' }, { status: 500 });
  }
}
