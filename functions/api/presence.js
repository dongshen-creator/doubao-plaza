// /api/presence — 更新用户在线状态（用于 beforeunload 时的离线标记）
export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { user_id, status } = body;
    if (!user_id) return Response.json({ success: false, error: 'missing user_id' }, { status: 400 });

    // 通过 Supabase REST API 更新
    const supabaseUrl = context.env.SUPABASE_URL;
    const supabaseKey = context.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return Response.json({ success: false, error: 'Supabase not configured' }, { status: 500 });
    }

    const now = new Date().toISOString();
    const payload = { user_id, last_seen: now, status: status || 'offline' };

    const res = await fetch(supabaseUrl + '/rest/v1/user_presence?on_conflict=user_id', {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey,
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
