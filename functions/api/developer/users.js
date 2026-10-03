// Cloudflare Pages Function - Developer 用户查找与关联分析
// GET /api/developer/users?q=<昵称|用户id|注册IP|最近登录IP>  - 多条件查找（≤20 条）
// GET /api/developer/users?id=<用户id>                       - 单账号详情 + 同 IP / 同设备关联展示
// 高敏只读通道：要求 step-up；查询行为本身写审计（search_user），detail 脱敏
import { requireDeveloper, devJson, devErr } from '../_lib/devauth.js';
import { writeAdminAudit } from '../_lib/audit.js';
import { normalizeName } from '../_lib/name.js';

const USER_COLS = `id, name, doubao_id, is_developer, is_global_admin, created_at, last_login_at,
  last_login_ip, registered_ip, quarantined_at, quarantine_reason, deactivated_at`;

// LIKE 通配符转义（配合 ESCAPE '\'）
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

async function searchUsers(env, q) {
  const norm = normalizeName(q);
  const like = '%' + escapeLike(q) + '%';
  return env.DB.prepare(
    `SELECT ${USER_COLS} FROM users
     WHERE id = ?
        OR (name_norm IS NOT NULL AND name_norm = ?)
        OR name LIKE ? ESCAPE '\\'
        OR (registered_ip IS NOT NULL AND registered_ip = ?)
        OR (last_login_ip IS NOT NULL AND last_login_ip = ?)
     ORDER BY last_login_at DESC
     LIMIT 20`
  ).bind(q, norm, like, q, q).all();
}

async function userDetail(env, userId) {
  const user = await env.DB.prepare(
    `SELECT ${USER_COLS}, last_login_ua FROM users WHERE id = ?`
  ).bind(userId).first();
  if (!user) return null;

  // 同 IP 关联：注册 IP 或最近登录 IP 任一命中的其他账号
  let ipRelated = [];
  if (user.registered_ip || user.last_login_ip) {
    const r = await env.DB.prepare(
      `SELECT id, name, created_at, last_login_at, registered_ip, last_login_ip, quarantined_at
       FROM users
       WHERE id != ?
         AND ((registered_ip IS NOT NULL AND registered_ip IN (?, ?))
           OR (last_login_ip IS NOT NULL AND last_login_ip IN (?, ?)))
       LIMIT 50`
    ).bind(userId,
      user.registered_ip || '', user.last_login_ip || '',
      user.registered_ip || '', user.last_login_ip || '').all();
    ipRelated = (r && r.results) || [];
  }

  // 设备绑定历史
  const dev = await env.DB.prepare(
    `SELECT da.device_id, da.status AS binding_status, da.bound_at, da.released_at, da.release_reason,
            d.status AS device_status, d.risk_level, d.claim_count, d.created_ip, d.created_at AS device_created_at
     FROM device_accounts da
     LEFT JOIN devices d ON d.id = da.device_id
     WHERE da.user_id = ?
     ORDER BY da.bound_at DESC
     LIMIT 20`
  ).bind(userId).all();

  // 同设备关联：与该账号共享过同一设备的其他账号
  const devRelated = await env.DB.prepare(
    `SELECT DISTINCT u.id, u.name, u.created_at, u.quarantined_at
     FROM device_accounts da
     JOIN device_accounts da2 ON da2.device_id = da.device_id AND da2.user_id != da.user_id
     JOIN users u ON u.id = da2.user_id
     WHERE da.user_id = ?
     LIMIT 50`
  ).bind(userId).all();

  const sess = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND expires_at > datetime('now')`
  ).bind(userId).first();

  return {
    user,
    devices: (dev && dev.results) || [],
    ip_related: ipRelated,
    device_related: (devRelated && devRelated.results) || [],
    sessions_active: (sess && sess.c) || 0,
  };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return devErr('数据库未绑定', 500);
  try {
    const gate = await requireDeveloper(env, request, { stepup: true });
    if (!gate.ok) return gate.response;

    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const id = (url.searchParams.get('id') || '').trim().slice(0, 64);

    if (id) {
      const detail = await userDetail(env, id);
      if (!detail) return devErr('账号不存在', 404);
      await writeAdminAudit(env, {
        actorId: gate.userId, action: 'search_user', target: id,
        detail: { mode: 'detail' },
        request,
      });
      return devJson({ success: true, data: detail });
    }

    if (!q) return devErr('请输入查找条件', 400);
    const rows = await searchUsers(env, q);
    const results = rows.results || [];
    await writeAdminAudit(env, {
      actorId: gate.userId, action: 'search_user',
      detail: { mode: 'search', hits: results.length, len: q.length },
      request,
    });
    return devJson({ success: true, data: { users: results } });
  } catch (e) {
    console.error('[DEV-USERS] error:', e.message);
    return devErr('服务器错误', 500);
  }
}
