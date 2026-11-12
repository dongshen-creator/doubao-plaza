// Cloudflare Pages Function - Developer 设备检索与处置
// GET  /api/developer/devices?q=&status=&min_risk=&page=&page_size=
// POST /api/developer/devices { action:'ban'|'unban'|'release', device_id, reason? }
// 全部要求 step-up；旧库缺少封禁元数据列时动态降级，绝不读取设备 token_hash。
import { requireDeveloper, devJson, devErr } from '../_lib/devauth.js';
import { writeAdminAudit } from '../_lib/audit.js';
import { logRiskEvent, getClientIp, cfMeta } from '../_lib/device.js';

const TABLE_NAMES = new Set(['devices', 'device_accounts', 'device_signals', 'risk_events', 'sessions']);
const DEVICE_ACTIONS = new Set(['ban', 'unban', 'release']);

class InputError extends Error {}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (c) => '\\' + c);
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

async function tableColumns(env, table) {
  // PRAGMA 不支持绑定表名，因此所有调用都必须经过固定表白名单。
  if (!TABLE_NAMES.has(table)) throw new Error('非法表名');
  const rs = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(((rs && rs.results) || []).map((column) => column.name));
}

function deviceSelect(columns) {
  if (!columns.has('id')) return null;
  return [
    'd.id AS id',
    columns.has('status') ? "COALESCE(d.status, 'active') AS status" : "'active' AS status",
    columns.has('risk_level') ? 'COALESCE(d.risk_level, 0) AS risk_level' : '0 AS risk_level',
    columns.has('claim_count') ? 'COALESCE(d.claim_count, 0) AS claim_count' : '0 AS claim_count',
    columns.has('created_at') ? 'd.created_at AS created_at' : 'NULL AS created_at',
    columns.has('last_seen_at') ? 'd.last_seen_at AS last_seen_at' : 'NULL AS last_seen_at',
    columns.has('last_claim_at') ? 'd.last_claim_at AS last_claim_at' : 'NULL AS last_claim_at',
    columns.has('created_ip') ? 'd.created_ip AS created_ip' : 'NULL AS created_ip',
    columns.has('ban_reason') ? 'd.ban_reason AS ban_reason' : 'NULL AS ban_reason',
    columns.has('banned_at') ? 'd.banned_at AS banned_at' : 'NULL AS banned_at',
    columns.has('banned_by') ? 'd.banned_by AS banned_by' : 'NULL AS banned_by',
  ].join(', ');
}

function deviceFilters(url, columns) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const status = (url.searchParams.get('status') || 'all').trim();
  if (!['all', 'active', 'banned', 'retired'].includes(status)) throw new InputError('status 参数无效');
  const minRisk = integerParam(url, 'min_risk', 0, 0, 100);
  const page = integerParam(url, 'page', 1, 1, null);
  const pageSize = integerParam(url, 'page_size', 20, 1, 50);
  const where = [];
  const params = [];

  if (q) {
    const prefix = `${escapeLike(q)}%`;
    const userLike = `%${escapeLike(q)}%`;
    where.push(`(
      d.id = ? OR d.id LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM device_accounts qda
        JOIN users qu ON qu.id = qda.user_id
        WHERE qda.device_id = d.id
          AND (qu.id = ? OR qu.name LIKE ? ESCAPE '\\' OR qu.doubao_id LIKE ? ESCAPE '\\')
      )
    )`);
    params.push(q, prefix, q, userLike, userLike);
  }
  if (status !== 'all') {
    if (columns.has('status')) {
      where.push('d.status = ?');
      params.push(status);
    } else if (status !== 'active') {
      where.push('1 = 0');
    }
  }
  if (minRisk > 0) {
    if (columns.has('risk_level')) {
      where.push('COALESCE(d.risk_level, 0) >= ?');
      params.push(minRisk);
    } else {
      where.push('1 = 0');
    }
  }
  return { q, status, minRisk, page, pageSize, where, params };
}

async function supplementDevices(env, devices, signalColumns, riskColumns) {
  const canReadSignals = signalColumns.has('device_id');
  const canReadRisk = riskColumns.has('device_id') && riskColumns.has('risk_score') && riskColumns.has('created_at');
  const degraded = { signal_count: !canReadSignals, recent_risk_score: !canReadRisk };
  if (!devices.length) return { devices: [], degraded };
  const ids = devices.map((device) => device.id);
  const placeholders = ids.map(() => '?').join(',');
  const empty = Promise.resolve({ results: [] });

  const [bindingRs, countRs, signalRs, riskRs] = await Promise.all([
    env.DB.prepare(
      `SELECT da.device_id, da.user_id, da.bound_at, u.name, u.doubao_id, u.avatar
       FROM device_accounts da
       LEFT JOIN users u ON u.id = da.user_id
       WHERE da.device_id IN (${placeholders}) AND da.status = 'active'`
    ).bind(...ids).all(),
    env.DB.prepare(
      `SELECT device_id, COUNT(*) AS count FROM device_accounts
       WHERE device_id IN (${placeholders}) GROUP BY device_id`
    ).bind(...ids).all(),
    canReadSignals
      ? env.DB.prepare(
          `SELECT device_id, COUNT(*) AS count FROM device_signals
           WHERE device_id IN (${placeholders}) GROUP BY device_id`
        ).bind(...ids).all()
      : empty,
    canReadRisk
      ? env.DB.prepare(
          `SELECT r.device_id, r.risk_score FROM risk_events r
           WHERE r.device_id IN (${placeholders})
             AND r.rowid = (
               SELECT r2.rowid FROM risk_events r2
               WHERE r2.device_id = r.device_id
               ORDER BY datetime(r2.created_at) DESC, r2.rowid DESC LIMIT 1
             )`
        ).bind(...ids).all()
      : empty,
  ]);

  const activeBindings = new Map();
  for (const row of (bindingRs && bindingRs.results) || []) {
    activeBindings.set(row.device_id, {
      user_id: row.user_id,
      name: row.name || null,
      doubao_id: row.doubao_id || null,
      avatar: row.avatar || null,
      bound_at: row.bound_at || null,
    });
  }
  const bindingCounts = new Map(((countRs && countRs.results) || []).map((r) => [r.device_id, r.count]));
  const signalCounts = new Map(((signalRs && signalRs.results) || []).map((r) => [r.device_id, r.count]));
  const recentRisk = new Map(((riskRs && riskRs.results) || []).map((r) => [r.device_id, r.risk_score]));
  return {
    devices: devices.map((device) => ({
      ...device,
      active_binding: activeBindings.get(device.id) || null,
      binding_count: Number(bindingCounts.get(device.id) || 0),
      signal_count: Number(signalCounts.get(device.id) || 0),
      recent_risk_score: Number(recentRisk.get(device.id) || 0),
    })),
    degraded,
  };
}

async function deviceStats(env, columns) {
  const activeExpression = columns.has('status')
    ? "SUM(CASE WHEN COALESCE(status, 'active') = 'active' THEN 1 ELSE 0 END)"
    : 'COUNT(*)';
  const bannedExpression = columns.has('status')
    ? "SUM(CASE WHEN status = 'banned' THEN 1 ELSE 0 END)"
    : '0';
  const highRiskExpression = columns.has('risk_level')
    ? 'SUM(CASE WHEN COALESCE(risk_level, 0) >= 60 THEN 1 ELSE 0 END)'
    : '0';
  const row = await env.DB.prepare(
    `SELECT ${activeExpression} AS active, ${bannedExpression} AS banned,
            ${highRiskExpression} AS high_risk FROM devices`
  ).first();
  return {
    active: Number((row && row.active) || 0),
    banned: Number((row && row.banned) || 0),
    high_risk: Number((row && row.high_risk) || 0),
  };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return devErr('数据库未绑定', 500);
  try {
    const gate = await requireDeveloper(env, request, { stepup: true });
    if (!gate.ok) return gate.response;
    const columns = await tableColumns(env, 'devices');
    const select = deviceSelect(columns);
    if (!select) return devErr('设备表不存在或缺少设备 ID 列', 400);
    const filters = deviceFilters(new URL(request.url), columns);
    const whereSql = filters.where.length ? `WHERE ${filters.where.join(' AND ')}` : '';
    const offset = (filters.page - 1) * filters.pageSize;
    if (!Number.isSafeInteger(offset)) throw new InputError('页码过大');

    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM devices d ${whereSql}`
    ).bind(...filters.params).first();
    const total = Number((countRow && countRow.total) || 0);
    const orderSql = columns.has('created_at') ? 'datetime(d.created_at) DESC, d.id DESC' : 'd.id DESC';
    const rs = await env.DB.prepare(
      `SELECT ${select} FROM devices d ${whereSql}
       ORDER BY ${orderSql} LIMIT ? OFFSET ?`
    ).bind(...filters.params, filters.pageSize, offset).all();

    // device_signals 是可选表；PRAGMA 为空或缺列时仅将 signal_count 降级为 0。
    const signalColumns = await tableColumns(env, 'device_signals');
    const riskColumns = await tableColumns(env, 'risk_events');
    const supplemented = await supplementDevices(env, (rs && rs.results) || [], signalColumns, riskColumns);
    const stats = await deviceStats(env, columns);
    const pages = Math.ceil(total / filters.pageSize);

    await writeAdminAudit(env, {
      actorId: gate.userId,
      action: 'device_search',
      detail: {
        q_len: filters.q.length,
        status: filters.status,
        min_risk: filters.minRisk,
        page: filters.page,
        page_size: filters.pageSize,
        hits: supplemented.devices.length,
        total,
      },
      request,
    });
    return devJson({
      success: true,
      data: {
        devices: supplemented.devices,
        pagination: { page: filters.page, page_size: filters.pageSize, total, pages },
        stats,
        degraded: supplemented.degraded,
      },
    });
  } catch (e) {
    if (e instanceof InputError) return devErr(e.message, 400);
    console.error('[DEV-DEVICES] GET error:', e.message);
    return devErr('服务器错误', 500);
  }
}

async function findDevice(env, columns, deviceId) {
  const select = deviceSelect(columns);
  if (!select) return null;
  return env.DB.prepare(`SELECT ${select} FROM devices d WHERE d.id = ?`).bind(deviceId).first();
}

function deviceUpdate(columns, action, gate, reason) {
  const assignments = [];
  const params = [];
  if (columns.has('status')) assignments.push(`status = '${action === 'ban' ? 'banned' : 'active'}'`);
  if (columns.has('risk_level')) assignments.push(`risk_level = ${action === 'ban' ? '100' : '0'}`);
  if (action === 'ban') {
    if (columns.has('ban_reason')) {
      assignments.push('ban_reason = ?');
      params.push(reason);
    }
    if (columns.has('banned_at')) assignments.push("banned_at = datetime('now')");
    if (columns.has('banned_by')) {
      assignments.push('banned_by = ?');
      params.push(gate.userId);
    }
  } else {
    if (columns.has('ban_reason')) assignments.push('ban_reason = NULL');
    if (columns.has('banned_at')) assignments.push('banned_at = NULL');
    if (columns.has('banned_by')) assignments.push('banned_by = NULL');
  }
  return { assignments, params };
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return devErr('数据库未绑定', 500);
  try {
    const gate = await requireDeveloper(env, request, { stepup: true });
    if (!gate.ok) return gate.response;
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    if (!DEVICE_ACTIONS.has(action)) return devErr('未知操作', 400);
    const deviceId = String(body.device_id || '').trim();
    if (!deviceId || deviceId.length > 64) return devErr('设备 ID 无效', 400);
    const reason = String(body.reason || '').trim();
    if (reason.length > 200) return devErr('原因不能超过 200 个字符', 400);
    if (action === 'ban' && !reason) return devErr('请填写封禁原因', 400);

    const columns = await tableColumns(env, 'devices');
    if (!deviceSelect(columns)) return devErr('设备表不存在或缺少设备 ID 列', 400);
    const target = await findDevice(env, columns, deviceId);
    if (!target) return devErr('设备不存在', 404);
    if (action === 'ban' && target.status === 'banned') return devErr('设备已处于封禁状态', 400);
    if (action === 'unban' && target.status !== 'banned') return devErr('设备未处于封禁状态', 400);

    let activeUserIds = [];
    if (action === 'ban' || action === 'release') {
      const bindings = await env.DB.prepare(
        `SELECT user_id FROM device_accounts WHERE device_id = ? AND status = 'active'`
      ).bind(deviceId).all();
      activeUserIds = [...new Set(((bindings && bindings.results) || []).map((row) => row.user_id))];
      if (action === 'ban' && activeUserIds.includes(gate.userId)) {
        return devErr('不能封禁与当前操作者生效绑定的设备', 400);
      }
      if (action === 'release' && !activeUserIds.length) {
        return devErr('设备没有生效中的账号绑定', 400);
      }
    }

    if (action === 'ban' || action === 'unban') {
      const update = deviceUpdate(columns, action, gate, reason);
      if (!update.assignments.length) return devErr('设备表缺少可更新的状态字段', 400);
      if (action === 'unban') {
        // 解封只恢复设备状态与清理封禁元数据，不恢复历史会话或绑定。
        await env.DB.prepare(
          `UPDATE devices SET ${update.assignments.join(', ')} WHERE id = ?`
        ).bind(...update.params, deviceId).run();
      } else {
        const sessionColumns = await tableColumns(env, 'sessions');
        const statements = [
          env.DB.prepare(
            `UPDATE devices SET ${update.assignments.join(', ')} WHERE id = ?`
          ).bind(...update.params, deviceId),
          env.DB.prepare(
            `UPDATE device_accounts SET status = 'released', released_at = datetime('now'),
             release_reason = 'device_banned' WHERE device_id = ? AND status = 'active'`
          ).bind(deviceId),
        ];
        if (activeUserIds.length) {
          const placeholders = activeUserIds.map(() => '?').join(',');
          statements.push(
            env.DB.prepare(`DELETE FROM sessions WHERE user_id IN (${placeholders})`).bind(...activeUserIds),
            env.DB.prepare(`DELETE FROM stepup_tokens WHERE user_id IN (${placeholders})`).bind(...activeUserIds),
          );
        }
        if (sessionColumns.has('device_id')) {
          statements.push(env.DB.prepare('DELETE FROM sessions WHERE device_id = ?').bind(deviceId));
        }
        // 封禁、解绑和关联凭据撤销在同一批次中原子提交。
        await env.DB.batch(statements);
      }
    } else {
      await env.DB.prepare(
        `UPDATE device_accounts SET status = 'released', released_at = datetime('now'), release_reason = ?
         WHERE device_id = ? AND status = 'active'`
      ).bind(reason || 'admin_release', deviceId).run();
    }

    const device = await findDevice(env, columns, deviceId);
    const auditAction = `device_${action}`;
    await writeAdminAudit(env, {
      actorId: gate.userId,
      action: auditAction,
      target: deviceId,
      detail: { reason: reason || null, affected_users: activeUserIds.length },
      request,
    });
    await logRiskEvent(env, {
      event_type: auditAction,
      user_id: activeUserIds[0] || null,
      device_id: deviceId,
      ip: getClientIp(request),
      ...cfMeta(request),
      ua: request.headers.get('User-Agent') || '',
      action: action === 'ban' ? 'blocked' : 'allowed',
      risk_score: action === 'ban' ? 100 : 0,
      detail: { reason: reason || null, by: gate.userId, affected_users: activeUserIds.length },
    });

    const data = { action, device };
    if (action === 'release') data.released_count = activeUserIds.length;
    if (action === 'ban') data.revoked_user_count = activeUserIds.length;
    return devJson({ success: true, data });
  } catch (e) {
    console.error('[DEV-DEVICES] POST error:', e.message);
    return devErr('服务器错误', 500);
  }
}
