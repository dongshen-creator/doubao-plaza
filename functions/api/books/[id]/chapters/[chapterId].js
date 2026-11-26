// Cloudflare Pages Function - 单章节详情 / 更新 / 删除（V15.0）
// GET    /api/books/:id/chapters/:chapterId   章节正文（浏览量+1）
// PUT    /api/books/:id/chapters/:chapterId   更新章节（作者本人或管理员）
// DELETE /api/books/:id/chapters/:chapterId   删除章节（作者本人或管理员）

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
    const id = parseInt(context.params.id, 10);
    const chapterId = parseInt(context.params.chapterId, 10);
    const ch = await context.env.DB.prepare(
      `SELECT * FROM book_chapters WHERE id = ? AND book_id = ?`
    ).bind(chapterId, id).first();
    if (!ch) return jsonResponse({ success: false, error: '章节不存在' }, 404);
    await context.env.DB.prepare(`UPDATE book_chapters SET views = views + 1 WHERE id = ?`).bind(chapterId).run();
    ch.created_at = formatDate(ch.created_at);
    ch.updated_at = formatDate(ch.updated_at);
    return jsonResponse({ success: true, data: ch });
  } catch (e) {
    return jsonResponse({ success: false, error: '服务器错误' }, 500);
  }
}

async function canEdit(env, request, bookId) {
  const authUserId = await getAuthUserId(env, request);
  if (!authUserId) return { ok: false, code: 403, error: '请先登录' };
  const book = await env.DB.prepare(`SELECT author_id FROM books WHERE id = ?`).bind(bookId).first();
  if (!book) return { ok: false, code: 404, error: '书籍不存在' };
  const isDev = await isDeveloper(env, authUserId);
  if (book.author_id !== authUserId && !isDev) return { ok: false, code: 403, error: '无权操作' };
  return { ok: true };
}

export async function onRequestPut(context) {
  if (!context.env || !context.env.DB) return jsonResponse({ success: false, error: '数据库未绑定' }, 500);
  try {
    const { env, request } = context;
    const bookId = parseInt(context.params.id, 10);
    const chapterId = parseInt(context.params.chapterId, 10);
    const perm = await canEdit(env, request, bookId);
    if (!perm.ok) return jsonResponse({ success: false, error: perm.error }, perm.code);
    const ch = await env.DB.prepare(`SELECT id FROM book_chapters WHERE id = ? AND book_id = ?`).bind(chapterId, bookId).first();
    if (!ch) return jsonResponse({ success: false, error: '章节不存在' }, 404);

    const body = await request.json().catch(() => ({}));
    const updates = [], values = [];
    if (body.title !== undefined) { updates.push('title = ?'); values.push(sanitizeHtml(String(body.title).trim())); }
    if (body.content !== undefined) { updates.push('content = ?'); values.push(sanitizeHtml(String(body.content))); }
    if (body.chapter_no !== undefined) {
      const no = parseInt(body.chapter_no, 10);
      if (no >= 1) {
        const dup = await env.DB.prepare(`SELECT id FROM book_chapters WHERE book_id = ? AND chapter_no = ? AND id != ?`).bind(bookId, no, chapterId).first();
        if (dup) return jsonResponse({ success: false, error: '第 ' + no + ' 章已存在' });
        updates.push('chapter_no = ?'); values.push(no);
      }
    }
    if (!updates.length) return jsonResponse({ success: false, error: '没有要更新的字段' });
    updates.push("updated_at = datetime('now')");
    values.push(chapterId);
    await env.DB.prepare(`UPDATE book_chapters SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
    return jsonResponse({ success: true, message: '章节已保存' });
  } catch (e) {
    return jsonResponse({ success: false, error: '保存失败' }, 500);
  }
}

export async function onRequestDelete(context) {
  if (!context.env || !context.env.DB) return jsonResponse({ success: false, error: '数据库未绑定' }, 500);
  try {
    const { env, request } = context;
    const bookId = parseInt(context.params.id, 10);
    const chapterId = parseInt(context.params.chapterId, 10);
    const perm = await canEdit(env, request, bookId);
    if (!perm.ok) return jsonResponse({ success: false, error: perm.error }, perm.code);
    await env.DB.prepare(`DELETE FROM book_chapters WHERE id = ? AND book_id = ?`).bind(chapterId, bookId).run();
    return jsonResponse({ success: true, message: '章节已删除' });
  } catch (e) {
    return jsonResponse({ success: false, error: '删除失败' }, 500);
  }
}
