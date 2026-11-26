// Cloudflare Pages Function - 章节列表 / 新增章节（V15.0）
// GET  /api/books/:id/chapters         章节目录（id/no/标题，不含正文）
// POST /api/books/:id/chapters         新增章节（作者本人或管理员）
// body: { title, content, chapter_no? }   chapter_no 省略则自动取当前最大号+1

import { ensureBooksSchema } from '../../_lib/books-schema.js';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
async function getAuthUserId(env, request) {
  if (!env || !env.DB || !request) return null;
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const s = await env.DB.prepare(`SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`).bind(token).first();
  return s ? s.user_id : null;
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
    const id = parseInt(context.params.id, 10);
    const r = await context.env.DB.prepare(
      `SELECT id, chapter_no, title, views, created_at, updated_at FROM book_chapters WHERE book_id = ? ORDER BY chapter_no ASC`
    ).bind(id).all();
    const data = (r.results || []).map(function (c) { return { ...c, created_at: formatDate(c.created_at), updated_at: formatDate(c.updated_at) }; });
    return jsonResponse({ success: true, data });
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
    if (!authUserId) return jsonResponse({ success: false, error: '请先登录' }, 403);
    const id = parseInt(context.params.id, 10);
    const book = await env.DB.prepare(`SELECT author_id FROM books WHERE id = ?`).bind(id).first();
    if (!book) return jsonResponse({ success: false, error: '书籍不存在' }, 404);
    const isDev = await isDeveloper(env, authUserId);
    if (book.author_id !== authUserId && !isDev) return jsonResponse({ success: false, error: '无权为此书添加章节' }, 403);

    const body = await request.json().catch(() => ({}));
    const title = String(body.title || '').trim();
    const content = String(body.content || '').trim();
    if (!title) return jsonResponse({ success: false, error: '章节标题不能为空' });
    if (!content) return jsonResponse({ success: false, error: '章节内容不能为空' });

    let chapterNo = parseInt(body.chapter_no, 10);
    if (!chapterNo || chapterNo < 1) {
      const maxRow = await env.DB.prepare(`SELECT MAX(chapter_no) AS n FROM book_chapters WHERE book_id = ?`).bind(id).first();
      chapterNo = (maxRow && maxRow.n ? maxRow.n : 0) + 1;
    }
    const dup = await env.DB.prepare(`SELECT id FROM book_chapters WHERE book_id = ? AND chapter_no = ?`).bind(id, chapterNo).first();
    if (dup) return jsonResponse({ success: false, error: '第 ' + chapterNo + ' 章已存在' });

    const result = await env.DB.prepare(
      `INSERT INTO book_chapters (book_id, chapter_no, title, content) VALUES (?, ?, ?, ?)`
    ).bind(id, chapterNo, sanitizeHtml(title), sanitizeHtml(content)).run();
    await env.DB.prepare(`UPDATE books SET updated_at = datetime('now') WHERE id = ?`).bind(id).run();

    const chapter = await env.DB.prepare(`SELECT id, chapter_no, title, views, created_at, updated_at FROM book_chapters WHERE id = ?`).bind(result.meta.last_row_id).first();
    chapter.created_at = formatDate(chapter.created_at);
    chapter.updated_at = formatDate(chapter.updated_at);
    return jsonResponse({ success: true, data: chapter, message: '章节已添加' });
  } catch (e) {
    return jsonResponse({ success: false, error: '添加章节失败' }, 500);
  }
}
