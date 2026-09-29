// V8.0 开发者后台审计日志（admin_audit_log）
// 记录：step-up 验证、MFA 启停、隔离/解隔离、设备解绑、清理预演/执行、用户查询等
// detail 必须脱敏：不含密码、完整令牌、TOTP 密钥

export async function writeAdminAudit(env, { actorId, action, target, detail }) {
  try {
    await env.DB.prepare(
      `INSERT INTO admin_audit_log (actor_id, action, target, detail) VALUES (?, ?, ?, ?)`
    ).bind(
      actorId || 'system',
      action || 'unknown',
      target ? String(target).slice(0, 200) : null,
      detail ? JSON.stringify(detail).slice(0, 2000) : null
    ).run();
  } catch (e) {
    // 审计失败不阻塞业务，但必须留痕到日志
    console.warn('[AUDIT] write failed:', action, e.message);
  }
}
