// Cloudflare Pages Function - Developer 隔离 / 解隔离（惩罚性隐身）
// POST /api/developer/quarantine
//   { action: 'quarantine',   user_id, reason } - 隔离：撤销全部会话 + 释放设备绑定 + 打标
//   { action: 'unquarantine', user_id }          - 解隔离：清除标记（会话需重新登录）
// 全部要求 step-up；写审计（quarantine / unquarantine）+ 风控事件；不允许隔离当前登录账号
import { requireDeveloper, devJson, devErr } from '../_lib/devauth.js';
import { writeAdminAudit } from '../_lib/audit.js';
import { logRiskEvent, getClientIp, cfMeta } from '../_lib/device.js';

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return devErr('数据库未绑定', 500);
  try {
    const gate = await requireDeveloper(env, request, { stepup: true });
    if (!gate.ok) return gate.response;

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '');
    const targetId = String(body.user_id || '').trim().slice(0, 64);
    const reason = String(body.reason || '').trim().slice(0, 200);

    if (!targetId) return devErr('缺少目标账号', 400);
    if (targetId === gate.userId) return devErr('不能对当前登录账号执行此操作', 400);

    const target = await env.DB.prepare(
      `SELECT id, name, is_developer, quarantined_at, deactivated_at FROM users WHERE id = ?`
    ).bind(targetId).first();
    if (!target) return devErr('账号不存在', 404);

    const ip = getClientIp(request);
    const cmeta = cfMeta(request);
    const ua = request.headers.get('User-Agent') || '';

    if (action === 'quarantine') {
      if (target.quarantined_at) return devErr('该账号已处于隔离状态', 400);
      if (!reason) return devErr('请填写隔离原因', 400);

      // 原子：打标 + 撤销全部会话 + 释放设备绑定（一机一号解除，设备可重新归属）
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE users SET quarantined_at = datetime('now'), quarantine_reason = ?, quarantined_by = ?
           WHERE id = ? AND quarantined_at IS NULL`
        ).bind(reason, gate.userId, targetId),
        env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(targetId),
        env.DB.prepare(
          `UPDATE device_accounts SET status = 'released', released_at = datetime('now'),
           release_reason = 'quarantine'
           WHERE user_id = ? AND status = 'active'`
        ).bind(targetId),
      ]);

      await writeAdminAudit(env, {
        actorId: gate.userId, action: 'quarantine', target: targetId,
        detail: { reason, target_name: target.name },
      });
      await logRiskEvent(env, {
        event_type: 'quarantine', user_id: targetId, ip, ...cmeta, ua,
        action: 'quarantined', risk_score: 80, detail: { reason, by: gate.userId },
      });
      return devJson({ success: true, data: { user_id: targetId, quarantined: true } });
    }

    if (action === 'unquarantine') {
      if (!target.quarantined_at) return devErr('该账号未处于隔离状态', 400);

      await env.DB.prepare(
        `UPDATE users SET quarantined_at = NULL, quarantine_reason = NULL, quarantined_by = NULL
         WHERE id = ? AND quarantined_at IS NOT NULL`
      ).bind(targetId).run();

      await writeAdminAudit(env, {
        actorId: gate.userId, action: 'unquarantine', target: targetId,
        detail: { target_name: target.name },
      });
      await logRiskEvent(env, {
        event_type: 'quarantine_lift', user_id: targetId, ip, ...cmeta, ua,
        action: 'allowed', risk_score: 0, detail: { by: gate.userId },
      });
      return devJson({ success: true, data: { user_id: targetId, quarantined: false } });
    }

    return devErr('未知操作', 400);
  } catch (e) {
    console.error('[DEV-QUARANTINE] error:', e.message);
    return devErr('服务器错误', 500);
  }
}
