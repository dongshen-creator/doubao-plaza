// /api/refresh-supabase-token — 刷新 Supabase JWT（用 D1 session token 换取新 JWT）
import { signSupabaseJWT, getAuthUserId } from './_lib/jwt.js';

// 统一 no-store JSON 响应：含 token 的响应禁止任何缓存
function jsonNoStore(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(init.headers || {}) },
  });
}

export async function onRequestPost(context) {
  try {
    const { env } = context;
    const userId = await getAuthUserId(env, context.request);
    if (!userId) {
      return jsonNoStore({ success: false, error: '未授权' }, { status: 401 });
    }

    const supabaseToken = await signSupabaseJWT(userId, env);
    if (!supabaseToken) {
      return jsonNoStore({ success: false, error: 'JWT 获取失败' }, { status: 500 });
    }

    return jsonNoStore({ success: true, supabase_token: supabaseToken });
  } catch (e) {
    console.error('[refresh-supabase-token] 服务器错误:', e);
    return jsonNoStore({ success: false, error: '服务器错误，请稍后再试' }, { status: 500 });
  }
}
