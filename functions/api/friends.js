// Cloudflare Pages Function - Friends API (完整版)
// GET    /api/friends?user_id=xxx&status=pending|accepted  - 获取好友/申请列表
// POST   /api/friends             - 发送好友申请
// PUT    /api/friends?id=xxx      - 审核好友申请 (accept/reject)
// DELETE /api/friends?id=xxx      - 删除好友

export async function onRequestGet(context) {
  // 首先检查环境变量
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定，请在Cloudflare Pages设置中绑定D1数据库' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const userId = url.searchParams.get('user_id');
    const status = url.searchParams.get('status') || 'accepted';

    if (!userId) {
      return Response.json({ success: false, error: 'user_id 是必填参数' });
    }

    // 获取好友列表（包含对方信息）
    const results = await env.DB.prepare(
      `SELECT f.id, f.user_id, f.friend_id, f.status, f.created_at, f.updated_at,
              u.id as friend_user_id, u.name as friend_name, 
              u.avatar as friend_avatar, u.bio as friend_bio,
              u.doubao_id as friend_doubao_id, u.agent_url as friend_agent_url
       FROM friendships f
       JOIN users u ON (CASE WHEN f.user_id = ? THEN u.id = f.friend_id ELSE u.id = f.user_id END)
       WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = ?
       ORDER BY f.updated_at DESC`
    ).bind(userId, userId, userId, status).all();

    // 标记是"我发出的"还是"对方发出的"
    const friendships = results.results.map((r) => ({
      id: r.id,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
      is_outgoing: r.user_id === userId, // 是否是我发出的申请
      friend: {
        id: r.friend_user_id,
        name: r.friend_name,
        avatar: r.friend_avatar,
        bio: r.friend_bio,
        doubao_id: r.friend_doubao_id,
        agent_url: r.friend_agent_url,
      }
    }));

    return Response.json({ success: true, data: friendships });
  } catch (e) {
    return Response.json({ success: false, error: '服务器错误：' + e.message });
  }
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
    const { user_id, friend_id } = body;

    if (!user_id || !friend_id) {
      return Response.json({ success: false, error: 'user_id 和 friend_id 是必填项' });
    }
    if (user_id === friend_id) {
      return Response.json({ success: false, error: '不能添加自己为好友' });
    }

    // 检查是否已存在任何关系
    const existing = await env.DB.prepare(
      `SELECT * FROM friendships WHERE 
       (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`
    ).bind(user_id, friend_id, friend_id, user_id).first();

    if (existing) {
      if (existing.status === 'accepted') {
        return Response.json({ success: false, error: '你们已经是好友' });
      } else if (existing.status === 'pending') {
        return Response.json({ success: false, error: '好友申请已发送，等待对方处理' });
      } else if (existing.status === 'rejected') {
        // 之前被拒绝过，可以重新申请
        await env.DB.prepare(
          `UPDATE friendships SET status = 'pending', user_id = ?, friend_id = ?, updated_at = datetime('now') WHERE id = ?`
        ).bind(user_id, friend_id, existing.id).run();
        return Response.json({ success: true, data: { id: existing.id, status: 'pending' } });
      }
    }

    const result = await env.DB.prepare(
      `INSERT INTO friendships (user_id, friend_id, status) VALUES (?, ?, 'pending')`
    ).bind(user_id, friend_id).run();
    return Response.json({ success: true, data: { id: result.meta.last_row_id, status: 'pending' } });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}

export async function onRequestPut(context) {
  // 首先检查环境变量
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定，请在Cloudflare Pages设置中绑定D1数据库' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const id = url.searchParams.get('id');
    const body = await context.request.json().catch(() => ({}));
    const { action } = body;

    if (!id) {
      return Response.json({ success: false, error: 'id 是必填参数' });
    }

    if (!['accept', 'reject'].includes(action)) {
      return Response.json({ success: false, error: 'action 必须是 accept 或 reject' });
    }

    const newStatus = action === 'accept' ? 'accepted' : 'rejected';

    await env.DB.prepare(
      `UPDATE friendships SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(newStatus, id).run();
    return Response.json({ success: true, message: action === 'accept' ? '已通过好友申请' : '已拒绝好友申请' });
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
    const url = new URL(context.request.url);
    const id = url.searchParams.get('id');

    if (!id) {
      return Response.json({ success: false, error: 'id 是必填参数' });
    }

    await env.DB.prepare(`DELETE FROM friendships WHERE id = ?`).bind(id).run();
    return Response.json({ success: true, message: '已移除好友' });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
