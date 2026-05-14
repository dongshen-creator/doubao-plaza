// Cloudflare Pages Function - Users API
// GET  /api/users?search=xxx  - 搜索用户
// POST /api/users             - 注册
// POST /api/users/login       - 登录

export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const search = url.searchParams.get('search') || '';

  if (search) {
    const results = await env.DB.prepare(
      `SELECT id, name, email, avatar, bio, doubao_id, agent_url, privacy_setting, invite_code, created_at
       FROM users WHERE name LIKE ? OR email LIKE ? OR doubao_id LIKE ?`
    ).bind(`%${search}%`, `%${search}%`, `%${search}%`).all();
    return Response.json({ success: true, data: results.results });
  }

  const results = await env.DB.prepare(
    `SELECT id, name, email, avatar, bio, doubao_id, agent_url, privacy_setting, invite_code, created_at FROM users ORDER BY created_at DESC`
  ).all();
  return Response.json({ success: true, data: results.results });
}

export async function onRequestPost(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const body = await context.request.json();

  // 登录
  if (url.pathname === '/api/users/login') {
    const { identifier, password } = body;
    if (!identifier || !password) {
      return Response.json({ success: false, error: '请输入账号和密码' });
    }
    const user = await env.DB.prepare(
      `SELECT * FROM users WHERE (email = ? OR doubao_id = ? OR agent_url = ?) AND password = ?`
    ).bind(identifier, identifier, identifier, password).first();

    if (!user) {
      return Response.json({ success: false, error: '账号或密码错误' });
    }
    const { password: _, ...safeUser } = user;
    return Response.json({ success: true, data: safeUser });
  }

  // 注册
  const { name, email, password, doubao_id, agent_url, avatar, bio } = body;
  if (!name || !email || !password) {
    return Response.json({ success: false, error: '姓名、邮箱和密码是必填项' });
  }
  if (password.length !== 6) {
    return Response.json({ success: false, error: '密码必须为6位' });
  }

  try {
    const result = await env.DB.prepare(
      `INSERT INTO users (name, email, password, doubao_id, agent_url, avatar, bio) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(name, email, password, doubao_id || null, agent_url || null, avatar || null, bio || null).run();

    const user = await env.DB.prepare(
      `SELECT id, name, email, avatar, bio, doubao_id, agent_url, privacy_setting, invite_code, created_at FROM users WHERE id = ?`
    ).bind(result.meta.last_row_id).first();

    return Response.json({ success: true, data: user });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) {
      return Response.json({ success: false, error: '邮箱已被使用' });
    }
    return Response.json({ success: false, error: '注册失败：' + e.message });
  }
}
