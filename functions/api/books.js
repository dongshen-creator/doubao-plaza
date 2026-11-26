// Cloudflare Pages Function - 书籍列表 / 创建（V15.0，独立于小肥羊讲堂文章）
// GET  /api/books?search=&page=&page_size=&author_id=&status=   书籍列表（分页，返回摘要含章节数，不含章节正文）
// POST /api/books                                              创建书籍（需登录；开发者直接 published，普通用户 pending）
//
// 数据模型：books（书籍元数据）+ book_chapters（章节）。与 blog_posts 完全独立。

import { ensureBooksSchema } from './_lib/books-schema.js';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
}
function formatDate(d) {
  if (!d || typeof d !== 'string') return d;
  if (d.includes('T')) return d;
  return d.replace(' ', 'T') + 'Z';
}
function safeParseTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags;
  try { const p = JSON.parse(tags); return Array.isArray(p) ? p : []; } catch { return []; }
}
async function getAuthUserId(env, request) {
  if (!env || !env.DB || !request) return null;
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const session = await env.DB.prepare(`SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`).bind(token).first();
  return session ? session.user_id : null;
}
async function isDeveloper(env, userId) {
  if (!env || !env.DB || !userId) return false;
  const u = await env.DB.prepare(`SELECT is_developer, is_global_admin FROM users WHERE id = ?`).bind(userId).first();
  if (!u) return false;
  return u.is_developer == 1 || u.is_global_admin == 1;
}
function sanitizeHtml(html) {
  if (!html) return '';
  let c = String(html);
  c = c.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  c = c.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  c = c.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  c = c.replace(/(href|src)\s*=\s*(["'])javascript:[^"']*\2/gi, '$1=$2#$2');
  return c;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet(context) {
  if (!context.env || !context.env.DB) return jsonResponse({ success: false, error: '数据库未绑定' }, 500);
  try {
    await ensureBooksSchema(context.env);
    const { env, request } = context;
    const url = new URL(request.url);
    const search = url.searchParams.get('search') || '';
    const page = Math.max(parseInt(url.searchParams.get('page') || '1', 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(url.searchParams.get('page_size') || url.searchParams.get('pageSize') || '12', 10) || 12, 1), 50);
    const offset = (page - 1) * pageSize;

    const authUserId = await getAuthUserId(env, request);
    const isDev = authUserId ? await isDeveloper(env, authUserId) : false;

    let where = 'WHERE b.status = ?';
    const params = ['published'];
    const statusParam = url.searchParams.get('status');
    if (isDev && statusParam) {
      if (statusParam === 'all') { where = 'WHERE 1=1'; params.length = 0; }
      else if (['pending', 'rejected', 'published'].includes(statusParam)) { where = 'WHERE b.status = ?'; params[0] = statusParam; }
    }
    const authorId = url.searchParams.get('author_id');
    if (authorId) { where += ' AND b.author_id = ?'; params.push(authorId); }
    if (search) { where += ' AND b.title LIKE ?'; params.push('%' + search + '%'); }

    const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM books b ${where}`).bind(...params).first();
    const total = countRow ? countRow.total : 0;

    const results = await env.DB.prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM book_chapters c WHERE c.book_id = b.id) AS chapter_count
       FROM books b ${where}
       ORDER BY b.created_at DESC LIMIT ? OFFSET ?`
    ).bind(...params, pageSize, offset).all();

    const data = (results.results || []).map(function (r) {
      return { ...r, tags: safeParseTags(r.tags), created_at: formatDate(r.created_at), updated_at: formatDate(r.updated_at) };
    });
    return jsonResponse({ success: true, data, pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) } });
  } catch (e) {
    return jsonResponse({ success: false, error: '服务器错误' }, 500);
  }
}

export async function onRequestPost(context) {
  if (!context.env || !context.env.DB) return jsonResponse({ success: false, error: '数据库未绑定' }, 500);
  try {
    await ensureBooksSchema(context.env);
    const { env, request } = context;
    const authUserId = await getAuthUserId(env, request);
    if (!authUserId) return jsonResponse({ success: false, error: '请先登录后再创建书籍' }, 403);

    const body = await request.json().catch(() => ({}));
    const { title, summary, cover_image, category, tags } = body;
    if (!title || !String(title).trim()) return jsonResponse({ success: false, error: '书名不能为空' });

    const user = await env.DB.prepare(`SELECT id, name, avatar, doubao_id, privacy_setting, punished_until FROM users WHERE id = ?`).bind(authUserId).first();
    if (!user) return jsonResponse({ success: false, error: '用户信息不存在' }, 403);
    if (user.privacy_setting === 'punished_stealth' && (!user.punished_until || user.punished_until > new Date().toISOString())) {
      return jsonResponse({ success: false, error: '您的账号处于惩罚性隐身状态，暂时无法创作' }, 403);
    }

    const isDev = await isDeveloper(env, authUserId);
    const status = isDev ? 'published' : 'pending';

    let safeCover = null;
    if (cover_image && String(cover_image).trim()) {
      try {
        const u = new URL(String(cover_image).trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return jsonResponse({ success: false, error: '封面链接必须以 http(s) 开头' });
        safeCover = String(cover_image).trim();
      } catch { return jsonResponse({ success: false, error: '封面链接格式不正确' }); }
    }

    const result = await env.DB.prepare(
      `INSERT INTO books (title, summary, cover_image, author_id, author_name, author_avatar, author_doubao_id, status, category, tags, reject_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`
    ).bind(
      sanitizeHtml(title), sanitizeHtml(summary || ''), safeCover,
      user.id, user.name, user.avatar || null, user.doubao_id || null,
      status, sanitizeHtml(category || ''), Array.isArray(tags) ? JSON.stringify(tags) : (tags || '[]')
    ).run();

    const book = await env.DB.prepare(`SELECT * FROM books WHERE id = ?`).bind(result.meta.last_row_id).first();
    book.tags = safeParseTags(book.tags);
    book.created_at = formatDate(book.created_at);
    book.updated_at = formatDate(book.updated_at);
    return jsonResponse({
      success: true, data: book, status: book.status,
      message: status === 'pending' ? '书籍已提交，等待审核' : '书籍已创建',
    });
  } catch (e) {
    return jsonResponse({ success: false, error: '创建失败' }, 500);
  }
}
