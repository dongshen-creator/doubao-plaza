// Cloudflare Pages Function - Friends API
// GET    /api/friends?user_id=xxx&status=accepted  - 获取好友列表
// POST   /api/friends                             - 添加好友
// DELETE /api/friends?id=xxx                       - 移除好友

export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const userId = url.searchParams.get('user_id');
  const status = url.searchParams.get('status') || 'accepted';

  if (!userId) {
    return Response.json({ success: false, error: 'user_id 是必填参数' });
  }

  const results = await env.DB.prepare(
    `SELECT f.id, f.status, f.created_at,
            u.id as friend_id, u.name as friend_name, u.email as friend_email,
            u.avatar as friend_avatar, u.bio as friend_bio
     FROM friendships f
     JOIN users u ON (CASE WHEN f.user_id = ? THEN u.id = f.friend_id ELSE u.id = f.user_id END)
     WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = ?`
  ).bind(userId, userId, userId, status).all();

  const friends = results.results.map((r) => ({
    id: r.id,
    status: r.status,
    created_at: r.created_at,
    friend: {
      id: r.friend_id,
      name: r.friend_name,
      email: r.friend_email,
      avatar: r.friend_avatar,
      bio: r.friend_bio,
    }
  }));

  return Response.json({ success: true, data: friends });
}

export async function onRequestPost(context) {
  const { env } = context;
  const { user_id, friend_id } = await context.request.json();

  if (!user_id || !friend_id) {
    return Response.json({ success: false, error: 'user_id 和 friend_id 是必填项' });
  }
  if (user_id === friend_id) {
    return Response.json({ success: false, error: '不能添加自己为好友' });
  }

  // 检查是否已存在
  const existing = await env.DB.prepare(
    `SELECT * FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`
  ).bind(user_id, friend_id, friend_id, user_id).first();

  if (existing) {
    return Response.json({ success: false, error: '你们已经是好友或请求已发送' });
  }

  try {
    const result = await env.DB.prepare(
      `INSERT INTO friendships (user_id, friend_id, status) VALUES (?, ?, 'accepted')`
    ).bind(user_id, friend_id).run();
    return Response.json({ success: true, data: { id: result.meta.last_row_id, status: 'accepted' } });
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
    await env.DB.prepare(`DELETE FROM friendships WHERE id = ?`).bind(id).run();
    return Response.json({ success: true, message: '已移除好友' });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
