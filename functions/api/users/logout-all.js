// Cloudflare Pages Function - Logout All Devices
// POST /api/users/logout-all
// 删除该用户的所有 session，踢所有设备下线

import { getAuthUserId } from '../_lib/jwt.js';

export async function onRequestPost(context) {
  if (!context.env.DB) {
    return Response.json({ success: false, error: '数据库未绑定' });
  }

  try {
    const { env } = context;
    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId) {
      return Response.json({ success: false, error: '请先登录' }, { status: 401 });
    }

    // 删除该用户的所有 session
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(authUserId).run();

    return Response.json({ success: true, message: '已踢所有设备下线' });
  } catch (e) {
    return Response.json({ success: false, error: '服务器错误：' + e.message });
  }
}
