// Cloudflare Pages Function - Batch user lookup
// GET /api/users/batch?ids=id1,id2,id3 - 批量查询用户基本信息
// 用于在线用户列表等场景，减少 N+1 查询

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
    return Response.json({ success: false, error: '数据库未绑定' }, { status: 500 });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const idsParam = url.searchParams.get('ids') || '';

    // 鉴权
    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId) {
      return Response.json({ success: false, error: '请先登录' }, { status: 401 });
    }

    if (!idsParam) {
      return Response.json({ success: true, data: [] });
    }

    const ids = idsParam.split(',').filter(Boolean).slice(0, 200); // 最多200个
    if (ids.length === 0) {
      return Response.json({ success: true, data: [] });
    }

    const placeholders = ids.map(() => '?').join(',');
    const results = await env.DB.prepare(
      `SELECT id, name, avatar, doubao_id, bio, last_login_at FROM users WHERE id IN (${placeholders})`
    ).bind(...ids).all();

    const users = (results.results || []).map(u => ({
      id: u.id,
      name: u.name,
      avatar: u.avatar,
      doubao_id: u.doubao_id,
      bio: u.bio,
      last_login_at: u.last_login_at
    }));

    return Response.json({ success: true, data: users });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
