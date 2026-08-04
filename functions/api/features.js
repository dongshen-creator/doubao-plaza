// Cloudflare Pages Function - Features API
// GET    /api/features          - 获取所有功能
// POST   /api/features          - 添加功能
// DELETE /api/features?id=xxx   - 删除功能

// 确保工具包相关列存在（幂等）
async function ensureToolColumns(env) {
  await env.DB.prepare("ALTER TABLE features ADD COLUMN tool_type TEXT").run().catch(() => {});
  await env.DB.prepare("ALTER TABLE features ADD COLUMN tool_config TEXT").run().catch(() => {});
}

// 从 Authorization 头解析已登录用户 ID
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

// 检查用户是否为开发者（is_developer === 1）
async function isDeveloper(env, userId) {
  if (!userId) return false;
  const user = await env.DB.prepare(
    `SELECT is_developer FROM users WHERE id = ?`
  ).bind(userId).first();
  if (!user) return false;
  return user.is_developer === 1 || user.is_developer === '1' || user.is_developer === true;
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
    await ensureToolColumns(env);
    const results = await env.DB.prepare(
      `SELECT id, title, icon_url, link_url, sort_order, created_by, created_at, updated_at, tool_type, tool_config
       FROM features ORDER BY sort_order ASC, created_at DESC`
    ).all();

    return Response.json({ success: true, data: results.results });
  } catch (e) {
    return Response.json({ success: false, error: '服务器错误：' + e.message });
  }
}

export async function onRequestPost(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { env } = context;
    await ensureToolColumns(env);
    // 鉴权：Bearer Token
    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId) {
      return Response.json({ success: false, error: '请先登录' }, { status: 401 });
    }
    if (!(await isDeveloper(env, authUserId))) {
      return Response.json({ success: false, error: '只有开发者才能管理功能' }, { status: 403 });
    }

    const body = await context.request.json().catch(() => ({}));
    const { title, icon_url, link_url, tool_type, tool_config } = body;

    if (!title || !link_url) {
      return Response.json({ success: false, error: '标题和链接不能为空' });
    }
    const created_by = authUserId;

    // 获取当前最大 sort_order
    const maxOrder = await env.DB.prepare(`SELECT MAX(sort_order) as max_order FROM features`).first();
    const sort_order = (maxOrder?.max_order || 0) + 1;

    const result = await env.DB.prepare(
      `INSERT INTO features (title, icon_url, link_url, sort_order, created_by, tool_type, tool_config) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(title, icon_url || null, link_url, sort_order, created_by, tool_type || null, tool_config || null).run();

    const feature = await env.DB.prepare(
      `SELECT id, title, icon_url, link_url, sort_order, created_by, created_at, updated_at, tool_type, tool_config FROM features WHERE id = ?`
    ).bind(result.meta.last_row_id).first();

    return Response.json({ success: true, data: feature });
  } catch (e) {
    return Response.json({ success: false, error: '添加失败：' + e.message });
  }
}

export async function onRequestPut(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { env } = context;
    await ensureToolColumns(env);
    const url = new URL(context.request.url);
    const id = url.searchParams.get('id');

    if (!id) {
      return Response.json({ success: false, error: '缺少功能ID' });
    }

    // 鉴权：Bearer Token
    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId) {
      return Response.json({ success: false, error: '请先登录' }, { status: 401 });
    }
    if (!(await isDeveloper(env, authUserId))) {
      return Response.json({ success: false, error: '只有开发者才能管理功能' }, { status: 403 });
    }

    const body = await context.request.json().catch(() => ({}));
    const { title, icon_url, link_url, tool_type, tool_config } = body;

    if (!title || !link_url) {
      return Response.json({ success: false, error: '标题和链接不能为空' });
    }

    await env.DB.prepare(
      `UPDATE features SET title = ?, icon_url = ?, link_url = ?, tool_type = ?, tool_config = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(title, icon_url || null, link_url, tool_type || null, tool_config || null, id).run();

    const feature = await env.DB.prepare(
      `SELECT id, title, icon_url, link_url, sort_order, created_by, created_at, updated_at, tool_type, tool_config FROM features WHERE id = ?`
    ).bind(id).first();

    return Response.json({ success: true, data: feature });
  } catch (e) {
    return Response.json({ success: false, error: '更新失败：' + e.message });
  }
}

export async function onRequestDelete(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const id = url.searchParams.get('id');

    if (!id) {
      return Response.json({ success: false, error: '缺少功能ID' });
    }

    // 鉴权：Bearer Token
    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId) {
      return Response.json({ success: false, error: '请先登录' }, { status: 401 });
    }
    if (!(await isDeveloper(env, authUserId))) {
      return Response.json({ success: false, error: '只有开发者才能删除功能' }, { status: 403 });
    }

    await env.DB.prepare(`DELETE FROM features WHERE id = ?`).bind(id).run();

    return Response.json({ success: true });
  } catch (e) {
    return Response.json({ success: false, error: '删除失败：' + e.message });
  }
}
