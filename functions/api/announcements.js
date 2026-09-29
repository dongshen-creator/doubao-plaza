// Cloudflare Pages Function - Announcements API
// GET  /api/announcements        - 获取所有公告
// POST /api/announcements        - 发布公告（需 token 鉴权）
// PUT  /api/announcements        - 编辑公告（需 token 鉴权）
// DELETE /api/announcements?id=xxx - 删除公告（需 token 鉴权）

import { getAuthUserId } from './_lib/jwt.js';

// ===== v7.3: 公告 GET 边缘缓存 60s（D1 读放大治理）=====
// 写操作（POST/PUT/DELETE）成功后调用 purgeAnnouncementsCache 主动失效。
// 注意：Cloudflare 各边缘节点缓存独立，delete 仅作用于当前节点，
// 其余节点靠响应头 max-age=60 自然过期兜底（最坏 60s 陈旧，可接受）。
function annCacheKey(request) {
  const u = new URL(request.url);
  u.search = '';
  u.hash = '';
  return new Request(u.toString(), { method: 'GET' });
}

function purgeAnnouncementsCache(context) {
  try {
    context.waitUntil(caches.default.delete(annCacheKey(context.request)));
  } catch (e) { /* 失效失败不影响主流程，等 max-age 过期 */ }
}

export async function onRequestGet(context) {
  // 缓存优先：命中直接返回，跳过 DB 检查与查询
  const cacheKey = annCacheKey(context.request);
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) return hit;
  } catch (e) { /* 缓存不可用则回源 */ }

  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { env } = context;
    const results = await env.DB.prepare(
      `SELECT * FROM announcements ORDER BY created_at DESC`
    ).all();

    const data = (results.results || []).map(r => ({
      ...r,
      created_at: r.created_at ? r.created_at.replace(' ', 'T') + 'Z' : null,
      updated_at: r.updated_at ? r.updated_at.replace(' ', 'T') + 'Z' : null,
      is_system: (r.is_system === 1 || r.is_system === '1' || r.created_by === 'system') ? true : false
    }));

    // 如果没有系统公告，追加一个虚拟系统公告
    const sysAnn = data.find(a => a.created_by === 'system');
    if (!sysAnn) {
      data.unshift({
        id: '__system__',
        title: '📜 必读公告',
        content: '<p>欢迎来到逗包用户广场！本平台采用"防君子不防小人"的原则运营。</p><p>请遵守以下基本规则：</p><ul><li>尊重他人，友善交流</li><li>不发布违法或不当内容</li><li>不滥用平台功能</li></ul><p>祝您使用愉快！</p>',
        created_by: 'system',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
        is_system: true
      });
    }
    const response = new Response(JSON.stringify({ success: true, data }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' }
    });
    try {
      context.waitUntil(caches.default.put(cacheKey, response.clone()));
    } catch (e) { /* 缓存写入失败不影响本次响应 */ }
    return response;
  } catch (e) {
    console.error('[announcements.js]', e); return Response.json({ success: false, error: '服务器错误：' + '服务器内部错误' });
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
    const { title, content, is_system } = body;

    if (!title || !content) {
      return Response.json({ success: false, error: '标题和内容不能为空' });
    }

    // Token 鉴权：从 Authorization 头获取用户身份
    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId) {
      return Response.json({ success: false, error: '请先登录' }, { status: 401 });
    }

    // 验证当前用户是开发者
    const user = await env.DB.prepare(`SELECT is_developer FROM users WHERE id = ?`).bind(authUserId).first();
    if (!user || !(user.is_developer === 1 || user.is_developer === '1' || user.is_developer === true)) {
      return Response.json({ success: false, error: '只有开发者才能发布公告' });
    }

    let result;
    if (is_system) {
      result = await env.DB.prepare(
        "INSERT INTO announcements (title, content, created_by, is_system) VALUES (?, ?, ?, ?)"
      ).bind(title, content, authUserId, 1).run();
    } else {
      result = await env.DB.prepare(
        "INSERT INTO announcements (title, content, created_by) VALUES (?, ?, ?)"
      ).bind(title, content, authUserId).run();
    }

    const announcement = await env.DB.prepare(
      `SELECT id, title, content, created_by, created_at, updated_at FROM announcements WHERE id = ?`
    ).bind(result.meta.last_row_id).first();

    if (announcement && announcement.created_at) {
      announcement.created_at = announcement.created_at.replace(' ', 'T') + 'Z';
    }
    purgeAnnouncementsCache(context);
    return Response.json({ success: true, data: announcement });
  } catch (e) {
    console.error('[announcements.js]', e); return Response.json({ success: false, error: '发布失败：' + '服务器内部错误' });
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
    const { id, title, content } = body;

    if (!id) {
      return Response.json({ success: false, error: '缺少公告ID' });
    }
    if (!title || !content) {
      return Response.json({ success: false, error: '标题和内容不能为空' });
    }

    // Token 鉴权：从 Authorization 头获取用户身份
    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId) {
      return Response.json({ success: false, error: '请先登录' }, { status: 401 });
    }

    // 验证当前用户是开发者
    const user = await env.DB.prepare(`SELECT is_developer FROM users WHERE id = ?`).bind(authUserId).first();
    if (!user || !(user.is_developer === 1 || user.is_developer === '1' || user.is_developer === true)) {
      return Response.json({ success: false, error: '只有开发者才能编辑公告' });
    }

    // 如果是系统公告，用 INSERT OR REPLACE 处理（可能不在数据库中）
    if (id === '__system__') {
      try {
        await env.DB.prepare(
          "INSERT INTO announcements (id, title, content, created_by, is_system) VALUES (?, ?, ?, 'system', 1) ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, updated_at=datetime('now')"
        ).bind('__system__', title, content).run();
      } catch(e) {
        // fallback: 列可能不存在
        await env.DB.prepare(
          "INSERT INTO announcements (id, title, content, created_by) VALUES (?, ?, ?, 'system') ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, updated_at=datetime('now')"
        ).bind('__system__', title, content).run();
      }

      const announcement = await env.DB.prepare(
        `SELECT id, title, content, created_by, created_at, updated_at FROM announcements WHERE id = ?`
      ).bind('__system__').first();

      if (announcement) {
        if (announcement.created_at) announcement.created_at = announcement.created_at.replace(' ', 'T') + 'Z';
        if (announcement.updated_at) announcement.updated_at = announcement.updated_at.replace(' ', 'T') + 'Z';
        announcement.is_system = true;
      }
      purgeAnnouncementsCache(context);
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
    purgeAnnouncementsCache(context);
    return Response.json({ success: true, data: announcement });
  } catch (e) {
    console.error('[announcements.js]', e); return Response.json({ success: false, error: '编辑失败：' + '服务器内部错误' });
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

    // Token 鉴权：只有开发者可以删除公告
    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId) {
      return Response.json({ success: false, error: '请先登录' }, { status: 401 });
    }
    const user = await env.DB.prepare(`SELECT is_developer FROM users WHERE id = ?`).bind(authUserId).first();
    if (!user || !(user.is_developer === 1 || user.is_developer === '1' || user.is_developer === true)) {
      return Response.json({ success: false, error: '只有开发者才能删除公告' }, { status: 403 });
    }

    await env.DB.prepare(`DELETE FROM announcements WHERE id = ?`).bind(id).run();

    purgeAnnouncementsCache(context);
    return Response.json({ success: true });
  } catch (e) {
    console.error('[announcements.js]', e); return Response.json({ success: false, error: '删除失败：' + '服务器内部错误' });
  }
}
