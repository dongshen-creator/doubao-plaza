// Cloudflare Pages Function - Developer 风控 / 安全 / 登录事件查询
// GET /api/developer/risk?source=risk|security|login&days=1|7|30|90&limit=100
// 可选筛选：event_type、user_id、device_id、ip、action、kind、success（按数据源适用）。
// 全部要求 step-up；表不存在返回明确 400，审计 detail 仅记录 source/days/limit。
import { requireDeveloper, devJson, devErr } from '../_lib/devauth.js';
import { writeAdminAudit } from '../_lib/audit.js';

const SOURCES = {
  risk: {
    table: 'risk_events',
    label: '风险事件表',
    select: `SELECT r.id, r.user_id, u.name AS name, r.device_id, r.event_type,
      r.ip, r.asn, r.country, r.colo, r.ua, r.canvas_hash, r.canvas_status,
      r.risk_score, r.action, r.detail, r.created_at
      FROM risk_events r LEFT JOIN users u ON u.id = r.user_id`,
    summaryFrom: 'FROM risk_events r LEFT JOIN users u ON u.id = r.user_id',
    order: 'datetime(r.created_at) DESC, r.id DESC',
  },
  security: {
    table: 'security_events',
    label: '安全事件表',
    select: `SELECT s.id, s.kind, s.ip, s.path, s.user_id, s.detail, s.created_at
      FROM security_events s`,
    summaryFrom: 'FROM security_events s',
    order: 'datetime(s.created_at) DESC, s.id DESC',
  },
  login: {
    table: 'login_attempts',
    label: '登录尝试表',
    select: `SELECT l.id, l.identifier, l.ip_address, l.success, l.created_at,
      l.asn, l.country, l.canvas_hash, l.device_hash
      FROM login_attempts l`,
    summaryFrom: 'FROM login_attempts l',
    order: 'datetime(l.created_at) DESC, l.id DESC',
  },
};
const DAY_OPTIONS = ['1', '7', '30', '90'];

class InputError extends Error {}

function textParam(url, name, maxLength) {
  return (url.searchParams.get(name) || '').trim().slice(0, maxLength);
}

function parseQuery(url) {
  const source = (url.searchParams.get('source') || 'risk').trim();
  if (!Object.prototype.hasOwnProperty.call(SOURCES, source)) throw new InputError('source 参数无效');
  const daysText = (url.searchParams.get('days') || '7').trim();
  if (!DAY_OPTIONS.includes(daysText)) throw new InputError('days 仅支持 1、7、30、90');
  const limitText = url.searchParams.get('limit');
  let limit = 100;
  if (limitText !== null && limitText !== '') {
    if (!/^\d+$/.test(limitText)) throw new InputError('limit 必须是整数');
    limit = Number(limitText);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new InputError('limit 需在 1-200 之间');
    }
  }
  const successText = (url.searchParams.get('success') || '').trim().toLowerCase();
  let success = null;
  if (successText) {
    if (!['0', '1', 'false', 'true'].includes(successText)) {
      throw new InputError('success 仅支持 0、1、false、true');
    }
    success = successText === '1' || successText === 'true' ? 1 : 0;
  }
  return {
    source,
    days: Number(daysText),
    limit,
    eventType: textParam(url, 'event_type', 64),
    userId: textParam(url, 'user_id', 64),
    deviceId: textParam(url, 'device_id', 64),
    ip: textParam(url, 'ip', 100),
    action: textParam(url, 'action', 50),
    kind: textParam(url, 'kind', 50),
    success,
  };
}

function buildFilters(query) {
  const alias = query.source === 'risk' ? 'r' : query.source === 'security' ? 's' : 'l';
  const where = [`datetime(${alias}.created_at) >= datetime('now', ?)`];
  const params = [`-${query.days} days`];
  if (query.ip) {
    where.push(`${alias}.${query.source === 'login' ? 'ip_address' : 'ip'} = ?`);
    params.push(query.ip);
  }
  if (query.source === 'risk') {
    if (query.eventType) {
      where.push('r.event_type = ?');
      params.push(query.eventType);
    }
    if (query.userId) {
      where.push('r.user_id = ?');
      params.push(query.userId);
    }
    if (query.deviceId) {
      where.push('r.device_id = ?');
      params.push(query.deviceId);
    }
    if (query.action) {
      where.push('r.action = ?');
      params.push(query.action);
    }
  } else if (query.source === 'security') {
    if (query.userId) {
      where.push('s.user_id = ?');
      params.push(query.userId);
    }
    if (query.kind) {
      where.push('s.kind = ?');
      params.push(query.kind);
    }
  } else if (query.success !== null) {
    where.push('COALESCE(l.success, 0) = ?');
    params.push(query.success);
  }
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

async function riskSummary(env, config, whereSql, params) {
  const summary = await env.DB.prepare(
    `SELECT COUNT(*) AS filtered_count,
       COALESCE(SUM(CASE WHEN datetime(r.created_at) >= datetime('now', '-24 hours')
                         THEN 1 ELSE 0 END), 0) AS events_24h,
       COALESCE(SUM(CASE WHEN COALESCE(r.risk_score, 0) >= 60 THEN 1 ELSE 0 END), 0) AS high_risk_events,
       COALESCE(SUM(CASE WHEN r.action = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked_events
     ${config.summaryFrom} ${whereSql}`
  ).bind(...params).first();
  const types = await env.DB.prepare(
    `SELECT r.event_type, COUNT(*) AS count ${config.summaryFrom} ${whereSql}
     GROUP BY r.event_type ORDER BY count DESC, r.event_type ASC LIMIT 10`
  ).bind(...params).all();
  return {
    filtered_count: Number((summary && summary.filtered_count) || 0),
    '24h_events': Number((summary && summary.events_24h) || 0),
    high_risk_events: Number((summary && summary.high_risk_events) || 0),
    blocked_events: Number((summary && summary.blocked_events) || 0),
    event_types: (types && types.results) || [],
  };
}

async function securitySummary(env, config, whereSql, params) {
  const summary = await env.DB.prepare(
    `SELECT COUNT(*) AS filtered_count,
       COALESCE(SUM(CASE WHEN datetime(s.created_at) >= datetime('now', '-24 hours')
                         THEN 1 ELSE 0 END), 0) AS events_24h,
       COALESCE(SUM(CASE WHEN s.kind = 'gate_403' THEN 1 ELSE 0 END), 0) AS gate_403_events,
       COALESCE(SUM(CASE WHEN s.kind = 'honeypot' THEN 1 ELSE 0 END), 0) AS honeypot_events,
       COALESCE(SUM(CASE WHEN s.kind = 'rate_limited' THEN 1 ELSE 0 END), 0) AS rate_limited_events,
       COUNT(DISTINCT s.ip) AS unique_ips
     ${config.summaryFrom} ${whereSql}`
  ).bind(...params).first();
  const kinds = await env.DB.prepare(
    `SELECT s.kind, COUNT(*) AS count ${config.summaryFrom} ${whereSql}
     GROUP BY s.kind ORDER BY count DESC, s.kind ASC LIMIT 10`
  ).bind(...params).all();
  return {
    filtered_count: Number((summary && summary.filtered_count) || 0),
    '24h_events': Number((summary && summary.events_24h) || 0),
    gate_403_events: Number((summary && summary.gate_403_events) || 0),
    honeypot_events: Number((summary && summary.honeypot_events) || 0),
    rate_limited_events: Number((summary && summary.rate_limited_events) || 0),
    unique_ips: Number((summary && summary.unique_ips) || 0),
    kinds: (kinds && kinds.results) || [],
  };
}

async function loginSummary(env, config, whereSql, params) {
  const summary = await env.DB.prepare(
    `SELECT COUNT(*) AS filtered_count,
       COALESCE(SUM(CASE WHEN datetime(l.created_at) >= datetime('now', '-24 hours')
                         THEN 1 ELSE 0 END), 0) AS events_24h,
       COALESCE(SUM(CASE WHEN COALESCE(l.success, 0) = 1 THEN 1 ELSE 0 END), 0) AS successful_events,
       COALESCE(SUM(CASE WHEN COALESCE(l.success, 0) = 0 THEN 1 ELSE 0 END), 0) AS failed_events,
       COUNT(DISTINCT l.ip_address) AS unique_ips
     ${config.summaryFrom} ${whereSql}`
  ).bind(...params).first();
  return {
    filtered_count: Number((summary && summary.filtered_count) || 0),
    '24h_events': Number((summary && summary.events_24h) || 0),
    successful_events: Number((summary && summary.successful_events) || 0),
    failed_events: Number((summary && summary.failed_events) || 0),
    unique_ips: Number((summary && summary.unique_ips) || 0),
  };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return devErr('数据库未绑定', 500);
  try {
    const gate = await requireDeveloper(env, request, { stepup: true });
    if (!gate.ok) return gate.response;
    const query = parseQuery(new URL(request.url));
    const config = SOURCES[query.source];

    // 先查元数据，避免把“表不存在”的 SQL 错误直接暴露给调用方。
    const table = await env.DB.prepare(
      `SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`
    ).bind(config.table).first();
    if (!table) return devErr(`${config.label}不存在`, 400);

    const { whereSql, params } = buildFilters(query);
    const eventsRs = await env.DB.prepare(
      `${config.select} ${whereSql} ORDER BY ${config.order} LIMIT ?`
    ).bind(...params, query.limit).all();
    // 后台只需要比对信号，不返回完整客户端/设备散列。
    const events = ((eventsRs && eventsRs.results) || []).map((event) => {
      const row = { ...event };
      for (const key of ['canvas_hash', 'device_hash']) {
        if (row[key]) row[key] = `${String(row[key]).slice(0, 12)}…`;
      }
      return row;
    });
    let summary;
    if (query.source === 'risk') {
      summary = await riskSummary(env, config, whereSql, params);
    } else if (query.source === 'security') {
      summary = await securitySummary(env, config, whereSql, params);
    } else {
      summary = await loginSummary(env, config, whereSql, params);
    }

    await writeAdminAudit(env, {
      actorId: gate.userId,
      action: 'risk_view',
      detail: { source: query.source, days: query.days, limit: query.limit },
      request,
    });
    return devJson({
      success: true,
      data: { source: query.source, events, summary },
    });
  } catch (e) {
    if (e instanceof InputError) return devErr(e.message, 400);
    console.error('[DEV-RISK] GET error:', e.message);
    return devErr('服务器错误', 500);
  }
}
