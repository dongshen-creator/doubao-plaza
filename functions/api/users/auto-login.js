// Cloudflare Pages Function - Auto Login
// POST /api/users/auto-login

import { signSupabaseJWT, generateToken, getAuthUserId } from '../_lib/jwt.js';

// 统一 no-store JSON 响应：含 token 的响应禁止任何缓存
function jsonNoStore(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(init.headers || {}) },
  });
}

async function checkAndUpdatePunishment(env, userId) {
  if (!env.DB) throw new Error('数据库未绑定');
  const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId).first();
  if (!user) return null;
  if (user.privacy_setting === 'punished_whitelist' && user.punished_until) {
    const now = new Date().toISOString();
    if (user.punished_until < now) {
      await env.DB.prepare(
        `UPDATE users SET privacy_setting = 'searchable', punished_until = NULL, punish_reason = NULL WHERE id = ?`
      ).bind(userId).run();
      user.privacy_setting = 'searchable';
    }
  }
  return user;
}

export async function onRequestPost(context) {
  // 首先检查环境变量
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定，请在Cloudflare Pages设置中绑定D1数据库' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { env } = context;
    const body = await context.request.json().catch(() => ({}));
    const { token } = body;

    if (!token) {
      return jsonNoStore({ success: false, error: '无会话token' });
    }

    const session = await env.DB.prepare(
      `SELECT s.user_id, s.token, s.expires_at, u.* FROM sessions s JOIN users u ON s.user_id = u.id 
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    ).bind(token).first();

    if (!session) {
      return jsonNoStore({ success: false, error: '会话已过期' });
    }

    // V8.0 惩罚性隐身：隔离 / 停用账号的旧会话一律按「过期」处理（口径与 middleware 诱饵一致），
    // 并撤销该账号全部会话；不暴露隔离状态
    if (session.quarantined_at || session.deactivated_at) {
      await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(session.user_id).run();
      return jsonNoStore({ success: false, error: '会话已过期' });
    }

    // Token 轮换：删除旧 token，签发新 token（防止 token 被窃后长期有效）
    const newToken = generateToken();
    const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    await env.DB.prepare(
      `INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)`
    ).bind(session.user_id, newToken, newExpiresAt).run();

    // 签发 Supabase JWT（用于 RLS 鉴权）
    const supabaseToken = await signSupabaseJWT(session.user_id, env);

    // V8.0：只信 Cloudflare 可信边缘头，不接受可伪造的 X-Forwarded-For
    const clientIP = context.request.headers.get('CF-Connecting-IP') || 'unknown';
    const userAgent = context.request.headers.get('User-Agent') || '';

    await env.DB.prepare(
      `UPDATE users SET last_login_at = datetime('now'), last_login_ip = ?, last_login_ua = ? WHERE id = ?`
    ).bind(clientIP, userAgent, session.user_id).run();

    const user = await checkAndUpdatePunishment(env, session.user_id);

    if (!user) {
      return jsonNoStore({ success: false, error: '用户不存在' });
    }

    // 安全地移除 password 字段
    const safeUser = {
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      bio: user.bio,
      doubao_id: user.doubao_id,
      agent_url: user.agent_url,
      is_developer: user.is_developer,
      privacy_setting: user.privacy_setting,
      invite_code: user.invite_code,
      created_at: user.created_at,
      updated_at: user.updated_at,
      last_login_at: user.last_login_at,
      last_login_ip: clientIP,
      last_login_ua: userAgent,
      pat_suffix: user.pat_suffix
    };

    return jsonNoStore({ success: true, data: safeUser, token: newToken, supabase_token: supabaseToken });
  } catch (e) {
    console.error('[auto-login] 服务器错误:', e);
    return jsonNoStore({ success: false, error: '服务器错误，请稍后再试' });
  }
}
