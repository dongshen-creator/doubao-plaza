// Cloudflare Pages Function - Blog Comments API
// GET    /api/blog/comments?post_id=xxx  - 获取某篇文章的评论列表（按 created_at 排序）
// POST   /api/blog/comments              - 添加评论（需要登录认证）
// DELETE /api/blog/comments?id=xxx       - 删除评论（评论作者/博客作者/开发者可删除）

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

// ===== GET: 获取某篇文章的评论列表（按 created_at 排序） =====
export async function onRequestGet(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定，请在 Cloudflare Pages 设置中绑定 D1 数据库' }, 500);
  }

  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const postId = url.searchParams.get('post_id');

    if (!postId) {
      return jsonResponse({ success: false, error: '缺少 post_id 参数' });
    }

    // 按 created_at 排序，置顶评论优先
    const results = await env.DB.prepare(
      `SELECT id, post_id, user_id, user_name, user_avatar, content, parent_id, pinned, created_at
       FROM blog_comments
       WHERE post_id = ?
       ORDER BY pinned DESC, created_at ASC`
    ).bind(postId).all();

    const data = (results.results || []).map(r => ({
      ...r,
      created_at: formatDate(r.created_at),
    }));

    return jsonResponse({ success: true, data });
  } catch (e) {
    return jsonResponse({ success: false, error: '服务器错误：' + e.message }, 500);
  }
}

// ===== POST: 添加评论（需要登录认证） =====
export async function onRequestPost(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定，请在 Cloudflare Pages 设置中绑定 D1 数据库' }, 500);
  }

  try {
    const { env, request } = context;

    // 鉴权
    const authUserId = await getAuthUserId(env, request);
    if (!authUserId) {
      return jsonResponse({ success: false, error: '请先登录后再评论' }, 403);
    }

    const body = await request.json().catch(() => ({}));
    const { post_id, content, parent_id } = body;

    // 基本验证
    if (!post_id) {
      return jsonResponse({ success: false, error: '缺少 post_id（文章 ID）' });
    }
    if (!content || !String(content).trim()) {
      return jsonResponse({ success: false, error: '评论内容不能为空' });
    }

    // 验证文章是否存在
    const post = await env.DB.prepare(
      `SELECT id FROM blog_posts WHERE id = ?`
    ).bind(post_id).first();
    if (!post) {
      return jsonResponse({ success: false, error: '文章不存在' }, 404);
    }

    // 从 users 表获取用户信息
    const user = await env.DB.prepare(
      `SELECT id, name, avatar FROM users WHERE id = ?`
    ).bind(authUserId).first();
    if (!user) {
      return jsonResponse({ success: false, error: '用户信息不存在' }, 403);
    }

    // 插入评论
    const result = await env.DB.prepare(
      `INSERT INTO blog_comments (post_id, user_id, user_name, user_avatar, content, parent_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      post_id, user.id, user.name, user.avatar || null,
      String(content).trim(), parent_id || 0
    ).run();

    // 查询新创建的评论
    const comment = await env.DB.prepare(
      `SELECT id, post_id, user_id, user_name, user_avatar, content, parent_id, pinned, created_at
       FROM blog_comments WHERE id = ?`
    ).bind(result.meta.last_row_id).first();

    comment.created_at = formatDate(comment.created_at);

    return jsonResponse({ success: true, data: comment });
  } catch (e) {
    return jsonResponse({ success: false, error: '评论失败：' + e.message }, 500);
  }
}

// ===== DELETE: 删除评论（评论作者/博客作者/开发者可删除） =====
export async function onRequestDelete(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定，请在 Cloudflare Pages 设置中绑定 D1 数据库' }, 500);
  }

  try {
    const { env, request } = context;
    const url = new URL(context.request.url);
    const commentId = url.searchParams.get('id');

    if (!commentId) {
      return jsonResponse({ success: false, error: '缺少评论 ID（id 参数）' });
    }

    // 鉴权
    const authUserId = await getAuthUserId(env, request);
    if (!authUserId) {
      return jsonResponse({ success: false, error: '请先登录' }, 403);
    }

    // 查询评论，获取评论作者和关联文章
    const comment = await env.DB.prepare(
      `SELECT id, post_id, user_id FROM blog_comments WHERE id = ?`
    ).bind(commentId).first();

    if (!comment) {
      return jsonResponse({ success: false, error: '评论不存在' }, 404);
    }

    // 权限检查：评论作者本人、博客文章作者、开发者都可以删除
    const isCommentAuthor = comment.user_id === authUserId;
    const isDev = await isDeveloper(env, authUserId);

    let isBlogAuthor = false;
    if (!isCommentAuthor && !isDev) {
      // 查询博客文章作者
      const post = await env.DB.prepare(
        `SELECT author_id FROM blog_posts WHERE id = ?`
      ).bind(comment.post_id).first();
      isBlogAuthor = post && post.author_id === authUserId;
    }

    if (!isCommentAuthor && !isBlogAuthor && !isDev) {
      return jsonResponse({ success: false, error: '无权操作，仅评论作者、博客作者或开发者可删除评论' }, 403);
    }

    // 删除评论
    await env.DB.prepare(
      `DELETE FROM blog_comments WHERE id = ?`
    ).bind(commentId).run();

    return jsonResponse({ success: true, message: '评论已删除' });
  } catch (e) {
    return jsonResponse({ success: false, error: '删除失败：' + e.message }, 500);
  }
}
