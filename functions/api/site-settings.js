// Cloudflare Pages Function - Site Settings API
// GET /api/site-settings  - 公开，返回维护模式/迁移模式状态
// PUT /api/site-settings  - 仅开发者可修改

// 统一鉴权：从 Authorization 头取 token，校验会话有效性，返回 user_id 或 null
async function getAuthUserId(env, request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const session = await env.DB.prepare(
    `SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
  return session ? session.user_id : null;
}

// 读取某个站点设置（不存在则返回默认值；表未创建时也返回默认值）
async function getSetting(env, key, defaultValue) {
  try {
    const row = await env.DB.prepare(
      `SELECT value FROM site_settings WHERE key = ?`
    ).bind(key).first();
    return row ? row.value : defaultValue;
  } catch (e) {
    return defaultValue;
  }
}

export async function onRequestGet(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  try {
    const { env } = context;
    const maintenanceMode = await getSetting(env, 'maintenance_mode', 'off');
    const migrationMode = await getSetting(env, 'migration_mode', 'off');
    return Response.json({
      success: true,
      data: {
        maintenance_mode: maintenanceMode, // 'on' | 'off'
        migration_mode: migrationMode       // 'on' | 'off'
      }
    });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}

// 检查用户是否为开发者（兼容 D1 返回的整数/字符串/布尔值）
function checkIsDeveloper(user) {
  if (!user) return false;
  var val = user.is_developer;
  if (val === 1 || val === '1' || val === true) return true;
  // 也检查 doubao_id 白名单
  if (user.doubao_id && ['470208447', 'East_pairs'].includes(user.doubao_id)) return true;
  return false;
}

export async function onRequestPut(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  try {
    const { env } = context;
    // 鉴权：仅开发者可修改站点设置
    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId) {
      return Response.json({ success: false, error: '请先登录' }, { status: 403 });
    }
    const user = await env.DB.prepare(
      `SELECT is_developer, doubao_id FROM users WHERE id = ?`
    ).bind(authUserId).first();
    if (!checkIsDeveloper(user)) {
      return Response.json({ success: false, error: '无权操作，仅开发者可修改站点设置' }, { status: 403 });
    }

    const body = await context.request.json().catch(() => ({}));
    const { maintenance_mode, migration_mode } = body;

    const updates = [];
    if (maintenance_mode !== undefined) {
      if (!['on', 'off'].includes(maintenance_mode)) {
        return Response.json({ success: false, error: 'maintenance_mode 必须是 on 或 off' });
      }
      updates.push(['maintenance_mode', maintenance_mode]);
    }
    if (migration_mode !== undefined) {
      if (!['on', 'off'].includes(migration_mode)) {
        return Response.json({ success: false, error: 'migration_mode 必须是 on 或 off' });
      }
      updates.push(['migration_mode', migration_mode]);
    }

    for (const [key, value] of updates) {
      // INSERT OR REPLACE 实现 upsert
      await env.DB.prepare(
        `INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      ).bind(key, value).run();
    }

    return Response.json({ success: true, message: '站点设置已更新' });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
