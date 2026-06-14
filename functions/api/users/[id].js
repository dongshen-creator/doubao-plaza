// Cloudflare Pages Function - Get user profile + Delete User Account
// GET /api/users/[id] - 获取用户信息（用于弹窗等）
// DELETE /api/users/[id]

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
      "SELECT id, name, avatar, doubao_id, bio, agent_url, privacy_setting, is_developer, last_login_at, created_at FROM users WHERE id = ?"
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

    await env.DB.prepare(`DELETE FROM chat_room_members WHERE user_id = ?`).bind(userId).run();
    await env.DB.prepare(`DELETE FROM chat_muted WHERE user_id = ?`).bind(userId).run();
    await env.DB.prepare(`DELETE FROM chat_unread WHERE user_id = ?`).bind(userId).run();
    await env.DB.prepare(`DELETE FROM chat_banned WHERE user_id = ?`).bind(userId).run();
    await env.DB.prepare(`DELETE FROM chat_admins WHERE user_id = ?`).bind(userId).run();
    await env.DB.prepare(`DELETE FROM chat_stranger_limits WHERE user_id = ?`).bind(userId).run();
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
