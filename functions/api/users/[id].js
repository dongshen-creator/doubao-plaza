// Cloudflare Pages Function - Delete User Account
// DELETE /api/users/[id]

export async function onRequestDelete(context) {
  const { env } = context;
  const userId = context.params.id;

  if (!userId) {
    return Response.json({ success: false, error: '用户ID不能为空' });
  }

  try {
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
