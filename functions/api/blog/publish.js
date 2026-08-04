// Cloudflare Pages Function - Blog Publish Status
// POST /api/blog/publish  - 记录博客发布状态，返回聊天室链接
//
// 简化版：不调用 Matrix API，仅返回房间 URL 供用户访问


const BLOG_ROOM_URL = 'https://chat.freserafim.com/zh-CN/rooms/b9d7d6e7-191f-408b-b308-b210dbe1a764';

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

async function isDeveloper(env, userId) {
  if (!env || !env.DB || !userId) return false;
  const user = await env.DB.prepare(
    `SELECT is_developer FROM users WHERE id = ?`
  ).bind(userId).first();
  if (!user) return false;
  return user.is_developer === 1 || user.is_developer === '1' || user.is_developer === true;
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

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
    const { post_id } = body;

    if (!post_id) {
      return jsonResponse({ success: false, error: '缺少 post_id' });
    }

    const post = await env.DB.prepare(
      `SELECT id, title, author_id, matrix_room_url FROM blog_posts WHERE id = ?`
    ).bind(post_id).first();

    if (!post) {
      return jsonResponse({ success: false, error: '博客文章不存在' }, 404);
    }

    const isAuthor = post.author_id === authUserId;
    const isDev = await isDeveloper(env, authUserId);
    if (!isAuthor && !isDev) {
      return jsonResponse({ success: false, error: '无权操作' }, 403);
    }

    // 更新发布时间
    await env.DB.prepare(
      `UPDATE blog_posts SET updated_at = datetime('now') WHERE id = ?`
    ).bind(post_id).run();

    return jsonResponse({
      success: true,
      data: {
        post_id: post_id,
        room_url: post.matrix_room_url || BLOG_ROOM_URL,
      },
      message: '文章已记录，可通过聊天室链接分享',
    });
  } catch (e) {
    return jsonResponse({ success: false, error: '操作失败：' + e.message }, 500);
  }
}
