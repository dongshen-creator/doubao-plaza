// Cloudflare Pages Function - Blog Announcements API
// GET    /api/blog/announce          - 获取所有公告（按 pinned DESC, created_at DESC 排序）
// POST   /api/blog/announce          - 创建公告（仅开发者可创建）
// DELETE /api/blog/announce?id=xxx   - 删除公告（仅开发者可删除，需要 Bearer token 认证）

// ===== 常量 =====
const DEV_IDS = ['470208447', 'East_pairs'];

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

// 检查用户是否为开发者（DEV_IDS 白名单 或 is_developer === 1）
async function isDeveloper(env, userId) {
  if (!env || !env.DB || !userId) return false;
  const user = await env.DB.prepare(
    `SELECT doubao_id, is_developer FROM users WHERE id = ?`
  ).bind(userId).first();
  if (!user) return false;
  if (user.is_developer === 1 || user.is_developer === '1' || user.is_developer === true) return true;
  if (user.doubao_id && DEV_IDS.includes(user.doubao_id)) return true;
  return false;
}

// ===== 预检请求 =====
export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

// ===== GET: 获取所有公告（按 pinned DESC, created_at DESC 排序） =====
export async function onRequestGet(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定，请在 Cloudflare Pages 设置中绑定 D1 数据库' }, 500);
  }

  try {
    const { env } = context;

    const results = await env.DB.prepare(
      `SELECT id, content, created_by, created_by_name, pinned, created_at
       FROM blog_announcements
       ORDER BY pinned DESC, created_at DESC`
    ).all();

    const data = (results.results || []).map(r => ({
      ...r,
      pinned: r.pinned === 1 || r.pinned === '1' || r.pinned === true,
      created_at: formatDate(r.created_at),
    }));

    return jsonResponse({ success: true, data });
  } catch (e) {
    return jsonResponse({ success: false, error: '服务器错误：' + e.message }, 500);
  }
}

// ===== POST: 创建公告（仅开发者可创建） =====
export async function onRequestPost(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定，请在 Cloudflare Pages 设置中绑定 D1 数据库' }, 500);
  }

  try {
    const { env, request } = context;

    // 鉴权：仅开发者可创建公告
    const authUserId = await getAuthUserId(env, request);
    if (!authUserId) {
      return jsonResponse({ success: false, error: '请先登录' }, 403);
    }

    const isDev = await isDeveloper(env, authUserId);
    if (!isDev) {
      return jsonResponse({ success: false, error: '无权操作，仅开发者可创建公告' }, 403);
    }

    const body = await request.json().catch(() => ({}));
    const { content, created_by, pinned } = body;

    // 基本验证
    if (!content || !String(content).trim()) {
      return jsonResponse({ success: false, error: '公告内容不能为空' });
    }

    // 从 users 表获取用户名称
    const user = await env.DB.prepare(
      `SELECT id, name FROM users WHERE id = ?`
    ).bind(authUserId).first();
    if (!user) {
      return jsonResponse({ success: false, error: '用户信息不存在' }, 403);
    }

    // created_by 优先使用请求体中的值，回退到认证用户 ID
    const finalCreatedBy = created_by || authUserId;
    const finalCreatedByName = user.name;
    const pinnedValue = pinned !== undefined ? (pinned ? 1 : 0) : 1;

    // 插入公告
    const result = await env.DB.prepare(
      `INSERT INTO blog_announcements (content, created_by, created_by_name, pinned)
       VALUES (?, ?, ?, ?)`
    ).bind(String(content).trim(), finalCreatedBy, finalCreatedByName, pinnedValue).run();

    // 查询新创建的公告
    const announcement = await env.DB.prepare(
      `SELECT id, content, created_by, created_by_name, pinned, created_at
       FROM blog_announcements WHERE id = ?`
    ).bind(result.meta.last_row_id).first();

    announcement.pinned = announcement.pinned === 1 || announcement.pinned === '1' || announcement.pinned === true;
    announcement.created_at = formatDate(announcement.created_at);

    return jsonResponse({ success: true, data: announcement });
  } catch (e) {
    return jsonResponse({ success: false, error: '创建公告失败：' + e.message }, 500);
  }
}

// ===== DELETE: 删除公告（仅开发者可删除，需要 Bearer token 认证） =====
export async function onRequestDelete(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定，请在 Cloudflare Pages 设置中绑定 D1 数据库' }, 500);
  }

  try {
    const { env, request } = context;
    const url = new URL(context.request.url);
    const announceId = url.searchParams.get('id');

    if (!announceId) {
      return jsonResponse({ success: false, error: '缺少公告 ID（id 参数）' });
    }

    // 鉴权：需要 Authorization: Bearer token 认证
    const authUserId = await getAuthUserId(env, request);
    if (!authUserId) {
      return jsonResponse({ success: false, error: '请先登录' }, 403);
    }

    // 仅开发者可删除
    const isDev = await isDeveloper(env, authUserId);
    if (!isDev) {
      return jsonResponse({ success: false, error: '无权操作，仅开发者可删除公告' }, 403);
    }

    // 验证公告是否存在
    const announcement = await env.DB.prepare(
      `SELECT id FROM blog_announcements WHERE id = ?`
    ).bind(announceId).first();
    if (!announcement) {
      return jsonResponse({ success: false, error: '公告不存在' }, 404);
    }

    // 删除公告
    await env.DB.prepare(
      `DELETE FROM blog_announcements WHERE id = ?`
    ).bind(announceId).run();

    return jsonResponse({ success: true, message: '公告已删除' });
  } catch (e) {
    return jsonResponse({ success: false, error: '删除失败：' + e.message }, 500);
  }
}
