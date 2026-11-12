// V8.0 第一方设备凭据
// - Cookie 名 __Host-dp_device（Secure + HttpOnly + Path=/，浏览器 JS 不可读）
// - 数据库只存 sha256(raw token)，原始标记不入库、不写日志
// - 一机一号由 device_accounts 的部分唯一索引在 DB 层保证（见 schema.sql）
// - IP 只信 CF-Connecting-IP（Cloudflare 可信边缘）或反代 Worker 覆盖的 X-DP-Real-IP
//   （信任条件见 clientip.js：仅当边缘 CF-Connecting-IP 属 CF 官方网段时才采纳），
//   不接受 X-Forwarded-For

import { resolveClientIp } from './clientip.js';

const COOKIE_NAME = '__Host-dp_device';
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60; // 400 天

// 新设备签发限流：同 IP 每小时 / 每天上限
const CLAIM_HOURLY_LIMIT = 5;
const CLAIM_DAILY_LIMIT = 15;

export function getClientIp(request) {
  return resolveClientIp(request) || 'unknown';
}

export function cfMeta(request) {
  const cf = request.cf || {};
  return {
    asn: typeof cf.asn === 'number' ? cf.asn : null,
    country: cf.country || null,
    colo: cf.colo || null,
  };
}

export function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('Cookie');
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export async function hashToken(raw) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(bytes) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

export function deviceSetCookie(raw) {
  return `${COOKIE_NAME}=${raw}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
}

export function deviceClearCookie() {
  return `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function deviceCookieName() {
  return COOKIE_NAME;
}

// 读取 Cookie 并解析设备行；无 Cookie / 无效返回 { raw: null, device: null }
export async function getDeviceByCookie(env, request) {
  const raw = parseCookies(request)[COOKIE_NAME];
  if (!raw || raw.length < 32 || raw.length > 128) return { raw: null, device: null };
  const hash = await hashToken(raw);
  const device = await env.DB.prepare(`SELECT * FROM devices WHERE token_hash = ?`).bind(hash).first();
  if (!device) return { raw, device: null };
  return { raw, device, hash };
}

// 签发新设备标记（限流 + 风险记录由调用方负责）
export async function issueDevice(env, { ip }) {
  try {
    const hour = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM devices WHERE created_ip = ? AND created_at > datetime('now', '-1 hour')`
    ).bind(ip).first();
    const day = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM devices WHERE created_ip = ? AND created_at > datetime('now', '-24 hours')`
    ).bind(ip).first();
    if ((hour && hour.c >= CLAIM_HOURLY_LIMIT) || (day && day.c >= CLAIM_DAILY_LIMIT)) {
      return { ok: false, error: 'rate_limited' };
    }
    const raw = randomHex(32);
    const hash = await hashToken(raw);
    const id = randomHex(16);
    await env.DB.prepare(
      `INSERT INTO devices (id, token_hash, claim_count, created_ip, last_seen_at, last_claim_at)
       VALUES (?, ?, 1, ?, datetime('now'), datetime('now'))`
    ).bind(id, hash, ip).run();
    return { ok: true, raw, id };
  } catch (e) {
    console.warn('[DEVICE] issue failed:', e.message);
    return { ok: false, error: 'issue_failed' };
  }
}

// 风控事件落库（调用方保证 detail 已脱敏；失败不阻塞主流程）
export async function logRiskEvent(env, ev) {
  try {
    await env.DB.prepare(
      `INSERT INTO risk_events
       (user_id, device_id, event_type, ip, asn, country, colo, ua, canvas_hash, canvas_status, risk_score, action, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      ev.user_id ?? null,
      ev.device_id ?? null,
      ev.event_type,
      ev.ip ?? null,
      ev.asn ?? null,
      ev.country ?? null,
      ev.colo ?? null,
      (ev.ua || '').slice(0, 300) || null,
      ev.canvas_hash ?? null,
      ev.canvas_status ?? null,
      ev.risk_score ?? 0,
      ev.action ?? 'allowed',
      ev.detail ? JSON.stringify(ev.detail).slice(0, 2000) : null
    ).run();
  } catch (e) {
    console.warn('[RISK] log failed:', e.message);
  }
}

// V11.0 多维设备信号：Cookie 只是凭据载体，不再是唯一身份依据。
// 指纹/环境/网络分别散列后入库；必须命中一个高熵信号和一个独立辅助信号才允许恢复设备。
let deviceSignalSchemaPromise = null;

export async function ensureDeviceSignalSchema(env) {
  if (!deviceSignalSchemaPromise) {
    deviceSignalSchemaPromise = (async () => {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS device_signals (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          device_id TEXT NOT NULL,
          signal_type TEXT NOT NULL,
          signal_hash TEXT NOT NULL,
          first_seen_at TEXT DEFAULT (datetime('now')),
          last_seen_at TEXT DEFAULT (datetime('now')),
          seen_count INTEGER DEFAULT 1,
          last_ip TEXT,
          last_asn INTEGER,
          UNIQUE(device_id, signal_type, signal_hash)
        )`
      ).run();
      await env.DB.prepare(
        `CREATE INDEX IF NOT EXISTS idx_device_signals_lookup
         ON device_signals(signal_type, signal_hash, last_seen_at)`
      ).run();
      await env.DB.prepare(
        `CREATE INDEX IF NOT EXISTS idx_device_signals_device ON device_signals(device_id, last_seen_at)`
      ).run();
      const additions = [
        'devices ADD COLUMN ban_reason TEXT',
        'devices ADD COLUMN banned_at TEXT',
        'devices ADD COLUMN banned_by TEXT',
        'sessions ADD COLUMN device_id TEXT',
        'sessions ADD COLUMN created_ip TEXT',
        'sessions ADD COLUMN last_seen_at TEXT',
      ];
      for (const addition of additions) {
        try { await env.DB.prepare(`ALTER TABLE ${addition}`).run(); } catch { /* 已存在 */ }
      }
      try {
        await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_id, expires_at)').run();
      } catch (error) {
        // 索引是可降级的查询优化，但必须把模块级 promise 置空，下一次请求才真正重试 DDL。
        console.warn('[DEVICE] session device index deferred:', error.message);
        deviceSignalSchemaPromise = null;
      }
    })().catch((error) => {
      deviceSignalSchemaPromise = null;
      throw error;
    });
  }
  return deviceSignalSchemaPromise;
}

function cleanText(value, max = 160) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  // V11.0：超长输入直接丢弃，避免静默截断后生成可预测的固定信号散列。
  return trimmed.length <= max ? trimmed : '';
}

function networkPrefix(ip) {
  const value = String(ip || '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value.split('.').slice(0, 3).join('.') + '.0/24';
  if (value.includes(':')) return value.split(':').filter(Boolean).slice(0, 4).join(':') + '::/64';
  return '';
}

function normalizeDeviceContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const keys = ['screen', 'timezone', 'languages', 'platform', 'hardware', 'webgl', 'audio'];
  const normalized = {};
  let present = 0;
  for (const key of keys) {
    normalized[key] = cleanText(context[key], key === 'webgl' ? 240 : 160);
    if (normalized[key]) present += 1;
  }
  // 只有时区/语言等低熵字段时不生成环境信号，避免把大量用户错误聚成同一设备。
  return present >= 3 && (normalized.screen || normalized.webgl || normalized.audio) ? normalized : null;
}

export async function buildDeviceSignals(hints, request, ip) {
  const input = hints && typeof hints === 'object' ? hints : {};
  const meta = cfMeta(request);
  const rawSignals = [];
  const fingerprint = cleanText(input.device_fingerprint, 128);
  const canvas = cleanText(input.canvas_hash, 128).toLowerCase();
  const seed = cleanText(input.device_seed, 128).toLowerCase();
  if (/^[a-zA-Z0-9_-]{8,128}$/.test(fingerprint)) rawSignals.push(['fingerprint', fingerprint, 45]);
  if (/^[a-f0-9]{32,128}$/.test(canvas)) rawSignals.push(['canvas', canvas, 35]);
  // 浏览器三槽持久标识（localStorage / IndexedDB / CacheStorage），清 Cookie 不随之消失。
  if (/^[a-f0-9]{32,128}$/.test(seed)) rawSignals.push(['persistent', seed, 50]);
  const context = normalizeDeviceContext(input.device_context);
  if (context) rawSignals.push(['context', JSON.stringify(context), 20]);
  const prefix = networkPrefix(ip);
  if (prefix) rawSignals.push(['network', `${prefix}|${meta.asn || 'unknown'}`, 10]);
  const signals = [];
  for (const [type, raw, weight] of rawSignals) {
    signals.push({ type, hash: await hashToken(`dp-v1:${type}:${raw}`), weight });
  }
  return signals;
}

async function activeBindingUser(env, deviceId) {
  try {
    const binding = await env.DB.prepare(
      `SELECT user_id FROM device_accounts WHERE device_id = ? AND status = 'active'`
    ).bind(deviceId).first();
    return binding ? binding.user_id : null;
  } catch {
    return null;
  }
}

async function matchDeviceBySignals(env, signals) {
  if (!signals.length) return null;
  const candidates = new Map();
  for (const signal of signals) {
    try {
      const rows = await env.DB.prepare(
        `SELECT device_id, last_seen_at FROM device_signals
         WHERE signal_type = ? AND signal_hash = ? ORDER BY last_seen_at DESC LIMIT 20`
      ).bind(signal.type, signal.hash).all();
      for (const row of (rows && rows.results) || []) {
        const current = candidates.get(row.device_id) || {
          deviceId: row.device_id, score: 0, types: new Set(), lastSeen: row.last_seen_at,
        };
        if (!current.types.has(signal.type)) {
          current.types.add(signal.type);
          current.score += signal.weight;
        }
        if (String(row.last_seen_at || '') > String(current.lastSeen || '')) current.lastSeen = row.last_seen_at;
        candidates.set(row.device_id, current);
      }
    } catch { /* 单个信号查询失败时继续其他独立信号 */ }
  }
  const ranked = [...candidates.values()].filter((candidate) =>
    candidate.score >= 65 && candidate.types.size >= 2 &&
    (candidate.types.has('fingerprint') || candidate.types.has('canvas') || candidate.types.has('persistent'))
  ).sort((a, b) => b.score - a.score || String(b.lastSeen).localeCompare(String(a.lastSeen)));
  if (!ranked.length || (ranked[1] && ranked[1].score === ranked[0].score)) return null;
  const device = await env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(ranked[0].deviceId).first();
  return device ? {
    device,
    score: ranked[0].score,
    signals: [...ranked[0].types],
  } : null;
}

async function rotateDeviceCredential(env, deviceId) {
  const raw = randomHex(32);
  const hash = await hashToken(raw);
  await env.DB.prepare(
    `UPDATE devices SET token_hash = ?, claim_count = COALESCE(claim_count, 0) + 1,
     last_seen_at = datetime('now'), last_claim_at = datetime('now') WHERE id = ?`
  ).bind(hash, deviceId).run();
  return raw;
}

// 只在注册、密码登录或受信自动登录成功后写入，避免失败尝试污染设备画像。
export async function observeDeviceSignals(env, deviceId, hints, request, ip) {
  if (!deviceId) return;
  try {
    await ensureDeviceSignalSchema(env);
    const signals = await buildDeviceSignals(hints, request, ip);
    if (!signals.length) return;
    const meta = cfMeta(request);
    await env.DB.batch(signals.map((signal) => env.DB.prepare(
      `INSERT INTO device_signals (device_id, signal_type, signal_hash, last_ip, last_asn)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(device_id, signal_type, signal_hash) DO UPDATE SET
         last_seen_at = datetime('now'), seen_count = COALESCE(seen_count, 0) + 1,
         last_ip = excluded.last_ip, last_asn = excluded.last_asn`
    ).bind(deviceId, signal.type, signal.hash, ip || null, meta.asn)));
  } catch (error) {
    console.warn('[DEVICE] signal observe failed:', error.message);
  }
}

// 注册/登录统一设备解析：
//   有效 Cookie → 使用服务端设备记录；Cookie 被清除 → 多维信号恢复并轮换凭据；
//   强信号不足 → 签发新设备；封禁状态在恢复前后均检查，不能只靠清 Cookie 绕过。
export async function resolveAuthDevice(env, request, ip, hints = {}) {
  try { await ensureDeviceSignalSchema(env); } catch (error) {
    console.warn('[DEVICE] signal schema unavailable:', error.message);
  }
  const { raw, device } = await getDeviceByCookie(env, request);
  if (device) {
    if (device.status === 'banned') {
      return {
        banned: true, device, raw, fresh: false, recovered: false, header: null, bindingUserId: null,
        matchScore: 100, matchedSignals: [],
      };
    }
    env.DB.prepare(`UPDATE devices SET last_seen_at = datetime('now') WHERE id = ?`)
      .bind(device.id).run().catch(() => {});
    const bindingUserId = await activeBindingUser(env, device.id);
    return {
      banned: false, device, raw, fresh: false, recovered: false, header: null, bindingUserId,
      matchScore: 100, matchedSignals: [],
    };
  }

  try {
    const signals = await buildDeviceSignals(hints, request, ip);
    const matched = await matchDeviceBySignals(env, signals);
    if (matched) {
      // 封禁设备一旦被识别就立即拒绝，绝不轮换凭据或下发新 Cookie。
      if (matched.device.status === 'banned') {
        return {
          banned: true, device: matched.device, raw: null, fresh: false, recovered: true,
          header: null, bindingUserId: null, matchScore: matched.score, matchedSignals: matched.signals,
        };
      }
      const rotatedRaw = await rotateDeviceCredential(env, matched.device.id);
      const bindingUserId = await activeBindingUser(env, matched.device.id);
      return {
        banned: matched.device.status === 'banned',
        device: { ...matched.device, token_hash: await hashToken(rotatedRaw) },
        raw: rotatedRaw,
        fresh: true,
        recovered: true,
        header: deviceSetCookie(rotatedRaw),
        bindingUserId,
        matchScore: matched.score,
        matchedSignals: matched.signals,
      };
    }
  } catch (error) {
    console.warn('[DEVICE] signal recovery failed:', error.message);
  }

  const issued = await issueDevice(env, { ip });
  if (!issued.ok) {
    return { rateLimited: issued.error === 'rate_limited', device: null, raw: null, fresh: false, recovered: false, header: null, bindingUserId: null };
  }
  const dev = await env.DB.prepare(`SELECT * FROM devices WHERE id = ?`).bind(issued.id).first();
  return { banned: false, device: dev, raw: issued.raw, fresh: true, recovered: false, header: deviceSetCookie(issued.raw), bindingUserId: null, matchScore: 0 };
}

// 绑定设备到账号（服务端唯一绑定入口；并发冲突由部分唯一索引拒绝）
export async function bindDeviceForUser(env, deviceId, userId, reason = 'register') {
  try {
    const existing = await env.DB.prepare(
      `SELECT status FROM device_accounts WHERE device_id = ? AND user_id = ?`
    ).bind(deviceId, userId).first();
    if (existing) {
      if (existing.status === 'active') return { ok: true, already: true };
      await env.DB.prepare(
        `UPDATE device_accounts SET status = 'active', released_at = NULL, release_reason = NULL WHERE device_id = ? AND user_id = ?`
      ).bind(deviceId, userId).run();
      return { ok: true, rebound: true };
    }
    await env.DB.prepare(
      `INSERT INTO device_accounts (device_id, user_id, status) VALUES (?, ?, 'active')`
    ).bind(deviceId, userId).run();
    return { ok: true };
  } catch (e) {
    const msg = String(e && e.message || e);
    if (msg.includes('UNIQUE') || msg.includes('constraint')) {
      return { ok: false, reason: 'device_bound' };
    }
    console.warn('[DEVICE] bind failed:', msg);
    return { ok: false, reason: 'error' };
  }
}

// 服务端解除绑定（共享设备/误判处理；审计由调用方写 admin_audit_log）
export async function releaseDeviceBinding(env, deviceId, userId, operatorId, why) {
  await env.DB.prepare(
    `UPDATE device_accounts SET status = 'released', released_at = datetime('now'), release_reason = ?
     WHERE device_id = ? AND user_id = ? AND status = 'active'`
  ).bind(why || 'admin_release', deviceId, userId).run();
  await logRiskEvent(env, {
    event_type: 'device_rebind',
    device_id: deviceId,
    user_id: userId,
    ip: null,
    action: 'allowed',
    detail: { operator: operatorId, why: why || 'admin_release' },
  });
}
