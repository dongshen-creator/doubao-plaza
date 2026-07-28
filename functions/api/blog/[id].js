// Cloudflare Pages Function - Single Blog Post API
// GET    /api/blog/[id]  - 获取单篇博客文章（含完整 content），并增加 views 计数
// PUT    /api/blog/[id]  - 更新博客文章（仅作者本人或开发者可操作；支持 category_id 更新）
// PATCH  /api/blog/[id]  - 审核操作（仅开发者）：approve 通过 / reject 驳回
// DELETE /api/blog/[id]  - 删除博客文章（仅作者本人或开发者可操作，同时删除关联评论）

// ===== 常量 =====
const DEV_IDS = ['470208447', 'East_pairs'];

// ===== 通用辅助函数 =====

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
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
  if (user.is_developer === 1 || user.is_developer === '1' || user.is_developer === true) return true;
  if (user.doubao_id && DEV_IDS.includes(user.doubao_id)) return true;
  return false;
}

// 简单 HTML 净化：移除 <script> 标签和 on* 事件属性
function sanitizeHtml(html) {
  if (!html) return '';
  let cleaned = String(html);
  cleaned = cleaned.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  cleaned = cleaned.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  cleaned = cleaned.replace(/(href|src)\s*=\s*(["'])javascript:[^"']*\2/gi, '$1=$2#$2', cleaned);
  return cleaned;
}

// 从 context.params.id 取出文章 ID（注意可能是数组，取第一项）
function getPostId(context) {
  let id = context.params && context.params.id;
  if (Array.isArray(id)) id = id[0];
  return id || null;
}

// ===== 预检请求 =====
export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

// ===== GET: 获取单篇博客文章（含完整 content），并增加 views =====
export async function onRequestGet(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定，请在 Cloudflare Pages 设置中绑定 D1 数据库' }, 500);
  }

  try {
    const { env } = context;
    const postId = getPostId(context);

    if (!postId) {
      return jsonResponse({ success: false, error: '缺少博客文章 ID' });
    }

    // 查询博客文章（含完整 content）
    const post = await env.DB.prepare(
      `SELECT * FROM blog_posts WHERE id = ?`
    ).bind(postId).first();

    if (!post) {
      return jsonResponse({ success: false, error: '博客文章不存在' }, 404);
    }

    // 增加 views 计数
    await env.DB.prepare(
      `UPDATE blog_posts SET views = views + 1 WHERE id = ?`
    ).bind(postId).run();

    // 格式化响应
    post.tags = safeParseTags(post.tags);
    post.created_at = formatDate(post.created_at);
    post.updated_at = formatDate(post.updated_at);
    post.views = (post.views || 0) + 1;

    return jsonResponse({ success: true, data: post });
  } catch (e) {
    return jsonResponse({ success: false, error: '服务器错误：' + e.message }, 500);
  }
}

// ===== PUT: 更新博客文章（仅作者本人或开发者可操作） =====
export async function onRequestPut(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定，请在 Cloudflare Pages 设置中绑定 D1 数据库' }, 500);
  }

  try {
    const { env, request } = context;
    const postId = getPostId(context);

    if (!postId) {
      return jsonResponse({ success: false, error: '缺少博客文章 ID' });
    }

    // 鉴权
    const authUserId = await getAuthUserId(env, request);
    if (!authUserId) {
      return jsonResponse({ success: false, error: '请先登录' }, 403);
    }

    // 查询博客文章，确认存在并获取作者
    const post = await env.DB.prepare(
      `SELECT id, author_id FROM blog_posts WHERE id = ?`
    ).bind(postId).first();

    if (!post) {
      return jsonResponse({ success: false, error: '博客文章不存在' }, 404);
    }

    // 权限检查：仅作者本人或开发者可操作
    const isAuthor = post.author_id === authUserId;
    const isDev = await isDeveloper(env, authUserId);
    if (!isAuthor && !isDev) {
      return jsonResponse({ success: false, error: '无权操作，仅作者本人或开发者可编辑' }, 403);
    }

    const body = await request.json().catch(() => ({}));
    const { title, content, summary, cover_image, tags, status, category_id } = body;

    // 构建动态更新字段
    const updates = [];
    const params = [];

    if (title !== undefined) {
      const cleanTitle = sanitizeHtml(title);
      if (!cleanTitle.trim()) {
        return jsonResponse({ success: false, error: '标题不能为空' });
      }
      updates.push('title = ?');
      params.push(cleanTitle);
    }
    if (content !== undefined) {
      const cleanContent = sanitizeHtml(content);
      if (!cleanContent.trim()) {
        return jsonResponse({ success: false, error: '内容不能为空' });
      }
      updates.push('content = ?');
      params.push(cleanContent);
    }
    if (summary !== undefined) {
      updates.push('summary = ?');
      params.push(sanitizeHtml(summary));
    }
    if (cover_image !== undefined) {
      updates.push('cover_image = ?');
      params.push(cover_image || null);
    }
    if (tags !== undefined) {
      updates.push('tags = ?');
      params.push(Array.isArray(tags) ? JSON.stringify(tags) : (tags || '[]'));
    }

    // status 更新规则：
    // - 普通用户：不能通过 PUT 改 status（始终忽略）
    // - 开发者编辑他人文章：不能改 status（请使用 PATCH 审核接口）
    // - 开发者编辑自己文章：可以改 status
    const allowStatusChange = isDev && isAuthor;
    if (status !== undefined && allowStatusChange) {
      if (['pending', 'published', 'rejected'].includes(status)) {
        updates.push('status = ?');
        params.push(status);
        // 改为 published 时清空驳回理由
        if (status === 'published') {
          updates.push('reject_reason = ?');
          params.push('');
        }
      }
    }

    // category_id 更新：传 0/null/空字符串 表示移除分类
    if (category_id !== undefined) {
      if (category_id === null || category_id === '' || String(category_id) === '0') {
        updates.push('category_id = ?');
        params.push(null);
      } else {
        const catId = parseInt(category_id, 10);
        if (!isNaN(catId)) {
          const cat = await env.DB.prepare(
            `SELECT id FROM blog_categories WHERE id = ?`
          ).bind(catId).first();
          if (!cat) {
            return jsonResponse({ success: false, error: '所选分类不存在' });
          }
          updates.push('category_id = ?');
          params.push(catId);
        }
      }
    }

    if (updates.length === 0) {
      return jsonResponse({ success: false, error: '没有需要更新的字段' });
    }

    // 添加 updated_at
    updates.push("updated_at = datetime('now')");
    params.push(postId);

    await env.DB.prepare(
      `UPDATE blog_posts SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...params).run();

    // 查询更新后的文章
    const updatedPost = await env.DB.prepare(
      `SELECT * FROM blog_posts WHERE id = ?`
    ).bind(postId).first();

    updatedPost.tags = safeParseTags(updatedPost.tags);
    updatedPost.created_at = formatDate(updatedPost.created_at);
    updatedPost.updated_at = formatDate(updatedPost.updated_at);

    return jsonResponse({ success: true, data: updatedPost });
  } catch (e) {
    return jsonResponse({ success: false, error: '更新失败：' + e.message }, 500);
  }
}

// ===== PATCH: 审核操作（仅开发者） =====
// body: { action: 'approve' | 'reject', reason?: string }
// approve -> status='published', reject_reason=''
// reject  -> status='rejected', reject_reason=reason
export async function onRequestPatch(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定，请在 Cloudflare Pages 设置中绑定 D1 数据库' }, 500);
  }

  try {
    const { env, request } = context;
    const postId = getPostId(context);

    if (!postId) {
      return jsonResponse({ success: false, error: '缺少博客文章 ID' });
    }

    // 鉴权
    const authUserId = await getAuthUserId(env, request);
    if (!authUserId) {
      return jsonResponse({ success: false, error: '请先登录' }, 403);
    }

    // 仅开发者可审核
    const isDev = await isDeveloper(env, authUserId);
    if (!isDev) {
      return jsonResponse({ success: false, error: '无权操作，仅开发者可审核文章' }, 403);
    }

    // 查询文章是否存在
    const post = await env.DB.prepare(
      `SELECT id, status FROM blog_posts WHERE id = ?`
    ).bind(postId).first();

    if (!post) {
      return jsonResponse({ success: false, error: '博客文章不存在' }, 404);
    }

    const body = await request.json().catch(() => ({}));
    const { action, reason } = body;

    if (!action) {
      return jsonResponse({ success: false, error: '缺少 action 参数（approve 或 reject）' });
    }

    if (action === 'approve') {
      // 通过审核：status -> published，清空驳回理由
      await env.DB.prepare(
        `UPDATE blog_posts SET status = 'published', reject_reason = '', updated_at = datetime('now') WHERE id = ?`
      ).bind(postId).run();
    } else if (action === 'reject') {
      // 驳回：需要 reason
      if (!reason || !String(reason).trim()) {
        return jsonResponse({ success: false, error: '驳回需要提供 reason 字段' });
      }
      await env.DB.prepare(
        `UPDATE blog_posts SET status = 'rejected', reject_reason = ?, updated_at = datetime('now') WHERE id = ?`
      ).bind(String(reason).trim(), postId).run();
    } else {
      return jsonResponse({ success: false, error: '无效的 action，仅支持 approve 或 reject' });
    }

    // 查询更新后的文章
    const updatedPost = await env.DB.prepare(
      `SELECT * FROM blog_posts WHERE id = ?`
    ).bind(postId).first();

    updatedPost.tags = safeParseTags(updatedPost.tags);
    updatedPost.created_at = formatDate(updatedPost.created_at);
    updatedPost.updated_at = formatDate(updatedPost.updated_at);

    const message = action === 'approve' ? '文章已通过审核并发布' : '文章已驳回';

    return jsonResponse({ success: true, data: updatedPost, message });
  } catch (e) {
    return jsonResponse({ success: false, error: '审核操作失败：' + e.message }, 500);
  }
}

// ===== DELETE: 删除博客文章（仅作者本人或开发者可操作，同时删除关联评论） =====
export async function onRequestDelete(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定，请在 Cloudflare Pages 设置中绑定 D1 数据库' }, 500);
  }

  try {
    const { env, request } = context;
    const postId = getPostId(context);

    if (!postId) {
      return jsonResponse({ success: false, error: '缺少博客文章 ID' });
    }

    // 鉴权
    const authUserId = await getAuthUserId(env, request);
    if (!authUserId) {
      return jsonResponse({ success: false, error: '请先登录' }, 403);
    }

    // 查询博客文章，确认存在并获取作者
    const post = await env.DB.prepare(
      `SELECT id, author_id FROM blog_posts WHERE id = ?`
    ).bind(postId).first();

    if (!post) {
      return jsonResponse({ success: false, error: '博客文章不存在' }, 404);
    }

    // 权限检查：仅作者本人或开发者可操作
    const isAuthor = post.author_id === authUserId;
    const isDev = await isDeveloper(env, authUserId);
    if (!isAuthor && !isDev) {
      return jsonResponse({ success: false, error: '无权操作，仅作者本人或开发者可删除' }, 403);
    }

    // 删除关联评论
    await env.DB.prepare(
      `DELETE FROM blog_comments WHERE post_id = ?`
    ).bind(postId).run();

    // 删除博客文章
    await env.DB.prepare(
      `DELETE FROM blog_posts WHERE id = ?`
    ).bind(postId).run();

    return jsonResponse({ success: true, message: '博客文章已删除' });
  } catch (e) {
    return jsonResponse({ success: false, error: '删除失败：' + e.message }, 500);
  }
}
