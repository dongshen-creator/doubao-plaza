// Cloudflare Pages Function - Developer TOTP MFA 管理
// GET  /api/developer/mfa              - 当前启用状态（基础开发者门槛）
// POST /api/developer/mfa              - action: setup / enable / disable（全部要求 step-up）
//   setup  → 生成候选密钥存入 users.totp_secret（totp_enabled=0），返回 secret + otpauth 深链
//   enable → 用动态码激活（totp_enabled=1）
//   disable→ 用动态码关闭并清空密钥
// 密钥只在 setup 响应里返回一次给本人；审计日志绝不记录密钥本身
import { requireDeveloper, devJson, devErr } from '../_lib/devauth.js';
import { generateTotpSecret, otpauthUri, totpVerify } from '../_lib/totp.js';
import { writeAdminAudit } from '../_lib/audit.js';
import { logRiskEvent, getClientIp, cfMeta } from '../_lib/device.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return devErr('数据库未绑定', 500);
  try {
    const gate = await requireDeveloper(env, request, { stepup: false });
    if (!gate.ok) return gate.response;
    const u = await env.DB.prepare(
      `SELECT totp_secret, totp_enabled FROM users WHERE id = ?`
    ).bind(gate.userId).first();
    return devJson({
      success: true,
      data: {
        totp_enabled: !!(u && u.totp_enabled),
        has_pending_secret: !!(u && u.totp_secret && !u.totp_enabled),
      },
    });
  } catch (e) {
    return devErr('服务器错误', 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return devErr('数据库未绑定', 500);
  try {
    // 启停双因素都属高危 → 必须 step-up
    const gate = await requireDeveloper(env, request, { stepup: true });
    if (!gate.ok) return gate.response;

    const body = await request.json().catch(() => ({}));
    const { action, code } = body;

    const ip = getClientIp(request);
    const cmeta = cfMeta(request);
    const ua = request.headers.get('User-Agent') || '';
    const mfaRisk = (act, detail, score = 0) => logRiskEvent(env, {
      event_type: 'mfa', user_id: gate.userId, ip, ...cmeta, ua,
      action: act, risk_score: score, detail,
    });

    if (action === 'setup') {
      const cur = await env.DB.prepare(
        `SELECT totp_enabled FROM users WHERE id = ?`
      ).bind(gate.userId).first();
      if (cur && cur.totp_enabled) {
        return devErr('双因素认证已启用，如需更换请先关闭', 400);
      }
      const secret = generateTotpSecret();
      await env.DB.prepare(
        `UPDATE users SET totp_secret = ? WHERE id = ?`
      ).bind(secret, gate.userId).run();
      await writeAdminAudit(env, { actorId: gate.userId, action: 'mfa_setup', request });
      // otpauth 深链含密钥，只能返回给完成 step-up 的本人，不进审计
      return devJson({
        success: true,
        data: { secret, otpauth_uri: otpauthUri(secret, gate.user.name) },
      });
    }

    if (action === 'enable') {
      const u = await env.DB.prepare(
        `SELECT totp_secret, totp_enabled FROM users WHERE id = ?`
      ).bind(gate.userId).first();
      if (!u || !u.totp_secret) return devErr('请先生成密钥', 400);
      if (u.totp_enabled) return devErr('双因素认证已启用', 400);
      if (!code || !(await totpVerify(u.totp_secret, code))) {
        await writeAdminAudit(env, { actorId: gate.userId, action: 'mfa_enable_fail', request });
        await mfaRisk('blocked', { op: 'enable', reason: 'bad_code' }, 35);
        return devErr('验证码错误', 400);
      }
      await env.DB.prepare(`UPDATE users SET totp_enabled = 1 WHERE id = ?`).bind(gate.userId).run();
      await writeAdminAudit(env, { actorId: gate.userId, action: 'mfa_enable', request });
      await mfaRisk('allowed', { op: 'enable' });
      return devJson({ success: true });
    }

    if (action === 'disable') {
      const u = await env.DB.prepare(
        `SELECT totp_secret, totp_enabled FROM users WHERE id = ?`
      ).bind(gate.userId).first();
      if (!u || !u.totp_enabled) return devErr('双因素认证未启用', 400);
      if (!code || !(await totpVerify(u.totp_secret, code))) {
        await writeAdminAudit(env, { actorId: gate.userId, action: 'mfa_disable_fail', request });
        await mfaRisk('blocked', { op: 'disable', reason: 'bad_code' }, 35);
        return devErr('验证码错误', 400);
      }
      await env.DB.prepare(
        `UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?`
      ).bind(gate.userId).run();
      await writeAdminAudit(env, { actorId: gate.userId, action: 'mfa_disable', request });
      await mfaRisk('allowed', { op: 'disable' });
      return devJson({ success: true });
    }

    return devErr('未知操作', 400);
  } catch (e) {
    console.error('[DEV-MFA] error:', e.message);
    return devErr('服务器错误', 500);
  }
}
