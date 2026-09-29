// V8.0 第一方设备凭据
// - Cookie 名 __Host-dp_device（Secure + HttpOnly + Path=/，浏览器 JS 不可读）
// - 数据库只存 sha256(raw token)，原始标记不入库、不写日志
// - 一机一号由 device_accounts 的部分唯一索引在 DB 层保证（见 schema.sql）
// - IP 只信 CF-Connecting-IP（Cloudflare 可信边缘），不接受 X-Forwarded-For

const COOKIE_NAME = '__Host-dp_device';
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60; // 400 天

// 新设备签发限流：同 IP 每小时 / 每天上限
const CLAIM_HOURLY_LIMIT = 5;
const CLAIM_DAILY_LIMIT = 15;

export function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
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

// 注册/登录统一设备解析：
//   已有有效标记 → 返回 device + 当前 active 绑定账号
//   无标记       → 服务端签发新标记（保证不会死循环），返回 Set-Cookie 头
//   设备被封禁   → banned: true（调用方必须拒绝）
//   签发被限流   → rateLimited: true（调用方返回 429）
export async function resolveAuthDevice(env, request, ip) {
  const { raw, device } = await getDeviceByCookie(env, request);
  if (device) {
    if (device.status === 'banned') {
      return { banned: true, device, raw, fresh: false, header: null, bindingUserId: null };
    }
    env.DB.prepare(`UPDATE devices SET last_seen_at = datetime('now') WHERE id = ?`)
      .bind(device.id).run().catch(() => {});
    let bindingUserId = null;
    try {
      const b = await env.DB.prepare(
        `SELECT user_id FROM device_accounts WHERE device_id = ? AND status = 'active'`
      ).bind(device.id).first();
      bindingUserId = b ? b.user_id : null;
    } catch { /* 表异常不阻塞 */ }
    return { banned: false, device, raw, fresh: false, header: null, bindingUserId };
  }
  const issued = await issueDevice(env, { ip });
  if (!issued.ok) {
    return { rateLimited: issued.error === 'rate_limited', device: null, raw: null, fresh: false, header: null, bindingUserId: null };
  }
  const dev = await env.DB.prepare(`SELECT * FROM devices WHERE id = ?`).bind(issued.id).first();
  return { banned: false, device: dev, raw: issued.raw, fresh: true, header: deviceSetCookie(issued.raw), bindingUserId: null };
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
