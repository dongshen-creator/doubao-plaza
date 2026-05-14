// Cloudflare Pages Function - Blocked Users API
// GET    /api/blocked?user_id=xxx          - 获取黑名单
// POST   /api/blocked                      - 拉黑用户
// DELETE /api/blocked?id=xxx               - 移出黑名单

export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const userId = url.searchParams.get('user_id');

  if (!userId) {
    return Response.json({ success: false, error: 'user_id 是必填参数' });
  }

  const results = await env.DB.prepare(
    `SELECT b.id, b.created_at,
            u.id as blocked_id, u.name as blocked_name, u.email as blocked_email,
            u.avatar as blocked_avatar, u.bio as blocked_bio
     FROM blocked_users b
     JOIN users u ON u.id = b.blocked_user_id
     WHERE b.user_id = ?`
  ).bind(userId).all();

  const blocked = results.results.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    blocked_user: {
      id: r.blocked_id,
      name: r.blocked_name,
      email: r.blocked_email,
      avatar: r.blocked_avatar,
      bio: r.blocked_bio,
    }
  }));

  return Response.json({ success: true, data: blocked });
}

export async function onRequestPost(context) {
  const { env } = context;
  const { user_id, blocked_user_id } = await context.request.json();

  if (!user_id || !blocked_user_id) {
    return Response.json({ success: false, error: 'user_id 和 blocked_user_id 是必填项' });
  }
  if (user_id === blocked_user_id) {
    return Response.json({ success: false, error: '不能拉黑自己' });
  }

  const existing = await env.DB.prepare(
    `SELECT * FROM blocked_users WHERE user_id = ? AND blocked_user_id = ?`
  ).bind(user_id, blocked_user_id).first();

  if (existing) {
    return Response.json({ success: false, error: '该用户已在黑名单中' });
  }

  try {
    const result = await env.DB.prepare(
      `INSERT INTO blocked_users (user_id, blocked_user_id) VALUES (?, ?)`
    ).bind(user_id, blocked_user_id).run();
    return Response.json({ success: true, data: { id: result.meta.last_row_id } });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}

export async function onRequestDelete(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const id = url.searchParams.get('id');

  if (!id) {
    return Response.json({ success: false, error: 'id 是必填参数' });
  }

  try {
    await env.DB.prepare(`DELETE FROM blocked_users WHERE id = ?`).bind(id).run();
    return Response.json({ success: true, message: '已移出黑名单' });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
