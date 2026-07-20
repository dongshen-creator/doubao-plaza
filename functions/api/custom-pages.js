// Cloudflare Pages Function - Custom Pages API
// GET    /api/custom-pages          - 获取所有自定义页面（仅标题和ID）
// GET    /api/custom-pages?id=xxx   - 获取单个页面完整内容
// POST   /api/custom-pages          - 创建页面（仅开发者）
// PUT    /api/custom-pages?id=xxx   - 更新页面（仅开发者）
// DELETE /api/custom-pages?id=xxx   - 删除页面（仅开发者）

// 检查是否为开发者
const DEV_IDS = ['470208447', 'East_pairs'];
async function isDeveloper(env, userId) {
  const user = await env.DB.prepare(`SELECT doubao_id FROM users WHERE id = ?`).bind(userId).first();
  return user && DEV_IDS.includes(user.doubao_id);
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

// GET - 获取页面列表或单个页面
export async function onRequestGet(context) {
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

    if (id) {
      // 获取单个页面
      const page = await env.DB.prepare(
        `SELECT id, title, html_content, created_at, updated_at FROM custom_pages WHERE id = ?`
      ).bind(id).first();

      if (!page) {
        return Response.json({ success: false, error: '页面不存在' });
      }

      return Response.json({ success: true, data: page });
    } else {
      // 获取列表（不包含 html_content，减少数据传输）
      const results = await env.DB.prepare(
        `SELECT id, title, created_at, updated_at FROM custom_pages ORDER BY created_at DESC`
      ).all();

      return Response.json({ success: true, data: results.results });
    }
  } catch (e) {
    return Response.json({ success: false, error: '服务器错误：' + e.message });
  }
}

// POST - 创建页面（仅开发者）
export async function onRequestPost(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { env } = context;
    const body = await context.request.json().catch(() => ({}));
    const { title, html_content, created_by } = body;

    if (!title || !html_content || !created_by) {
      return Response.json({ success: false, error: '标题、内容和创建者不能为空' });
    }

    // 验证创建者是开发者
    if (!await isDeveloper(env, created_by)) {
      return Response.json({ success: false, error: '只有开发者才能创建页面' });
    }

    const result = await env.DB.prepare(
      `INSERT INTO custom_pages (title, html_content, created_by) VALUES (?, ?, ?)`
    ).bind(title, html_content, created_by).run();

    const page = await env.DB.prepare(
      `SELECT id, title, created_at, updated_at FROM custom_pages WHERE id = ?`
    ).bind(result.meta.last_row_id).first();

    return Response.json({ success: true, data: page });
  } catch (e) {
    return Response.json({ success: false, error: '创建失败：' + e.message });
  }
}

// PUT - 更新页面（仅开发者）
export async function onRequestPut(context) {
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
    const body = await context.request.json().catch(() => ({}));
    const { title, html_content, updated_by } = body;

    if (!id) {
      return Response.json({ success: false, error: '缺少页面ID' });
    }

    if (!title || !html_content) {
      return Response.json({ success: false, error: '标题和内容不能为空' });
    }

    // 验证更新者是开发者
    const updaterId = updated_by || body.created_by;
    if (!updaterId || !await isDeveloper(env, updaterId)) {
      return Response.json({ success: false, error: '只有开发者才能更新页面' });
    }

    await env.DB.prepare(
      `UPDATE custom_pages SET title = ?, html_content = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(title, html_content, id).run();

    const page = await env.DB.prepare(
      `SELECT id, title, created_at, updated_at FROM custom_pages WHERE id = ?`
    ).bind(id).first();

    return Response.json({ success: true, data: page });
  } catch (e) {
    return Response.json({ success: false, error: '更新失败：' + e.message });
  }
}

// DELETE - 删除页面（仅开发者）
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
      return Response.json({ success: false, error: '缺少页面ID' });
    }

    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId) {
      return Response.json({ success: false, error: '请先登录' }, { status: 403 });
    }
    const u = await env.DB.prepare('SELECT doubao_id, is_developer FROM users WHERE id=?').bind(authUserId).first();
    if (!u || (u.is_developer !== 1 && !DEV_IDS.includes(u.doubao_id))) {
      return Response.json({ success: false, error: '仅开发者可删除页面' }, { status: 403 });
    }

    await env.DB.prepare(`DELETE FROM custom_pages WHERE id = ?`).bind(id).run();

    return Response.json({ success: true });
  } catch (e) {
    return Response.json({ success: false, error: '删除失败：' + e.message });
  }
}
