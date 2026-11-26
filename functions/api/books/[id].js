// Cloudflare Pages Function - 单本书籍（V15.0）
// GET    /api/books/:id?with_chapters=1   书籍详情（含章节目录；正文按需取，不随目录返回）
// PUT    /api/books/:id                   更新书籍元数据（作者本人或管理员）
// DELETE /api/books/:id                   删除书籍及全部章节（作者本人或管理员）

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
function safeParseTags(t) {
  if (!t) return []; if (Array.isArray(t)) return t;
  try { const p = JSON.parse(t); return Array.isArray(p) ? p : []; } catch { return []; }
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
    const { env, request } = context;
    const url = new URL(request.url);
    const id = parseInt(context.params.id, 10);
    if (!id) return jsonResponse({ success: false, error: '书籍 ID 无效' }, 400);

    const book = await env.DB.prepare(`SELECT * FROM books WHERE id = ?`).bind(id).first();
    if (!book) return jsonResponse({ success: false, error: '书籍不存在' }, 404);

    const authUserId = await getAuthUserId(env, request);
    const isDev = authUserId ? await isDeveloper(env, authUserId) : false;
    const isAuthor = authUserId && book.author_id === authUserId;
    if (book.status !== 'published' && !isDev && !isAuthor) {
      return jsonResponse({ success: false, error: '该书籍尚未公开' }, 403);
    }

    await env.DB.prepare(`UPDATE books SET views = views + 1 WHERE id = ?`).bind(id).run();

    const withChapters = url.searchParams.get('with_chapters') === '1';
    let chapters = [];
    if (withChapters) {
      // 目录只返回标题/no/id，不返回正文（正文走章节详情接口按需加载）
      const r = await env.DB.prepare(
        `SELECT id, chapter_no, title, views, created_at, updated_at FROM book_chapters WHERE book_id = ? ORDER BY chapter_no ASC`
      ).bind(id).all();
      chapters = (r.results || []).map(function (c) { return { ...c, created_at: formatDate(c.created_at), updated_at: formatDate(c.updated_at) }; });
    }
    const chapterCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM book_chapters WHERE book_id = ?`).bind(id).first();
    book.tags = safeParseTags(book.tags);
    book.created_at = formatDate(book.created_at);
    book.updated_at = formatDate(book.updated_at);
    return jsonResponse({ success: true, data: { ...book, chapter_count: chapterCount ? chapterCount.n : 0, chapters } });
  } catch (e) {
    return jsonResponse({ success: false, error: '服务器错误' }, 500);
  }
}

export async function onRequestPut(context) {
  if (!context.env || !context.env.DB) return jsonResponse({ success: false, error: '数据库未绑定' }, 500);
  try {
    const { env, request } = context;
    const authUserId = await getAuthUserId(env, request);
    if (!authUserId) return jsonResponse({ success: false, error: '请先登录' }, 403);
    const id = parseInt(context.params.id, 10);
    const book = await env.DB.prepare(`SELECT * FROM books WHERE id = ?`).bind(id).first();
    if (!book) return jsonResponse({ success: false, error: '书籍不存在' }, 404);
    const isDev = await isDeveloper(env, authUserId);
    if (book.author_id !== authUserId && !isDev) return jsonResponse({ success: false, error: '无权修改此书籍' }, 403);

    const body = await request.json().catch(() => ({}));
    const updates = [], values = [];
    const fields = ['title', 'summary', 'cover_image', 'category', 'tags', 'status'];
    fields.forEach(function (f) {
      if (body[f] === undefined) return;
      let v = body[f];
      if (f === 'tags') v = Array.isArray(v) ? JSON.stringify(v) : JSON.stringify(safeParseTags(v));
      else if (typeof v === 'string') v = sanitizeHtml(v.trim());
      updates.push(f + ' = ?'); values.push(v);
    });
    if (!updates.length) return jsonResponse({ success: false, error: '没有要更新的字段' });
    updates.push("updated_at = datetime('now')");
    values.push(id);
    await env.DB.prepare(`UPDATE books SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
    return jsonResponse({ success: true, message: '已保存' });
  } catch (e) {
    return jsonResponse({ success: false, error: '保存失败' }, 500);
  }
}

export async function onRequestDelete(context) {
  if (!context.env || !context.env.DB) return jsonResponse({ success: false, error: '数据库未绑定' }, 500);
  try {
    const { env, request } = context;
    const authUserId = await getAuthUserId(env, request);
    if (!authUserId) return jsonResponse({ success: false, error: '请先登录' }, 403);
    const id = parseInt(context.params.id, 10);
    const book = await env.DB.prepare(`SELECT author_id FROM books WHERE id = ?`).bind(id).first();
    if (!book) return jsonResponse({ success: false, error: '书籍不存在' }, 404);
    const isDev = await isDeveloper(env, authUserId);
    if (book.author_id !== authUserId && !isDev) return jsonResponse({ success: false, error: '无权删除此书籍' }, 403);
    await env.DB.prepare(`DELETE FROM book_chapters WHERE book_id = ?`).bind(id).run();
    await env.DB.prepare(`DELETE FROM books WHERE id = ?`).bind(id).run();
    return jsonResponse({ success: true, message: '书籍已删除' });
  } catch (e) {
    return jsonResponse({ success: false, error: '删除失败' }, 500);
  }
}
