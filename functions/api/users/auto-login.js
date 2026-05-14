// Cloudflare Pages Function - Auto Login
// POST /api/users/auto-login

async function checkAndUpdatePunishment(env, userId) {
  const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId).first();
  if (!user) return null;
  if (user.privacy_setting === 'punished_whitelist' && user.punished_until) {
    if (user.punished_until < new Date().toISOString()) {
      await env.DB.prepare(
        `UPDATE users SET privacy_setting = 'searchable', punished_until = NULL, punish_reason = NULL WHERE id = ?`
      ).bind(userId).run();
      user.privacy_setting = 'searchable';
    }
  }
  return user;
}

export async function onRequestPost(context) {
  const { env } = context;
  const { token } = await context.request.json();

  if (!token) {
    return Response.json({ success: false, error: '无会话token' });
  }

  const session = await env.DB.prepare(
    `SELECT s.*, u.* FROM sessions s JOIN users u ON s.user_id = u.id 
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).bind(token).first();

  if (!session) {
    return Response.json({ success: false, error: '会话已过期' });
  }

  await env.DB.prepare(
    `UPDATE users SET last_login_at = datetime('now') WHERE id = ?`
  ).bind(session.user_id).run();

  const user = await checkAndUpdatePunishment(env, session.user_id);

  const { password, ...safeUser } = user;
  return Response.json({ success: true, data: safeUser, token });
}
