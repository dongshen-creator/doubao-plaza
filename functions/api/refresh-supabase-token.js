// /api/refresh-supabase-token — 刷新 Supabase JWT（用 D1 session token 换取新 JWT）
import { signSupabaseJWT, getAuthUserId } from './_lib/jwt.js';

export async function onRequestPost(context) {
  try {
    const { env } = context;
    const userId = await getAuthUserId(env, context.request);
    if (!userId) {
      return Response.json({ success: false, error: '未授权' }, { status: 401 });
    }

    const supabaseToken = await signSupabaseJWT(userId, env);
    if (!supabaseToken) {
      return Response.json({ success: false, error: 'JWT 获取失败' }, { status: 500 });
    }

    return Response.json({ success: true, supabase_token: supabaseToken });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}
