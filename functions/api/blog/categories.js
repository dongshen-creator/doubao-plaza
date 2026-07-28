// Cloudflare Pages Function - Blog Categories API
// GET    /api/blog/categories         - 获取所有分类（按 sort_order 排序，含每个分类下的文章数量）公开接口
// POST   /api/blog/categories         - 创建分类（仅开发者）
// PUT    /api/blog/categories?id=xxx  - 更新分类（仅开发者）
// DELETE /api/blog/categories?id=xxx  - 删除分类（仅开发者；该分类下文章 category_id 置 NULL）

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

// ===== GET: 获取所有分类（公开，按 sort_order 排序，含文章数量） =====
export async function onRequestGet(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定，请在 Cloudflare Pages 设置中绑定 D1 数据库' }, 500);
  }

  try {
    const { env } = context;

    // LEFT JOIN blog_posts 统计每个分类下已发布文章数量
    const results = await env.DB.prepare(
      `SELECT bc.id, bc.name, bc.description, bc.sort_order, bc.created_at,
              COUNT(bp.id) AS post_count
       FROM blog_categories bc
       LEFT JOIN blog_posts bp ON bp.category_id = bc.id AND bp.status = 'published'
       GROUP BY bc.id
       ORDER BY bc.sort_order ASC, bc.id ASC`
    ).all();

    const data = (results.results || []).map(r => ({
      ...r,
      post_count: r.post_count || 0,
      created_at: formatDate(r.created_at),
    }));

    return jsonResponse({ success: true, data });
  } catch (e) {
    return jsonResponse({ success: false, error: '服务器错误：' + e.message }, 500);
  }
}

// ===== POST: 创建分类（仅开发者） =====
export async function onRequestPost(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定，请在 Cloudflare Pages 设置中绑定 D1 数据库' }, 500);
  }

  try {
    const { env, request } = context;

    // 鉴权
    const authUserId = await getAuthUserId(env, request);
    if (!authUserId) {
      return jsonResponse({ success: false, error: '请先登录' }, 403);
    }

    // 仅开发者可创建分类
    const isDev = await isDeveloper(env, authUserId);
    if (!isDev) {
      return jsonResponse({ success: false, error: '无权操作，仅开发者可管理分类' }, 403);
    }

    const body = await request.json().catch(() => ({}));
    const { name, description, sort_order } = body;

    // 基本验证
    if (!name || !String(name).trim()) {
      return jsonResponse({ success: false, error: '分类名称不能为空' });
    }

    const nameStr = String(name).trim();
    const descStr = description !== undefined && description !== null ? String(description) : '';
    const sortOrder = sort_order !== undefined ? (parseInt(sort_order, 10) || 0) : 0;

    // 检查分类名是否重复
    const existing = await env.DB.prepare(
      `SELECT id FROM blog_categories WHERE name = ?`
    ).bind(nameStr).first();
    if (existing) {
      return jsonResponse({ success: false, error: '分类名称已存在' });
    }

    // 插入分类
    const result = await env.DB.prepare(
      `INSERT INTO blog_categories (name, description, sort_order) VALUES (?, ?, ?)`
    ).bind(nameStr, descStr, sortOrder).run();

    const catId = result.meta.last_row_id;
    const cat = await env.DB.prepare(
      `SELECT id, name, description, sort_order, created_at FROM blog_categories WHERE id = ?`
    ).bind(catId).first();

    cat.created_at = formatDate(cat.created_at);

    return jsonResponse({ success: true, data: cat, message: '分类已创建' });
  } catch (e) {
    return jsonResponse({ success: false, error: '创建分类失败：' + e.message }, 500);
  }
}

// ===== PUT: 更新分类（仅开发者，通过 ?id= 指定） =====
export async function onRequestPut(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定，请在 Cloudflare Pages 设置中绑定 D1 数据库' }, 500);
  }

  try {
    const { env, request } = context;
    const url = new URL(context.request.url);
    const catIdRaw = url.searchParams.get('id');

    if (!catIdRaw) {
      return jsonResponse({ success: false, error: '缺少分类 ID（id 参数）' });
    }

    const catId = parseInt(catIdRaw, 10);
    if (isNaN(catId)) {
      return jsonResponse({ success: false, error: '分类 ID 无效' });
    }

    // 鉴权
    const authUserId = await getAuthUserId(env, request);
    if (!authUserId) {
      return jsonResponse({ success: false, error: '请先登录' }, 403);
    }

    // 仅开发者可更新分类
    const isDev = await isDeveloper(env, authUserId);
    if (!isDev) {
      return jsonResponse({ success: false, error: '无权操作，仅开发者可管理分类' }, 403);
    }

    // 确认分类存在
    const cat = await env.DB.prepare(
      `SELECT id FROM blog_categories WHERE id = ?`
    ).bind(catId).first();
    if (!cat) {
      return jsonResponse({ success: false, error: '分类不存在' }, 404);
    }

    const body = await request.json().catch(() => ({}));
    const { name, description, sort_order } = body;

    // 构建动态更新字段
    const updates = [];
    const params = [];

    if (name !== undefined) {
      const nameStr = String(name).trim();
      if (!nameStr) {
        return jsonResponse({ success: false, error: '分类名称不能为空' });
      }
      // 检查重名（排除自身）
      const dup = await env.DB.prepare(
        `SELECT id FROM blog_categories WHERE name = ? AND id != ?`
      ).bind(nameStr, catId).first();
      if (dup) {
        return jsonResponse({ success: false, error: '分类名称已存在' });
      }
      updates.push('name = ?');
      params.push(nameStr);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      params.push(String(description));
    }
    if (sort_order !== undefined) {
      updates.push('sort_order = ?');
      params.push(parseInt(sort_order, 10) || 0);
    }

    if (updates.length === 0) {
      return jsonResponse({ success: false, error: '没有需要更新的字段' });
    }

    params.push(catId);
    await env.DB.prepare(
      `UPDATE blog_categories SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...params).run();

    // 查询更新后的分类
    const updated = await env.DB.prepare(
      `SELECT id, name, description, sort_order, created_at FROM blog_categories WHERE id = ?`
    ).bind(catId).first();

    updated.created_at = formatDate(updated.created_at);

    return jsonResponse({ success: true, data: updated, message: '分类已更新' });
  } catch (e) {
    return jsonResponse({ success: false, error: '更新分类失败：' + e.message }, 500);
  }
}

// ===== DELETE: 删除分类（仅开发者，通过 ?id= 指定） =====
export async function onRequestDelete(context) {
  if (!context.env || !context.env.DB) {
    return jsonResponse({ success: false, error: '数据库未绑定，请在 Cloudflare Pages 设置中绑定 D1 数据库' }, 500);
  }

  try {
    const { env, request } = context;
    const url = new URL(context.request.url);
    const catIdRaw = url.searchParams.get('id');

    if (!catIdRaw) {
      return jsonResponse({ success: false, error: '缺少分类 ID（id 参数）' });
    }

    const catId = parseInt(catIdRaw, 10);
    if (isNaN(catId)) {
      return jsonResponse({ success: false, error: '分类 ID 无效' });
    }

    // 鉴权
    const authUserId = await getAuthUserId(env, request);
    if (!authUserId) {
      return jsonResponse({ success: false, error: '请先登录' }, 403);
    }

    // 仅开发者可删除分类
    const isDev = await isDeveloper(env, authUserId);
    if (!isDev) {
      return jsonResponse({ success: false, error: '无权操作，仅开发者可管理分类' }, 403);
    }

    // 确认分类存在
    const cat = await env.DB.prepare(
      `SELECT id FROM blog_categories WHERE id = ?`
    ).bind(catId).first();
    if (!cat) {
      return jsonResponse({ success: false, error: '分类不存在' }, 404);
    }

    // 将该分类下的文章 category_id 置为 NULL
    await env.DB.prepare(
      `UPDATE blog_posts SET category_id = NULL WHERE category_id = ?`
    ).bind(catId).run();

    // 删除分类
    await env.DB.prepare(
      `DELETE FROM blog_categories WHERE id = ?`
    ).bind(catId).run();

    return jsonResponse({ success: true, message: '分类已删除，该分类下的文章已移至未分类' });
  } catch (e) {
    return jsonResponse({ success: false, error: '删除分类失败：' + e.message }, 500);
  }
}
