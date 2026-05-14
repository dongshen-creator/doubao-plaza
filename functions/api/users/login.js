// Cloudflare Pages Function - Login
// POST /api/users/login

function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

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
  const { identifier, password } = await context.request.json();

  if (!identifier || !password) {
    return Response.json({ success: false, error: '请输入账号和密码' });
  }

  const user = await env.DB.prepare(
    `SELECT * FROM users WHERE (doubao_id = ? OR agent_url = ?) AND password = ?`
  ).bind(identifier, identifier, password).first();

  if (!user) {
    return Response.json({ success: false, error: '账号或密码错误' });
  }

  await checkAndUpdatePunishment(env, user.id);

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(
    `INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)`
  ).bind(user.id, token, expiresAt).run();

  await env.DB.prepare(
    `UPDATE users SET last_login_at = datetime('now') WHERE id = ?`
  ).bind(user.id).run();

  const { password: _, ...safeUser } = user;
  return Response.json({ success: true, data: safeUser, token });
}
