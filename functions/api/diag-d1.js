// V10.3 临时只读诊断端点：定位远端 D1 表/列故障（生产 500 事故排查）
// 用途：dump sqlite_master 全量表结构 + 复跑各失败查询，回传真实 e.message
// 安全：需 X-DP-Diag-Token 头（+ 中间件门禁双保险）；仅 SELECT 只读，无任何写操作
const DIAG_TOKEN = 'dg_7f3a9c2e1b58460d';

export async function onRequestGet(context) {
  const { env, request } = context;
  // Token 校验失败一律 404（不暴露端点存在）
  if (request.headers.get('X-DP-Diag-Token') !== DIAG_TOKEN) {
    return new Response('Not Found', { status: 404 });
  }
  if (!env.DB) {
    return Response.json({ success: false, error: 'DB not bound' }, { status: 500 });
  }

  const out = { success: true, tables: [], probes: [] };

  // 1) 全量表结构（含 CREATE 语句，可直接比对 schema.sql）
  try {
    const sm = await env.DB.prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    ).all();
    out.tables = (sm.results || []).map(r => ({ type: r.type, name: r.name, sql: r.sql }));
  } catch (e) {
    out.tablesError = String((e && e.message) || e);
  }

  // 2) 复跑失败端点的确切查询（只读），逐条捕获真实报错
  const probes = [
    ['users_list', "SELECT id FROM users WHERE privacy_setting = 'searchable' ORDER BY created_at DESC LIMIT 5"],
    ['users_login_ctrl', "SELECT id FROM users WHERE doubao_id = '__diag__'"],
    ['features_list', 'SELECT id FROM features ORDER BY sort_order ASC, created_at DESC'],
    ['features_cols', 'SELECT tool_type, tool_config FROM features LIMIT 1'],
    ['custom_pages_list', 'SELECT id FROM custom_pages ORDER BY created_at DESC'],
    ['blog_posts_list', 'SELECT id FROM blog_posts ORDER BY created_at DESC'],
    ['blog_announce_list', 'SELECT id FROM blog_announcements ORDER BY created_at DESC'],
    ['devices_count', 'SELECT COUNT(*) as c FROM devices'],
    ['announcements_ctrl', 'SELECT id FROM announcements ORDER BY created_at DESC'],
    ['site_settings_ctrl', 'SELECT key FROM site_settings LIMIT 1'],
    ['sessions_ctrl', 'SELECT user_id FROM sessions LIMIT 1']
  ];
  for (const [name, sql] of probes) {
    try {
      const r = await env.DB.prepare(sql).all();
      out.probes.push({ name, ok: true, rows: (r.results || []).length });
    } catch (e) {
      out.probes.push({ name, ok: false, error: String((e && e.message) || e) });
    }
  }

  return Response.json(out, { headers: { 'Content-Type': 'application/json' } });
}
