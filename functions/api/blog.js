// Cloudflare Pages Function - Blog Posts API
// GET  /api/blog                - 获取博客列表（分页，支持 search/category_id/status/author_id 筛选，返回不含 content 的摘要列表）
// POST /api/blog                - 创建博客文章（需要登录认证；开发者发布直接 published，普通用户发布需审核 pending）
//
// 小肥羊讲堂 - 博客系统后端

// ===== 常量 =====

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

// 检查用户是否为开发者（is_developer === 1）
async function isDeveloper(env, userId) {
  if (!env || !env.DB || !userId) return false;
  const user = await env.DB.prepare(
    `SELECT is_developer FROM users WHERE id = ?`
  ).bind(userId).first();
  if (!user) return false;
  return user.is_developer === 1 || user.is_developer === '1' || user.is_developer === true;
}

// 简单 HTML 净化：移除 <script>/<style> 标签和 on* 事件属性
function sanitizeHtml(html) {
  if (!html) return '';
  let cleaned = String(html);
  // 移除 <script>...</script> 标签（含内容）
  cleaned = cleaned.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  // 移除 <style>...</style> 标签（含内容）—— V4 修复：防止 CSS 注入
  cleaned = cleaned.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
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

    // 鉴权：判断是否为开发者（列表接口公开，但开发者可查看更多状态）
    const authUserId = await getAuthUserId(env, context.request);
    const isDev = authUserId ? await isDeveloper(env, authUserId) : false;

    // 构建查询条件
    let whereClause = "WHERE 1=1";
    const params = [];

    // status 筛选：普通用户只能看 published；开发者可查看 pending/rejected/published 或 all
    const statusParam = url.searchParams.get('status');
    if (isDev && statusParam) {
      if (statusParam === 'all') {
        // 开发者查看所有状态，不加 status 条件
      } else if (['pending', 'rejected', 'published'].includes(statusParam)) {
        whereClause += ' AND bp.status = ?';
        params.push(statusParam);
      } else {
        // 非法状态值，回退到 published
        whereClause += ' AND bp.status = ?';
        params.push('published');
      }
    } else {
      // 普通用户（或未传 status）只能看 published
      whereClause += ' AND bp.status = ?';
      params.push('published');
    }

    // category_id 筛选
    const categoryId = url.searchParams.get('category_id');
    if (categoryId !== null && String(categoryId).trim() !== '') {
      whereClause += ' AND bp.category_id = ?';
      params.push(parseInt(categoryId, 10));
    }

    // author_id 筛选（查看某用户的文章）
    const authorId = url.searchParams.get('author_id');
    if (authorId) {
      whereClause += ' AND bp.author_id = ?';
      params.push(authorId);
    }

    // 标题搜索
    if (search) {
      whereClause += ' AND bp.title LIKE ?';
      params.push(`%${search}%`);
    }

    // 获取总数
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) as total FROM blog_posts bp ${whereClause}`
    ).bind(...params).first();
    const total = countRow ? countRow.total : 0;

    // 获取列表（不含 content 字段，LEFT JOIN blog_categories 获取分类名）
    const results = await env.DB.prepare(
      `SELECT bp.id, bp.title, bp.summary, bp.cover_image, bp.tags, bp.author_id, bp.author_name,
              bp.author_avatar, bp.author_doubao_id, bp.status, bp.category_id, bc.name AS category_name,
              bp.reject_reason, bp.views, bp.matrix_event_id, bp.matrix_room_url, bp.created_at, bp.updated_at
       FROM blog_posts bp
       LEFT JOIN blog_categories bc ON bp.category_id = bc.id
       ${whereClause}
       ORDER BY bp.created_at DESC
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
    const { title, content, summary, cover_image, tags, category_id } = body;

    // 基本验证
    if (!title || !String(title).trim()) {
      return jsonResponse({ success: false, error: '标题不能为空' });
    }
    if (!content || !String(content).trim()) {
      return jsonResponse({ success: false, error: '内容不能为空' });
    }

    // 从 users 表获取作者信息（以认证用户为准）
    const user = await env.DB.prepare(
      `SELECT id, name, avatar, doubao_id, privacy_setting, punished_until FROM users WHERE id = ?`
    ).bind(authUserId).first();

    if (!user) {
      return jsonResponse({ success: false, error: '用户信息不存在' }, 403);
    }

    // 惩罚性隐身用户禁止发布博客
    if (user.privacy_setting === 'punished_stealth') {
      const now = new Date().toISOString();
      if (!user.punished_until || user.punished_until > now) {
        return jsonResponse({ success: false, error: '您的账号处于惩罚性隐身状态，暂时无法发布博客' }, 403);
      }
    }

    // 审核逻辑：开发者发布直接 published；普通用户发布需审核（pending）
    const isDev = await isDeveloper(env, authUserId);
    const postStatus = isDev ? 'published' : 'pending';

    // 处理 category_id：若提供则校验分类是否存在
    let categoryIdValue = null;
    if (category_id !== undefined && category_id !== null &&
        String(category_id).trim() !== '' && String(category_id) !== '0') {
      const catId = parseInt(category_id, 10);
      if (!isNaN(catId)) {
        const cat = await env.DB.prepare(
          `SELECT id FROM blog_categories WHERE id = ?`
        ).bind(catId).first();
        if (!cat) {
          return jsonResponse({ success: false, error: '所选分类不存在' });
        }
        categoryIdValue = catId;
      }
    }

    // 净化 HTML 内容
    const cleanTitle = sanitizeHtml(title);
    const cleanContent = sanitizeHtml(content);
    const cleanSummary = summary ? sanitizeHtml(summary) : '';
    // tags 序列化为 JSON 字符串
    const tagsStr = Array.isArray(tags) ? JSON.stringify(tags) : (tags || '[]');

    // 插入博客文章
    const result = await env.DB.prepare(
      `INSERT INTO blog_posts (title, content, summary, cover_image, tags, author_id, author_name, author_avatar, author_doubao_id, status, category_id, reject_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`
    ).bind(
      cleanTitle, cleanContent, cleanSummary, cover_image || null, tagsStr,
      user.id, user.name, user.avatar || null, user.doubao_id || null,
      postStatus, categoryIdValue
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

    // 返回中包含 status，前端据此显示"等待审核"提示
    const message = postStatus === 'pending'
      ? '文章已提交，等待开发者审核'
      : '文章已发布';

    return jsonResponse({ success: true, data: post, status: post.status, message });
  } catch (e) {
    return jsonResponse({ success: false, error: '发布失败：' + e.message }, 500);
  }
}
