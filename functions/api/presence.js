// /api/presence — 更新用户在线状态（用于 beforeunload 时的离线标记）
// RLS 收紧后需要 authenticated JWT，anon key 不再能写入 user_presence
import { signSupabaseJWT, getAuthUserId } from './_lib/jwt.js';

export async function onRequestPost(context) {
  try {
    const { env } = context;

    // 鉴权：从 Authorization 头获取会话 token，校验 D1 会话
    const userId = await getAuthUserId(env, context.request);
    if (!userId) {
      return Response.json({ success: false, error: '未授权' }, { status: 401 });
    }

    const body = await context.request.json();
    const { status } = body;

    const supabaseUrl = env.SUPABASE_URL;
    const supabaseKey = env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return Response.json({ success: false, error: 'Supabase not configured' }, { status: 500 });
    }

    // 获取 Supabase JWT（通过 Edge Function，包含 app_metadata.d1_user_id）
    const supabaseToken = await signSupabaseJWT(userId, env);
    if (!supabaseToken) {
      return Response.json({ success: false, error: 'JWT 获取失败' }, { status: 500 });
    }

    const now = new Date().toISOString();
    const payload = { user_id: userId, last_seen: now, status: status || 'offline' };

    const res = await fetch(supabaseUrl + '/rest/v1/user_presence?on_conflict=user_id', {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + supabaseToken,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const text = await res.text();
      return Response.json({ success: false, error: text }, { status: res.status });
    }

    return Response.json({ success: true });
  } catch(e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}
