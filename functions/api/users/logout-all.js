// Cloudflare Pages Function - Logout All Devices
// POST /api/users/logout-all
// 删除该用户的所有 session，踢所有设备下线

import { getAuthUserId } from '../_lib/jwt.js';

// 统一 no-store JSON 响应
function jsonNoStore(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(init.headers || {}) },
  });
}

export async function onRequestPost(context) {
  if (!context.env.DB) {
    return jsonNoStore({ success: false, error: '数据库未绑定' });
  }

  try {
    const { env } = context;
    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId) {
      return jsonNoStore({ success: false, error: '请先登录' }, { status: 401 });
    }

    // 删除该用户的所有 session
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(authUserId).run();

    return jsonNoStore({ success: true, message: '已踢所有设备下线' });
  } catch (e) {
    console.error('[logout-all] 服务器错误:', e);
    return jsonNoStore({ success: false, error: '服务器错误，请稍后再试' });
  }
}
