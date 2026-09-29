// V8.0 受控重绑 - POST /api/device/rebind
// 场景：正常用户清除浏览器数据 / 换浏览器 / 换设备后的恢复流程
// 规则：
// - 需要有效登录（Bearer 会话）
// - 当前设备被封禁 → 403；账号处于隔离/停用 → 401（不透露状态）
// - 设备已绑定其他账号 → 409，必须由服务端（开发者后台）解除，客户端无权抢绑
// - 限流：同账号 24 小时最多 5 次成功重绑（防自动化轮换设备）
// - 每次重绑写入 risk_events 审计

import { getAuthUserId } from '../_lib/jwt.js';
import {
  resolveAuthDevice,
  bindDeviceForUser,
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

  try {
    const userId = await getAuthUserId(env, request);
    if (!userId) {
      return Response.json({ success: false, error: '未登录' }, { status: 401 });
    }

    const user = await env.DB.prepare(
      `SELECT id, quarantined_at, deactivated_at FROM users WHERE id = ?`
    ).bind(userId).first();
    if (!user || user.quarantined_at || user.deactivated_at) {
      return Response.json({ success: false, error: 'forbidden' }, { status: 403 });
    }

    const ip = getClientIp(request);
    const meta = cfMeta(request);
    const ua = request.headers.get('User-Agent') || '';

    // 24 小时重绑限流
    const recent = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM risk_events
       WHERE event_type = 'device_rebind' AND user_id = ? AND action = 'allowed'
         AND created_at > datetime('now', '-24 hours')`
    ).bind(userId).first();
    if (recent && recent.c >= 5) {
      return Response.json({ success: false, error: '设备更换过于频繁，请 24 小时后再试' }, { status: 429 });
    }

    // 解析/签发当前设备标记
    const dev = await resolveAuthDevice(env, request, ip);
    if (dev.rateLimited) {
      return Response.json({ success: false, error: '设备签发过于频繁，请稍后再试' }, { status: 429 });
    }
    if (dev.banned) {
      await logRiskEvent(env, {
        event_type: 'device_rebind', device_id: dev.device && dev.device.id,
        user_id: userId, ip, ...meta, ua, action: 'blocked', risk_score: 50,
        detail: { reason: 'banned_device' },
      });
      return Response.json({ success: false, error: '设备已被限制' }, { status: 403 });
    }

    // 已绑定其他账号 → 拒绝抢绑（共享设备/误判走后台解除流程）
    if (dev.bindingUserId && dev.bindingUserId !== userId) {
      await logRiskEvent(env, {
        event_type: 'device_rebind', device_id: dev.device.id,
        user_id: userId, ip, ...meta, ua, action: 'blocked', risk_score: 40,
        detail: { reason: 'bound_to_other', bound_user: dev.bindingUserId },
      });
      return Response.json(
        { success: false, error: '该设备已关联其他账号，请联系管理员处理' },
        { status: 409 }
      );
    }

    // 绑定（已是绑定关系则幂等）
    const bind = await bindDeviceForUser(env, dev.device.id, userId, 'rebind');
    if (!bind.ok) {
      if (bind.reason === 'device_bound') {
        return Response.json(
          { success: false, error: '该设备已关联其他账号，请联系管理员处理' },
          { status: 409 }
        );
      }
      return Response.json({ success: false, error: '设备关联失败，请重试' }, { status: 500 });
    }

    await logRiskEvent(env, {
      event_type: 'device_rebind', device_id: dev.device.id,
      user_id: userId, ip, ...meta, ua, action: 'allowed', risk_score: dev.fresh ? 15 : 5,
      detail: { fresh: !!dev.fresh, rebound: !!bind.rebound },
    });

    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (dev.fresh && dev.raw) headers['Set-Cookie'] = deviceSetCookie(dev.raw);

    return new Response(
      JSON.stringify({ success: true, bound: true, fresh_device: !!dev.fresh }),
      { status: 200, headers }
    );
  } catch (e) {
    console.error('[DEVICE] rebind error:', e.message);
    return Response.json({ success: false, error: '设备关联失败，请重试' }, { status: 500 });
  }
}
