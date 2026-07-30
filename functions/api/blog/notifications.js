// Cloudflare Pages Function - Blog Notifications API
// GET  /api/blog/notifications          - 获取当前用户的通知列表（最新50条）
// POST /api/blog/notifications/read     - 标记所有通知为已读
// POST /api/blog/notifications/read-one - 标记单条通知为已读（body: { id }）

// ===== 通用辅助函数 =====

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function formatDate(d) {
  if (!d) return null;
  if (typeof d !== 'string') return d;
  if (d.includes('T')) return d;
  return d.replace(' ', 'T') + 'Z';
}

// 统一鉴权：从 Authorization 头取 Bearer token，校验会话有效性，返回 user_id 或 null
async function getAuthUserId(env, request) {
  if (!env || !env.DB || !request) return null;
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const session = await env.DB.prepare(
    `SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
  return session ? session.user_id : null;
}

// ===== 预检请求 =====
export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

// ===== GET: 获取当前用户的通知列表 =====
export async function onRequestGet(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定' }, 500);
  }

  try {
    const { env, request } = context;
    const authUserId = await getAuthUserId(env, request);
    if (!authUserId) {
      return jsonResponse({ success: false, error: '请先登录' }, 403);
    }

    // 获取最新50条通知
    const results = await env.DB.prepare(
      `SELECT id, user_id, post_id, post_title, comment_id, sender_id, sender_name, sender_avatar, content, read, created_at
       FROM blog_notifications
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`
    ).bind(authUserId).all();

    const data = (results.results || []).map(r => ({
      ...r,
      read: r.read === 1 || r.read === '1' || r.read === true,
      created_at: formatDate(r.created_at),
    }));

    // 统计未读数
    const unreadRow = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM blog_notifications WHERE user_id = ? AND read = 0`
    ).bind(authUserId).first();
    const unreadCount = unreadRow ? unreadRow.count : 0;

    return jsonResponse({ success: true, data, unread_count: unreadCount });
  } catch (e) {
    return jsonResponse({ success: false, error: '服务器错误：' + e.message }, 500);
  }
}

// ===== POST: 标记通知为已读 =====
export async function onRequestPost(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定' }, 500);
  }

  try {
    const { env, request } = context;
    const authUserId = await getAuthUserId(env, request);
    if (!authUserId) {
      return jsonResponse({ success: false, error: '请先登录' }, 403);
    }

    const body = await request.json().catch(() => ({}));
    const url = new URL(context.request.url);
    const action = url.searchParams.get('action') || body.action || 'read_all';

    if (action === 'read_one' && body.id) {
      // 标记单条通知为已读
      await env.DB.prepare(
        `UPDATE blog_notifications SET read = 1 WHERE id = ? AND user_id = ?`
      ).bind(body.id, authUserId).run();
    } else {
      // 标记所有通知为已读
      await env.DB.prepare(
        `UPDATE blog_notifications SET read = 1 WHERE user_id = ? AND read = 0`
      ).bind(authUserId).run();
    }

    return jsonResponse({ success: true, message: '已标记为已读' });
  } catch (e) {
    return jsonResponse({ success: false, error: '操作失败：' + e.message }, 500);
  }
}
