// Cloudflare Pages Function - Blog Posts API
// GET  /api/blog                - 获取博客列表（分页，支持search搜索标题，返回不含content的摘要列表）
// POST /api/blog                - 创建博客文章（需要登录认证，任何已登录用户都可发布）
//
// 小肥羊讲堂 - 博客系统后端

// ===== 常量 =====
const DEV_IDS = ['470208447', 'East_pairs'];
// 博客房间浏览器访问 URL
const BLOG_ROOM_URL = 'https://chat.freserafim.com/zh-CN/rooms/b9d7d6e7-191f-408b-b308-b210dbe1a764';

// ===== 通用辅助函数 =====

// 统一 CORS 响应头
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

// 带 CORS 头的 JSON 响应
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// 格式化日期：SQLite datetime('now') 返回 "YYYY-MM-DD HH:MM:SS"，转为 ISO 格式
function formatDate(d) {
  if (!d) return null;
  if (typeof d !== 'string') return d;
  // 已经是 ISO 格式则直接返回
  if (d.includes('T')) return d;
  return d.replace(' ', 'T') + 'Z';
}

// 安全解析 tags 字段（存储为 JSON 字符串）
function safeParseTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags;
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
  // 兼容 D1 返回的整数/字符串/布尔值
  if (user.is_developer === 1 || user.is_developer === '1' || user.is_developer === true) return true;
  // 检查 doubao_id 白名单
  if (user.doubao_id && DEV_IDS.includes(user.doubao_id)) return true;
  return false;
}

// 简单 HTML 净化：移除 <script> 标签和 on* 事件属性
function sanitizeHtml(html) {
  if (!html) return '';
  let cleaned = String(html);
  // 移除 <script>...</script> 标签（含内容）
  cleaned = cleaned.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  // 移除 on* 事件属性（onclick, onload, onerror 等）
  cleaned = cleaned.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // 将 javascript: URL 替换为 #
  cleaned = cleaned.replace(/(href|src)\s*=\s*(["'])javascript:[^"']*\2/gi, '$1=$2#$2', cleaned);
  return cleaned;
}

// 记录发布时间戳（仅更新数据库，不调用任何外部 API）
async function recordPublish(env, postId) {
  try {
    await env.DB.prepare(
      `UPDATE blog_posts SET updated_at = datetime('now') WHERE id = ?`
    ).bind(postId).run();
  } catch(e) {}
  return null;
}

// ===== 预检请求 =====
export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

// ===== GET: 获取博客列表（分页 + 搜索，不含 content） =====
export async function onRequestGet(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定，请在 Cloudflare Pages 设置中绑定 D1 数据库' }, 500);
  }

  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const search = url.searchParams.get('search') || '';
    const page = Math.max(parseInt(url.searchParams.get('page') || '1', 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(url.searchParams.get('page_size') || url.searchParams.get('pageSize') || '10', 10) || 10, 1), 50);
    const offset = (page - 1) * pageSize;

    // 构建查询条件
    let whereClause = "WHERE status = 'published'";
    const params = [];
    if (search) {
      whereClause += ' AND title LIKE ?';
      params.push(`%${search}%`);
    }

    // 获取总数
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) as total FROM blog_posts ${whereClause}`
    ).bind(...params).first();
    const total = countRow ? countRow.total : 0;

    // 获取列表（不含 content 字段）
    const results = await env.DB.prepare(
      `SELECT id, title, summary, cover_image, tags, author_id, author_name, author_avatar,
              author_doubao_id, status, views, matrix_event_id, matrix_room_url, created_at, updated_at
       FROM blog_posts ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...params, pageSize, offset).all();

    const data = (results.results || []).map(r => ({
      ...r,
      tags: safeParseTags(r.tags),
      created_at: formatDate(r.created_at),
      updated_at: formatDate(r.updated_at),
    }));

    return jsonResponse({
      success: true,
      data,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.ceil(total / pageSize),
      },
    });
  } catch (e) {
    return jsonResponse({ success: false, error: '服务器错误：' + e.message }, 500);
  }
}

// ===== POST: 创建博客文章（需要登录认证） =====
export async function onRequestPost(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定，请在 Cloudflare Pages 设置中绑定 D1 数据库' }, 500);
  }

  try {
    const { env, request } = context;

    // 鉴权：任何已登录用户都可以发布博客
    const authUserId = await getAuthUserId(env, request);
    if (!authUserId) {
      return jsonResponse({ success: false, error: '请先登录后再发布博客' }, 403);
    }

    const body = await request.json().catch(() => ({}));
    const { title, content, summary, cover_image, tags, author_id } = body;

    // 基本验证
    if (!title || !String(title).trim()) {
      return jsonResponse({ success: false, error: '标题不能为空' });
    }
    if (!content || !String(content).trim()) {
      return jsonResponse({ success: false, error: '内容不能为空' });
    }

    // 从 users 表获取作者信息（以认证用户为准）
    const user = await env.DB.prepare(
      `SELECT id, name, avatar, doubao_id FROM users WHERE id = ?`
    ).bind(authUserId).first();

    if (!user) {
      return jsonResponse({ success: false, error: '用户信息不存在' }, 403);
    }

    // 净化 HTML 内容
    const cleanTitle = sanitizeHtml(title);
    const cleanContent = sanitizeHtml(content);
    const cleanSummary = summary ? sanitizeHtml(summary) : '';
    // tags 序列化为 JSON 字符串
    const tagsStr = Array.isArray(tags) ? JSON.stringify(tags) : (tags || '[]');

    // 插入博客文章
    const result = await env.DB.prepare(
      `INSERT INTO blog_posts (title, content, summary, cover_image, tags, author_id, author_name, author_avatar, author_doubao_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')`
    ).bind(
      cleanTitle, cleanContent, cleanSummary, cover_image || null, tagsStr,
      user.id, user.name, user.avatar || null, user.doubao_id || null
    ).run();

    const postId = result.meta.last_row_id;

    // 查询完整的博客文章
    let post = await env.DB.prepare(
      `SELECT * FROM blog_posts WHERE id = ?`
    ).bind(postId).first();

    if (!post) {
      return jsonResponse({ success: false, error: '创建后查询失败' }, 500);
    }

    // 记录发布时间戳（仅更新数据库，不调用外部 API）
    await recordPublish(env, post.id);

    // 格式化响应
    post.tags = safeParseTags(post.tags);
    post.created_at = formatDate(post.created_at);
    post.updated_at = formatDate(post.updated_at);

    return jsonResponse({ success: true, data: post });
  } catch (e) {
    return jsonResponse({ success: false, error: '发布失败：' + e.message }, 500);
  }
}
