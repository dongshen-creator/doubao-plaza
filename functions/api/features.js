// Cloudflare Pages Function - Features API
// GET    /api/features          - 获取所有功能
// POST   /api/features          - 添加功能
// DELETE /api/features?id=xxx   - 删除功能

export async function onRequestGet(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { env } = context;
    const results = await env.DB.prepare(
      `SELECT id, title, icon_url, link_url, sort_order, created_by, created_at, updated_at 
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
    const body = await context.request.json().catch(() => ({}));
    const { title, icon_url, link_url, created_by } = body;

    if (!title || !link_url || !created_by) {
      return Response.json({ success: false, error: '标题、链接和创建者不能为空' });
    }

    // 验证创建者是开发者
    const DEV_IDS = ['470208447', 'East_pairs'];
    const user = await env.DB.prepare(`SELECT doubao_id FROM users WHERE id = ?`).bind(created_by).first();
    if (!user || !DEV_IDS.includes(user.doubao_id)) {
      return Response.json({ success: false, error: '只有开发者才能管理功能' });
    }

    // 获取当前最大 sort_order
    const maxOrder = await env.DB.prepare(`SELECT MAX(sort_order) as max_order FROM features`).first();
    const sort_order = (maxOrder?.max_order || 0) + 1;

    const result = await env.DB.prepare(
      `INSERT INTO features (title, icon_url, link_url, sort_order, created_by) VALUES (?, ?, ?, ?, ?)`
    ).bind(title, icon_url || null, link_url, sort_order, created_by).run();

    const feature = await env.DB.prepare(
      `SELECT id, title, icon_url, link_url, sort_order, created_by, created_at, updated_at FROM features WHERE id = ?`
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
    const url = new URL(context.request.url);
    const id = url.searchParams.get('id');
    const body = await context.request.json().catch(() => ({}));
    const { title, icon_url, link_url, updated_by } = body;

    if (!id) {
      return Response.json({ success: false, error: '缺少功能ID' });
    }

    if (!title || !link_url) {
      return Response.json({ success: false, error: '标题和链接不能为空' });
    }

    const updaterId = updated_by || body.created_by;
    if (!updaterId) {
      return Response.json({ success: false, error: '缺少用户标识' });
    }

    const DEV_IDS = ['470208447', 'East_pairs'];
    const user = await env.DB.prepare(`SELECT doubao_id FROM users WHERE id = ?`).bind(updaterId).first();
    if (!user || !DEV_IDS.includes(user.doubao_id)) {
      return Response.json({ success: false, error: '只有开发者才能管理功能' });
    }

    await env.DB.prepare(
      `UPDATE features SET title = ?, icon_url = ?, link_url = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(title, icon_url || null, link_url, id).run();

    const feature = await env.DB.prepare(
      `SELECT id, title, icon_url, link_url, sort_order, created_by, created_at, updated_at FROM features WHERE id = ?`
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

    await env.DB.prepare(`DELETE FROM features WHERE id = ?`).bind(id).run();

    return Response.json({ success: true });
  } catch (e) {
    return Response.json({ success: false, error: '删除失败：' + e.message });
  }
}
