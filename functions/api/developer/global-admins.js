// Cloudflare Pages Function - Developer 全局管理员授予 / 撤销（v9.2）
// GET  /api/developer/global-admins          - 当前全局管理员列表（?q= 时附带候选搜索 ≤10 条）
// GET  /api/developer/global-admins?q=xxx    - 按 id / name_norm / name 模糊搜索候选
// POST /api/developer/global-admins          - { action: 'grant' | 'revoke', user_id }
// GET 要求后台会话；POST 要求 step-up 且操作者必须是纯开发者（is_developer=1），
// 全局管理员不能自行扩权。全部写审计（global_admin_grant / global_admin_revoke）。
import { requireDeveloper, devJson, devErr, isDeveloperFlag, isGlobalAdminFlag } from '../_lib/devauth.js';
import { writeAdminAudit } from '../_lib/audit.js';
import { normalizeName } from '../_lib/name.js';

// LIKE 通配符转义（配合 ESCAPE '\'，与 developer/users.js 一致）
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

async function listAdmins(env) {
  const rs = await env.DB.prepare(
    `SELECT id, name, doubao_id, is_developer, created_at
     FROM users
     WHERE COALESCE(is_global_admin, 0) = 1
     ORDER BY created_at DESC
     LIMIT 50`
  ).all();
  return (rs && rs.results) || [];
}

async function searchCandidates(env, q) {
  const norm = normalizeName(q);
  const like = '%' + escapeLike(q) + '%';
  const rs = await env.DB.prepare(
    `SELECT id, name, doubao_id, is_developer, is_global_admin, quarantined_at, deactivated_at
     FROM users
     WHERE id = ?
        OR (name_norm IS NOT NULL AND name_norm = ?)
        OR name LIKE ? ESCAPE '\\'
     LIMIT 10`
  ).bind(q, norm, like).all();
  return ((rs && rs.results) || []).map((u) => ({
    id: u.id,
    name: u.name,
    doubao_id: u.doubao_id || '',
    is_developer: isDeveloperFlag(u.is_developer),
    is_global_admin: isGlobalAdminFlag(u.is_global_admin),
    locked: !!(u.quarantined_at || u.deactivated_at),
  }));
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return devErr('数据库未绑定', 500);
  try {
    const gate = await requireDeveloper(env, request);
    if (!gate.ok) return gate.response;

    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || '').trim().slice(0, 64);
    const admins = await listAdmins(env);
    const matches = q ? await searchCandidates(env, q) : [];
    return devJson({ success: true, data: { admins, matches } });
  } catch (e) {
    console.error('[DEV-GLOBAL-ADMINS] GET error:', e.message);
    return devErr('服务器错误', 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return devErr('数据库未绑定', 500);
  try {
    const gate = await requireDeveloper(env, request, { stepup: true });
    if (!gate.ok) return gate.response;
    // 只有纯开发者能授予 / 撤销全局管理员（全局管理员不得自行扩权）
    if (!isDeveloperFlag(gate.user.is_developer)) {
      return devErr('仅开发者可授予或撤销全局管理员', 403);
    }

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '');
    const targetId = String(body.user_id || '').trim().slice(0, 64);
    if (action !== 'grant' && action !== 'revoke') return devErr('未知操作', 400);
    if (!targetId) return devErr('缺少目标账号', 400);
    if (targetId === gate.userId) return devErr('不能修改自己的全局管理员身份', 400);

    const target = await env.DB.prepare(
      `SELECT id, name, doubao_id, is_developer, is_global_admin, quarantined_at, deactivated_at
       FROM users WHERE id = ?`
    ).bind(targetId).first();
    if (!target) return devErr('账号不存在', 404);

    const has = isGlobalAdminFlag(target.is_global_admin);
    if (action === 'grant') {
      if (target.quarantined_at || target.deactivated_at) return devErr('目标账号处于隔离或停用状态', 400);
      if (isDeveloperFlag(target.is_developer)) return devErr('该用户已是开发者，无需授予全局管理员', 400);
      if (has) return devErr('该用户已是全局管理员', 400);
    } else {
      if (!has) return devErr('该用户不是全局管理员', 400);
    }

    await env.DB.prepare(
      `UPDATE users SET is_global_admin = ? WHERE id = ?`
    ).bind(action === 'grant' ? 1 : 0, targetId).run();

    await writeAdminAudit(env, {
      actorId: gate.userId,
      action: action === 'grant' ? 'global_admin_grant' : 'global_admin_revoke',
      target: targetId,
      detail: { target_name: target.name, target_doubao_id: target.doubao_id || '' },
        request,
    });

    return devJson({
      success: true,
      data: { user_id: targetId, is_global_admin: action === 'grant' },
    });
  } catch (e) {
    console.error('[DEV-GLOBAL-ADMINS] POST error:', e.message);
    return devErr('服务器错误', 500);
  }
}
