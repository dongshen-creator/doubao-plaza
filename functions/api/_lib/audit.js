// V8.0 开发者后台审计日志（admin_audit_log）
// 记录：step-up 验证、MFA 启停、隔离/解隔离、设备解绑、清理预演/执行、用户查询等
// detail 必须脱敏：不含密码、完整令牌、TOTP 密钥
// v9.2：每次写入附带操作者 IP（resolveClientIp 反代/直连统一口径）与 User-Agent

import { resolveClientIp } from './clientip.js';

export async function writeAdminAudit(env, { actorId, action, target, detail, request }) {
  let ip = null;
  let ua = null;
  if (request) {
    try { ip = resolveClientIp(request) || null; } catch (e) { ip = null; }
    try { ua = (request.headers.get('User-Agent') || '').slice(0, 512) || null; } catch (e) { ua = null; }
  }
  try {
    await env.DB.prepare(
      `INSERT INTO admin_audit_log (actor_id, action, target, detail, ip, ua) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      actorId || 'system',
      action || 'unknown',
      target ? String(target).slice(0, 200) : null,
      detail ? JSON.stringify(detail).slice(0, 2000) : null,
      ip,
      ua
    ).run();
  } catch (e) {
    // 审计失败不阻塞业务，但必须留痕到日志
    console.warn('[AUDIT] write failed:', action, e.message);
  }
}
