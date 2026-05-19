// Cloudflare Pages Function - Announcements API
// GET  /api/announcements        - 获取所有公告
// POST /api/announcements        - 发布公告
// DELETE /api/announcements?id=xxx - 删除公告

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
      `SELECT id, title, content, created_by, created_at, updated_at 
       FROM announcements ORDER BY created_at DESC`
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
    const { title, content, created_by } = body;

    if (!title || !content || !created_by) {
      return Response.json({ success: false, error: '标题、内容和创建者不能为空' });
    }

    // 验证创建者是开发者
    const user = await env.DB.prepare(`SELECT doubao_id FROM users WHERE id = ?`).bind(created_by).first();
    if (!user || user.doubao_id !== '470208447') {
      return Response.json({ success: false, error: '只有开发者才能发布公告' });
    }

    const result = await env.DB.prepare(
      `INSERT INTO announcements (title, content, created_by) VALUES (?, ?, ?)`
    ).bind(title, content, created_by).run();

    const announcement = await env.DB.prepare(
      `SELECT id, title, content, created_by, created_at, updated_at FROM announcements WHERE id = ?`
    ).bind(result.meta.last_row_id).first();

    return Response.json({ success: true, data: announcement });
  } catch (e) {
    return Response.json({ success: false, error: '发布失败：' + e.message });
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
      return Response.json({ success: false, error: '缺少公告ID' });
    }

    await env.DB.prepare(`DELETE FROM announcements WHERE id = ?`).bind(id).run();

    return Response.json({ success: true });
  } catch (e) {
    return Response.json({ success: false, error: '删除失败：' + e.message });
  }
}
