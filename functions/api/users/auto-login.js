// Cloudflare Pages Function - Auto Login
// POST /api/users/auto-login

async function checkAndUpdatePunishment(env, userId) {
  if (!env.DB) throw new Error('数据库未绑定');
  const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId).first();
  if (!user) return null;
  if (user.privacy_setting === 'punished_whitelist' && user.punished_until) {
    const now = new Date().toISOString();
    if (user.punished_until < now) {
      await env.DB.prepare(
        `UPDATE users SET privacy_setting = 'searchable', punished_until = NULL, punish_reason = NULL WHERE id = ?`
      ).bind(userId).run();
      user.privacy_setting = 'searchable';
    }
  }
  return user;
}

export async function onRequestPost(context) {
  // 首先检查环境变量
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定，请在Cloudflare Pages设置中绑定D1数据库' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { env } = context;
    const body = await context.request.json().catch(() => ({}));
    const { token } = body;

    if (!token) {
      return Response.json({ success: false, error: '无会话token' });
    }

    const session = await env.DB.prepare(
      `SELECT s.user_id, s.token, s.expires_at, u.* FROM sessions s JOIN users u ON s.user_id = u.id 
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    ).bind(token).first();

    if (!session) {
      return Response.json({ success: false, error: '会话已过期' });
    }

    await env.DB.prepare(
      `UPDATE users SET last_login_at = datetime('now') WHERE id = ?`
    ).bind(session.user_id).run();

    const user = await checkAndUpdatePunishment(env, session.user_id);

    if (!user) {
      return Response.json({ success: false, error: '用户不存在' });
    }

    // 安全地移除 password 字段
    const safeUser = {
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      bio: user.bio,
      doubao_id: user.doubao_id,
      agent_url: user.agent_url,
      privacy_setting: user.privacy_setting,
      invite_code: user.invite_code,
      created_at: user.created_at,
      updated_at: user.updated_at,
      last_login_at: user.last_login_at
    };

    return Response.json({ success: true, data: safeUser, token });
  } catch (e) {
    return Response.json({ success: false, error: '服务器错误：' + e.message });
  }
}
