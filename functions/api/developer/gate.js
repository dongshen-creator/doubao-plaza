// Cloudflare Pages Function - Developer Step-up Gate
// GET  /api/developer/gate - 后台会话状态（是否开发者 / TOTP / step-up 是否仍有效）
// POST /api/developer/gate - step-up 近期认证：密码（+ 已启用 TOTP 时动态码）
//                            → 签发 10 分钟 X-Stepup-Token（所有高危后台操作必带）
import { getAuthUserId, generateToken } from '../_lib/jwt.js';
import { verifyPassword } from '../_lib/password.js';
import { totpVerify } from '../_lib/totp.js';
import { writeAdminAudit } from '../_lib/audit.js';
import { requireDeveloper, devJson, devErr, isDeveloperFlag } from '../_lib/devauth.js';
import { logRiskEvent, getClientIp, cfMeta } from '../_lib/device.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return devErr('数据库未绑定', 500);
  try {
    const userId = await getAuthUserId(env, request);
    if (!userId) return devJson({ success: true, data: { is_developer: false } });
    const user = await env.DB.prepare(
      `SELECT id, name, is_developer, totp_enabled, quarantined_at, deactivated_at FROM users WHERE id = ?`
    ).bind(userId).first();
    const isDev = !!(user && isDeveloperFlag(user.is_developer) && !user.quarantined_at && !user.deactivated_at);
    if (!isDev) return devJson({ success: true, data: { is_developer: false } });
    const su = await env.DB.prepare(
      `SELECT 1 AS ok FROM stepup_tokens WHERE user_id = ? AND expires_at > datetime('now') LIMIT 1`
    ).bind(userId).first();
    return devJson({
      success: true,
      data: {
        is_developer: true,
        name: user.name,
        totp_enabled: !!user.totp_enabled,
        stepup_valid: !!su,
      },
    });
  } catch (e) {
    console.error('[DEV-GATE] GET error:', e.message);
    return devErr('服务器错误', 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return devErr('数据库未绑定', 500);
  try {
    // 基础门槛：有效会话 + is_developer（step-up 就是本端点要发的东西）
    const gate = await requireDeveloper(env, request, { stepup: false });
    if (!gate.ok) return gate.response;

    const body = await request.json().catch(() => ({}));
    const { password, totp } = body;
    if (!password) return devErr('请输入密码', 400);

    // 限流：15 分钟内 step-up 失败 ≥5 次 → 429（撞密码/动态码的尝试留痕且被卡）
    const fails = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM admin_audit_log
       WHERE actor_id = ? AND action = 'stepup_fail' AND created_at > datetime('now', '-15 minutes')`
    ).bind(gate.userId).first();
    if (fails && fails.c >= 5) {
      return devErr('验证过于频繁，请 15 分钟后再试', 429);
    }

    const user = await env.DB.prepare(
      `SELECT id, name, password, totp_enabled, totp_secret FROM users WHERE id = ?`
    ).bind(gate.userId).first();
    if (!user) return devErr('账号异常', 403);

    const ip = getClientIp(request);
    const cmeta = cfMeta(request);
    const ua = request.headers.get('User-Agent') || '';

    const passOk = await verifyPassword(password, user.password);
    if (!passOk) {
      await writeAdminAudit(env, { actorId: gate.userId, action: 'stepup_fail', detail: { reason: 'bad_password' } });
      await logRiskEvent(env, {
        event_type: 'stepup', user_id: gate.userId, ip, ...cmeta, ua,
        action: 'blocked', risk_score: 40, detail: { reason: 'bad_password' },
      });
      return devErr('密码错误', 401);
    }

    if (user.totp_enabled) {
      if (!totp) return devErr('请输入动态验证码', 401, { need_totp: true });
      const okTotp = await totpVerify(user.totp_secret, totp);
      if (!okTotp) {
        await writeAdminAudit(env, { actorId: gate.userId, action: 'stepup_fail', detail: { reason: 'bad_totp' } });
        await logRiskEvent(env, {
          event_type: 'stepup', user_id: gate.userId, ip, ...cmeta, ua,
          action: 'blocked', risk_score: 45, detail: { reason: 'bad_totp' },
        });
        return devErr('动态验证码错误', 401, { need_totp: true });
      }
    }

    // 签发 step-up token：
    // - expires_at 用 SQLite datetime 格式（与 datetime('now') 同格式比较；
    //   ISO 字符串的 'T' 在同日比较会错位，导致 10 分钟窗口失效）
    // - 先清本用户旧 token（换发即吊销）+ 顺手清理全局过期 token
    await env.DB.prepare(`DELETE FROM stepup_tokens WHERE expires_at < datetime('now')`).run();
    await env.DB.prepare(`DELETE FROM stepup_tokens WHERE user_id = ?`).bind(gate.userId).run();
    const token = generateToken();
    await env.DB.prepare(
      `INSERT INTO stepup_tokens (token, user_id, purpose, expires_at)
       VALUES (?, ?, 'devops', strftime('%Y-%m-%d %H:%M:%S', 'now', '+10 minutes'))`
    ).bind(token, gate.userId).run();

    await writeAdminAudit(env, { actorId: gate.userId, action: 'stepup', detail: { totp: !!user.totp_enabled } });
    await logRiskEvent(env, {
      event_type: 'stepup', user_id: gate.userId, ip, ...cmeta, ua,
      action: 'allowed', risk_score: 0, detail: { totp: !!user.totp_enabled },
    });

    return devJson({ success: true, data: { stepup_token: token, expires_in: 600 } });
  } catch (e) {
    console.error('[DEV-GATE] POST error:', e.message);
    return devErr('服务器错误', 500);
  }
}
