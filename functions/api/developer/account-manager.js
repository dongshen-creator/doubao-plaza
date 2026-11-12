// Cloudflare Pages Function - Developer 账号组合管理
// GET  /api/developer/account-manager - 组合筛选、分页、全局状态统计与本页关联指标
// POST /api/developer/account-manager
//   { action:'preview', user_ids, reason? }
//   { action:'quarantine'|'unquarantine'|'force_logout'|'revoke_stepup'|'release_devices',
//     user_ids, reason?, confirm } - confirm 必须等于去重后的账号数
// 全部要求 step-up；指纹仅返回前 8 位，永不选择密码或 TOTP 字段。
import { requireDeveloper, devJson, devErr, isDeveloperFlag, isGlobalAdminFlag } from '../_lib/devauth.js';
import { writeAdminAudit } from '../_lib/audit.js';
import { logRiskEvent, getClientIp, cfMeta } from '../_lib/device.js';

const ACTIONS = new Set([
  'preview', 'quarantine', 'unquarantine', 'force_logout', 'revoke_stepup', 'release_devices',
]);
const SORT_COLUMNS = {
  created_at: 'u.created_at',
  last_login_at: 'u.last_login_at',
  last_active_at: 'u.last_active_at',
  report_count_30d: 'u.report_count_30d',
  name: 'u.name',
};
const USER_COLS = `u.id, u.name, u.doubao_id, u.avatar, u.is_developer, u.is_global_admin,
  u.privacy_setting, u.punished_until, u.punish_reason, u.report_count_30d, u.report_count_6m,
  u.created_at, u.last_login_at, u.last_active_at, u.last_login_ip, u.registered_ip,
  u.quarantined_at, u.quarantine_reason, u.deactivated_at, u.device_fingerprint`;
const PUNISHED_SQL = `(
  COALESCE(u.privacy_setting, '') IN ('punished_whitelist', 'punished_stealth')
  OR (u.punished_until IS NOT NULL AND datetime(u.punished_until) > datetime('now'))
)`;

class InputError extends Error {}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (c) => '\\' + c);
}

function enumParam(url, name, allowed, fallback) {
  const value = (url.searchParams.get(name) || fallback).trim();
  if (!allowed.includes(value)) throw new InputError(`${name} 参数无效`);
  return value;
}

function integerParam(url, name, fallback, min, max) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new InputError(`${name} 必须是整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || (max !== null && value > max)) {
    throw new InputError(max === null ? `${name} 必须不小于 ${min}` : `${name} 需在 ${min}-${max} 之间`);
  }
  return value;
}

function dateParam(url, name) {
  const value = (url.searchParams.get(name) || '').trim();
  if (!value) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new InputError(`${name} 必须使用 YYYY-MM-DD 格式`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new InputError(`${name} 不是有效日期`);
  }
  return value;
}

function parseListQuery(url) {
  return {
    q: (url.searchParams.get('q') || '').trim().slice(0, 100),
    status: enumParam(url, 'status', ['all', 'normal', 'quarantined', 'deactivated', 'punished'], 'all'),
    role: enumParam(url, 'role', ['all', 'user', 'global_admin', 'developer'], 'all'),
    activity: enumParam(url, 'activity', ['all', '7d', '30d', '90d', 'never'], 'all'),
    ip: (url.searchParams.get('ip') || '').trim().slice(0, 100),
    deviceId: (url.searchParams.get('device_id') || '').trim().slice(0, 64),
    minReports: integerParam(url, 'min_reports', 0, 0, 9999),
    createdFrom: dateParam(url, 'created_from'),
    createdTo: dateParam(url, 'created_to'),
    sort: enumParam(url, 'sort', Object.keys(SORT_COLUMNS), 'created_at'),
    order: enumParam(url, 'order', ['asc', 'desc'], 'desc'),
    page: integerParam(url, 'page', 1, 1, null),
    pageSize: integerParam(url, 'page_size', 20, 1, 50),
  };
}

function buildUserFilters(filters) {
  const where = [];
  const params = [];
  if (filters.q) {
    const like = `%${escapeLike(filters.q)}%`;
    where.push(`(u.name LIKE ? ESCAPE '\\' OR u.id LIKE ? ESCAPE '\\' OR u.doubao_id LIKE ? ESCAPE '\\')`);
    params.push(like, like, like);
  }
  if (filters.status === 'normal') {
    where.push(`u.quarantined_at IS NULL AND u.deactivated_at IS NULL AND NOT ${PUNISHED_SQL}`);
  } else if (filters.status === 'quarantined') {
    where.push('u.quarantined_at IS NOT NULL');
  } else if (filters.status === 'deactivated') {
    where.push('u.deactivated_at IS NOT NULL');
  } else if (filters.status === 'punished') {
    where.push(PUNISHED_SQL);
  }
  if (filters.role === 'user') {
    where.push('COALESCE(u.is_developer, 0) = 0 AND COALESCE(u.is_global_admin, 0) = 0');
  } else if (filters.role === 'global_admin') {
    where.push('COALESCE(u.is_global_admin, 0) = 1 AND COALESCE(u.is_developer, 0) = 0');
  } else if (filters.role === 'developer') {
    where.push('COALESCE(u.is_developer, 0) = 1');
  }
  if (filters.activity === 'never') {
    where.push('u.last_active_at IS NULL AND u.last_login_at IS NULL');
  } else if (filters.activity !== 'all') {
    const days = { '7d': 7, '30d': 30, '90d': 90 }[filters.activity];
    where.push(`datetime(COALESCE(u.last_active_at, u.last_login_at, u.created_at)) >= datetime('now', ?)`);
    params.push(`-${days} days`);
  }
  if (filters.ip) {
    where.push('(u.registered_ip = ? OR u.last_login_ip = ?)');
    params.push(filters.ip, filters.ip);
  }
  if (filters.deviceId) {
    where.push(`EXISTS (
      SELECT 1 FROM device_accounts fda
      WHERE fda.user_id = u.id AND fda.device_id = ?
    )`);
    params.push(filters.deviceId);
  }
  if (filters.minReports > 0) {
    where.push('COALESCE(u.report_count_30d, 0) >= ?');
    params.push(filters.minReports);
  }
  if (filters.createdFrom) {
    where.push('datetime(u.created_at) >= datetime(?)');
    params.push(filters.createdFrom);
  }
  if (filters.createdTo) {
    // created_to 包含当天：以下一天零时作为排他上界。
    where.push("datetime(u.created_at) < datetime(?, '+1 day')");
    params.push(filters.createdTo);
  }
  return { where, params };
}

async function supplementUsers(env, users) {
  if (!users.length) return [];
  const ids = users.map((u) => u.id);
  const placeholders = ids.map(() => '?').join(',');
  const [deviceRs, sessionRs, riskRs] = await Promise.all([
    env.DB.prepare(
      `SELECT user_id, COUNT(*) AS count FROM device_accounts
       WHERE user_id IN (${placeholders}) AND status = 'active' GROUP BY user_id`
    ).bind(...ids).all(),
    env.DB.prepare(
      `SELECT user_id, COUNT(*) AS count FROM sessions
       WHERE user_id IN (${placeholders}) AND datetime(expires_at) > datetime('now') GROUP BY user_id`
    ).bind(...ids).all(),
    env.DB.prepare(
      `SELECT user_id, COUNT(*) AS event_count, COALESCE(MAX(risk_score), 0) AS max_score
       FROM risk_events WHERE user_id IN (${placeholders}) GROUP BY user_id`
    ).bind(...ids).all(),
  ]);

  const deviceCounts = new Map(((deviceRs && deviceRs.results) || []).map((r) => [r.user_id, r.count]));
  const sessionCounts = new Map(((sessionRs && sessionRs.results) || []).map((r) => [r.user_id, r.count]));
  const riskStats = new Map(((riskRs && riskRs.results) || []).map((r) => [r.user_id, r]));
  return users.map((user) => {
    const risk = riskStats.get(user.id);
    return {
      ...user,
      // 原始指纹只在这条明确的白名单查询中出现，响应前立即截断。
      device_fingerprint: user.device_fingerprint ? `${String(user.device_fingerprint).slice(0, 8)}…` : null,
      active_device_count: Number(deviceCounts.get(user.id) || 0),
      active_session_count: Number(sessionCounts.get(user.id) || 0),
      risk_event_count: Number((risk && risk.event_count) || 0),
      max_risk_score: Number((risk && risk.max_score) || 0),
    };
  });
}

async function userStats(env) {
  const users = await env.DB.prepare(
    `SELECT COUNT(*) AS total_users,
       SUM(CASE WHEN u.quarantined_at IS NULL AND u.deactivated_at IS NULL AND NOT ${PUNISHED_SQL}
                THEN 1 ELSE 0 END) AS normal_users,
       SUM(CASE WHEN u.quarantined_at IS NOT NULL THEN 1 ELSE 0 END) AS quarantined_users,
       SUM(CASE WHEN u.deactivated_at IS NOT NULL THEN 1 ELSE 0 END) AS deactivated_users
     FROM users u`
  ).first();
  const devices = await env.DB.prepare(
    `SELECT COUNT(*) AS banned_devices FROM devices WHERE status = 'banned'`
  ).first();
  return {
    total_users: Number((users && users.total_users) || 0),
    normal_users: Number((users && users.normal_users) || 0),
    quarantined_users: Number((users && users.quarantined_users) || 0),
    deactivated_users: Number((users && users.deactivated_users) || 0),
    banned_devices: Number((devices && devices.banned_devices) || 0),
  };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return devErr('数据库未绑定', 500);
  try {
    const gate = await requireDeveloper(env, request, { stepup: true });
    if (!gate.ok) return gate.response;
    const filters = parseListQuery(new URL(request.url));
    const { where, params } = buildUserFilters(filters);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (filters.page - 1) * filters.pageSize;
    if (!Number.isSafeInteger(offset)) throw new InputError('页码过大');

    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM users u ${whereSql}`
    ).bind(...params).first();
    const total = Number((countRow && countRow.total) || 0);
    const rs = await env.DB.prepare(
      `SELECT ${USER_COLS} FROM users u ${whereSql}
       ORDER BY ${SORT_COLUMNS[filters.sort]} ${filters.order.toUpperCase()}, u.id ASC
       LIMIT ? OFFSET ?`
    ).bind(...params, filters.pageSize, offset).all();
    const users = await supplementUsers(env, (rs && rs.results) || []);
    const stats = await userStats(env);
    const pages = Math.ceil(total / filters.pageSize);

    await writeAdminAudit(env, {
      actorId: gate.userId,
      action: 'search_user',
      detail: {
        filters: {
          q_len: filters.q.length,
          status: filters.status,
          role: filters.role,
          activity: filters.activity,
          has_ip: !!filters.ip,
          has_device_id: !!filters.deviceId,
          min_reports: filters.minReports,
          created_from: filters.createdFrom || null,
          created_to: filters.createdTo || null,
          sort: filters.sort,
          order: filters.order,
          page: filters.page,
          page_size: filters.pageSize,
        },
        hits: users.length,
        total,
      },
      request,
    });
    return devJson({
      success: true,
      data: {
        users,
        pagination: { page: filters.page, page_size: filters.pageSize, total, pages },
        stats,
      },
    });
  } catch (e) {
    if (e instanceof InputError) return devErr(e.message, 400);
    console.error('[DEV-ACCOUNT-MANAGER] GET error:', e.message);
    return devErr('服务器错误', 500);
  }
}

function permissionSkip(gate, target) {
  if (!target) return '账号不存在';
  if (target.id === gate.userId) return '不能操作当前登录账号';
  if (isDeveloperFlag(target.is_developer)) return '不能操作开发者账号';
  if (!isDeveloperFlag(gate.user.is_developer)
      && isGlobalAdminFlag(gate.user.is_global_admin)
      && isGlobalAdminFlag(target.is_global_admin)) {
    return '全局管理员不能操作其他全局管理员';
  }
  return '';
}

async function assessTarget(env, gate, action, userId) {
  const target = await env.DB.prepare(
    `SELECT id, name, is_developer, is_global_admin, quarantined_at FROM users WHERE id = ?`
  ).bind(userId).first();
  let skipReason = permissionSkip(gate, target);
  if (!skipReason && action === 'quarantine' && target.quarantined_at) skipReason = '账号已处于隔离状态';
  if (!skipReason && action === 'unquarantine' && !target.quarantined_at) skipReason = '账号未处于隔离状态';

  if (!skipReason && (action === 'force_logout' || action === 'revoke_stepup')) {
    const state = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM sessions WHERE user_id = ?) AS session_count,
         (SELECT COUNT(*) FROM stepup_tokens WHERE user_id = ?) AS stepup_count`
    ).bind(userId, userId).first();
    const sessionCount = Number((state && state.session_count) || 0);
    const stepupCount = Number((state && state.stepup_count) || 0);
    if (action === 'force_logout' && sessionCount + stepupCount === 0) {
      skipReason = '账号没有可撤销的会话或近期认证';
    } else if (action === 'revoke_stepup' && stepupCount === 0) {
      skipReason = '账号没有可撤销的近期认证';
    }
  }
  if (!skipReason && action === 'release_devices') {
    const binding = await env.DB.prepare(
      `SELECT 1 AS found FROM device_accounts WHERE user_id = ? AND status = 'active' LIMIT 1`
    ).bind(userId).first();
    if (!binding) skipReason = '账号没有生效中的设备绑定';
  }
  return {
    user_id: userId,
    name: target ? target.name : null,
    will_process: !skipReason,
    skip_reason: skipReason || null,
  };
}

async function applyAction(env, gate, action, userId, reason) {
  if (action === 'quarantine') {
    // 单个账号内原子执行：打标、撤销两类凭据并释放生效设备绑定。
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE users SET quarantined_at = datetime('now'), quarantine_reason = ?, quarantined_by = ?
         WHERE id = ? AND quarantined_at IS NULL`
      ).bind(reason, gate.userId, userId),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
      env.DB.prepare('DELETE FROM stepup_tokens WHERE user_id = ?').bind(userId),
      env.DB.prepare(
        `UPDATE device_accounts SET status = 'released', released_at = datetime('now'),
         release_reason = 'quarantine' WHERE user_id = ? AND status = 'active'`
      ).bind(userId),
    ]);
    return '已隔离账号，并撤销会话、近期认证及设备绑定';
  }
  if (action === 'unquarantine') {
    await env.DB.prepare(
      `UPDATE users SET quarantined_at = NULL, quarantine_reason = NULL, quarantined_by = NULL
       WHERE id = ? AND quarantined_at IS NOT NULL`
    ).bind(userId).run();
    return '已解除账号隔离';
  }
  if (action === 'force_logout') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
      env.DB.prepare('DELETE FROM stepup_tokens WHERE user_id = ?').bind(userId),
    ]);
    return '已撤销账号全部会话及近期认证';
  }
  if (action === 'revoke_stepup') {
    await env.DB.prepare('DELETE FROM stepup_tokens WHERE user_id = ?').bind(userId).run();
    return '已撤销账号近期认证';
  }
  await env.DB.prepare(
    `UPDATE device_accounts SET status = 'released', released_at = datetime('now'), release_reason = ?
     WHERE user_id = ? AND status = 'active'`
  ).bind(reason || 'admin_release', userId).run();
  return '已释放账号全部生效设备绑定';
}

function targetSummary(ids) {
  const preview = ids.slice(0, 5).join(',');
  return `${ids.length}个账号:${preview}${ids.length > 5 ? '…' : ''}`;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return devErr('数据库未绑定', 500);
  try {
    const gate = await requireDeveloper(env, request, { stepup: true });
    if (!gate.ok) return gate.response;
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    if (!ACTIONS.has(action)) return devErr('未知操作', 400);
    // 预演必须按「将要执行的动作」检查当前状态，否则已隔离账号会被误算为可操作。
    const previewOperation = String(body.operation || '').trim();
    if (action === 'preview') {
      if (!ACTIONS.has(previewOperation) || previewOperation === 'preview') {
        return devErr('预演操作无效', 400);
      }
    }
    const effectiveAction = action === 'preview' ? previewOperation : action;
    const reason = String(body.reason || '').trim();
    if (reason.length > 200) return devErr('原因不能超过 200 个字符', 400);
    if (effectiveAction === 'quarantine' && !reason) return devErr('请填写隔离原因', 400);

    const rawIds = Array.isArray(body.user_ids) ? body.user_ids : [];
    const userIds = [...new Set(rawIds.map((id) => String(id || '').trim()))];
    if (!userIds.length || userIds.length > 50) return devErr('user_ids 去重后需包含 1-50 个账号', 400);
    if (userIds.some((id) => !id || id.length > 64)) return devErr('目标账号 ID 无效', 400);
    if (action !== 'preview') {
      const confirm = Number(body.confirm);
      if (!Number.isInteger(confirm) || confirm !== userIds.length) {
        return devErr(`确认数不符：请输入 ${userIds.length}`, 400, { expected: userIds.length });
      }
    }

    if (action === 'preview') {
      const targets = [];
      for (const userId of userIds) {
        try {
          targets.push(await assessTarget(env, gate, effectiveAction, userId));
        } catch (e) {
          console.error('[DEV-ACCOUNT-MANAGER] preview target error:', e.message);
          targets.push({ user_id: userId, name: null, will_process: false, skip_reason: '目标校验失败，请稍后重试' });
        }
      }
      const actionable = targets.filter((t) => t.will_process).length;
      return devJson({
        success: true,
        data: { targets, actionable, skipped: targets.length - actionable },
      });
    }

    const results = [];
    const ip = getClientIp(request);
    const cmeta = cfMeta(request);
    const ua = request.headers.get('User-Agent') || '';
    for (const userId of userIds) {
      try {
        // 每个目标都重新读取，避免使用预演或列表中的过期权限与状态。
        const check = await assessTarget(env, gate, effectiveAction, userId);
        if (!check.will_process) {
          results.push({ user_id: userId, status: 'skipped', reason: check.skip_reason });
          continue;
        }
        const message = await applyAction(env, gate, action, userId, reason);
        results.push({ user_id: userId, status: 'processed', reason: message });
        if (action === 'quarantine' || action === 'unquarantine') {
          await logRiskEvent(env, {
            event_type: action === 'quarantine' ? 'quarantine' : 'quarantine_lift',
            user_id: userId,
            ip,
            ...cmeta,
            ua,
            action: action === 'quarantine' ? 'quarantined' : 'allowed',
            risk_score: action === 'quarantine' ? 80 : 0,
            detail: { reason: reason || null, by: gate.userId, bulk: true },
          });
        }
      } catch (e) {
        // 单项目标失败只影响当前项，其他账号继续处理。
        console.error('[DEV-ACCOUNT-MANAGER] POST target error:', e.message);
        results.push({ user_id: userId, status: 'failed', reason: '操作失败，请稍后重试' });
      }
    }

    const processed = results.filter((r) => r.status === 'processed').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    await writeAdminAudit(env, {
      actorId: gate.userId,
      action: `bulk_${action}`,
      target: targetSummary(userIds),
      detail: { requested: userIds.length, processed, skipped, failed, reason: reason || null },
      request,
    });
    return devJson({
      success: true,
      data: { action, processed, skipped, failed, results },
    });
  } catch (e) {
    console.error('[DEV-ACCOUNT-MANAGER] POST error:', e.message);
    return devErr('服务器错误', 500);
  }
}
