// Cloudflare Pages Function - Get user profile + Delete User Account
// GET /api/users/[id] - 获取用户信息（用于弹窗等）
// DELETE /api/users/[id]

// 统一鉴权：从 Authorization 头取 token，校验会话有效性，返回 user_id 或 null
async function getAuthUserId(env, request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const session = await env.DB.prepare(
    `SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
  return session ? session.user_id : null;
}

export async function onRequestGet(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  try {
    const { env } = context;
    const userId = context.params.id;
    if (!userId) return Response.json({ success: false, error: '用户ID不能为空' });
    const user = await env.DB.prepare(
      "SELECT id, name, avatar, doubao_id, bio, agent_url, privacy_setting, pat_suffix, last_login_at, created_at FROM users WHERE id = ?"
    ).bind(userId).first();
    if (!user) return Response.json({ success: false, error: '用户不存在' });
    return Response.json({ success: true, data: user });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}

export async function onRequestDelete(context) {
  // 首先检查环境变量
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定，请在Cloudflare Pages设置中绑定D1数据库' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { env } = context;
    const userId = context.params.id;

    if (!userId) {
      return Response.json({ success: false, error: '用户ID不能为空' });
    }

    // 鉴权：仅本人可注销自己的账号
    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId || authUserId !== userId) {
      return Response.json({ success: false, error: '无权操作，只能注销自己的账号' }, { status: 403 });
    }

    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
    await env.DB.prepare(`DELETE FROM friendships WHERE user_id = ? OR friend_id = ?`).bind(userId, userId).run();
    await env.DB.prepare(`DELETE FROM blocked_users WHERE user_id = ? OR blocked_user_id = ?`).bind(userId, userId).run();
    await env.DB.prepare(`DELETE FROM reports WHERE reporter_id = ? OR reported_id = ?`).bind(userId, userId).run();
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();

    return Response.json({ success: true, message: '账号已永久删除' });
  } catch (e) {
    return Response.json({ success: false, error: '注销失败：' + e.message });
  }
}
