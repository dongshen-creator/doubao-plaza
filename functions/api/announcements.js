// Cloudflare Pages Function - Announcements API
// GET  /api/announcements        - 获取所有公告
// POST /api/announcements        - 发布公告
// PUT  /api/announcements        - 编辑公告
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
      `SELECT id, title, content, created_by, is_system, created_at, updated_at 
       FROM announcements ORDER BY created_at DESC`
    ).all();

    const data = (results.results || []).map(r => ({
      ...r,
      created_at: r.created_at ? r.created_at.replace(' ', 'T') + 'Z' : null,
      is_system: r.is_system === 1 || r.created_by === 'system'
    }));

    // 如果没有系统公告，追加一个虚拟系统公告
    const sysAnn = data.find(a => a.created_by === 'system');
    if (!sysAnn) {
      data.unshift({
        id: '__system__',
        title: '📜 必读公告',
        content: '<p>欢迎来到逗包用户广场！本平台采用"防君子不防小人"的原则运营。</p><p>请遵守以下基本规则：</p><ul><li>尊重他人，友善交流</li><li>不发布违法或不当内容</li><li>不滥用平台功能</li></ul><p>祝您使用愉快！</p>',
        created_by: 'system',
        created_at: new Date().toISOString(),
        is_system: true
      });
    }
    return Response.json({ success: true, data });
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
    const { title, content, created_by, is_system } = body;

    if (!title || !content || !created_by) {
      return Response.json({ success: false, error: '标题、内容和创建者不能为空' });
    }

    // 验证创建者是开发者
    const DEV_IDS = ['470208447', 'East_pairs'];
    const user = await env.DB.prepare(`SELECT doubao_id FROM users WHERE id = ?`).bind(created_by).first();
    if (!user || !DEV_IDS.includes(user.doubao_id)) {
      return Response.json({ success: false, error: '只有开发者才能发布公告' });
    }

    const result = await env.DB.prepare(
      `INSERT INTO announcements (title, content, created_by, is_system) VALUES (?, ?, ?, ?)`
    ).bind(title, content, created_by, is_system ? 1 : 0).run();

    const announcement = await env.DB.prepare(
      `SELECT id, title, content, created_by, created_at, updated_at FROM announcements WHERE id = ?`
    ).bind(result.meta.last_row_id).first();

    if (announcement && announcement.created_at) {
      announcement.created_at = announcement.created_at.replace(' ', 'T') + 'Z';
    }
    return Response.json({ success: true, data: announcement });
  } catch (e) {
    return Response.json({ success: false, error: '发布失败：' + e.message });
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
    const body = await context.request.json().catch(() => ({}));
    const { id, title, content, created_by } = body;

    if (!id) {
      return Response.json({ success: false, error: '缺少公告ID' });
    }
    if (!title || !content) {
      return Response.json({ success: false, error: '标题和内容不能为空' });
    }

    // 验证创建者是开发者
    const DEV_IDS = ['470208447', 'East_pairs'];
    const user = await env.DB.prepare(`SELECT doubao_id FROM users WHERE id = ?`).bind(created_by).first();
    if (!user || !DEV_IDS.includes(user.doubao_id)) {
      return Response.json({ success: false, error: '只有开发者才能编辑公告' });
    }

    // 如果是系统公告，用 INSERT OR REPLACE 处理（可能不在数据库中）
    if (id === '__system__') {
      await env.DB.prepare(
        `INSERT INTO announcements (id, title, content, created_by, is_system) VALUES (?, ?, ?, 'system', 1)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, updated_at=datetime('now')`
      ).bind('__system__', title, content).run();

      const announcement = await env.DB.prepare(
        `SELECT id, title, content, created_by, created_at, updated_at FROM announcements WHERE id = ?`
      ).bind('__system__').first();

      if (announcement) {
        if (announcement.created_at) announcement.created_at = announcement.created_at.replace(' ', 'T') + 'Z';
        if (announcement.updated_at) announcement.updated_at = announcement.updated_at.replace(' ', 'T') + 'Z';
        announcement.is_system = true;
      }
      return Response.json({ success: true, data: announcement });
    }

    await env.DB.prepare(
      `UPDATE announcements SET title = ?, content = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(title, content, id).run();

    const announcement = await env.DB.prepare(
      `SELECT id, title, content, created_by, created_at, updated_at FROM announcements WHERE id = ?`
    ).bind(id).first();

    if (announcement && announcement.created_at) {
      announcement.created_at = announcement.created_at.replace(' ', 'T') + 'Z';
    }
    if (announcement && announcement.updated_at) {
      announcement.updated_at = announcement.updated_at.replace(' ', 'T') + 'Z';
    }
    return Response.json({ success: true, data: announcement });
  } catch (e) {
    return Response.json({ success: false, error: '编辑失败：' + e.message });
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

    if (id === '__system__') {
      return Response.json({ success: false, error: '初始公告不可删除' });
    }

    await env.DB.prepare(`DELETE FROM announcements WHERE id = ?`).bind(id).run();

    return Response.json({ success: true });
  } catch (e) {
    return Response.json({ success: false, error: '删除失败：' + e.message });
  }
}
