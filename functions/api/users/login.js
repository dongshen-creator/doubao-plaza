// Cloudflare Pages Function - Login
// POST /api/users/login
//
// V8.0 登录改造：
// - 昵称登录：identifier 依次匹配 豆包号 → 智能体链接 → name_norm（规范化昵称）
// - 设备准入：__Host-dp_device 标记必须存在/有效/未封禁（缺失时服务端补签，签发限流降级为不绑定而非拒绝登录）
// - 多维限流：既有 IP/账号 15 分钟失败锁定 + 撞库喷洒/持续攻击信号 → 要求 Turnstile 复验
// - IP 只信 CF-Connecting-IP（Cloudflare 可信边缘），不接受可伪造的 X-Forwarded-For
// - 隔离（quarantined/deactivated）账号在密码验证通过后以通用错误拒绝，不暴露隔离状态
// - 成功登录刷新 last_active_at（有效活跃），并清零该账号的失败记录（受害者不被持续锁定）

import { signSupabaseJWT, generateToken } from '../_lib/jwt.js';
import { normalizeName } from '../_lib/name.js';
import { verifyTurnstile } from '../_lib/turnstile.js';
import {
  getDeviceByCookie,
  issueDevice,
  deviceSetCookie,
  bindDeviceForUser,
  logRiskEvent,
  getClientIp,
  cfMeta,
} from '../_lib/device.js';

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return 'pbkdf2$100000$' +
    Array.from(salt, b => b.toString(16).padStart(2, '0')).join('') + '$' +
    Array.from(new Uint8Array(derivedBits), b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('pbkdf2$')) {
    return password === stored;
  }
  const parts = stored.split('$');
  const iterations = parseInt(parts[1]);
  const salt = new Uint8Array(parts[2].match(/.{2}/g).map(b => parseInt(b, 16)));
  const storedHash = parts[3];
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const computedHash = Array.from(new Uint8Array(derivedBits), b => b.toString(16).padStart(2, '0')).join('');
  // V5.13 修复：恒定时间比较，防止时序侧信道泄露哈希前缀
  if (computedHash.length !== storedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHash.length; i++) {
    diff |= computedHash.charCodeAt(i) ^ storedHash.charCodeAt(i);
  }
  return diff === 0;
}

// 登录尝试记录表（首次使用自动创建；V8.0 扩展 asn/country/canvas_hash/device_hash 列）
async function ensureLoginAttemptsTable(env) {
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS login_attempts (
        id TEXT PRIMARY KEY,
        identifier TEXT,
        ip_address TEXT,
        success INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        asn INTEGER,
        country TEXT,
        canvas_hash TEXT,
        device_hash TEXT
      )`
    ).run();
    await env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip_address, created_at)`
    ).run();
    await env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_login_attempts_ident ON login_attempts(identifier, created_at)`
    ).run();
    // 旧库补列（已存在则忽略）
    const cols = ['asn INTEGER', 'country TEXT', 'canvas_hash TEXT', 'device_hash TEXT'];
    for (const c of cols) {
      try { await env.DB.prepare(`ALTER TABLE login_attempts ADD COLUMN ${c}`).run(); } catch { /* 已存在 */ }
    }
    return true;
  } catch (e) {
    console.warn('[LOGIN] login_attempts 表创建失败:', e.message);
    return false;
  }
}

// 既有锁定规则：同 IP 15 分钟 ≥10 次失败、同账号 15 分钟 ≥5 次失败；顺带清理 1 天前旧记录（10% 概率）
async function isLoginLocked(env, identifier, clientIP) {
  try {
    const ipFails = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM login_attempts WHERE ip_address = ? AND success = 0 AND created_at > datetime('now', '-15 minutes')`
    ).bind(clientIP).first();
    if (ipFails && ipFails.cnt >= 10) return true;
    const identFails = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM login_attempts WHERE identifier = ? AND success = 0 AND created_at > datetime('now', '-15 minutes')`
    ).bind(identifier).first();
    if (identFails && identFails.cnt >= 5) return true;
    if (Math.random() < 0.1) {
      env.DB.prepare(`DELETE FROM login_attempts WHERE created_at < datetime('now', '-1 day')`).run().catch(() => {});
    }
    return false;
  } catch (e) {
    return false; // 表异常不阻塞登录
  }
}

// V8.0 撞库风险信号（未到锁定阈值但需复验）：
// - 喷洒：同 IP 15 分钟内尝试 ≥8 个不同账号
// - 持续：同账号 1 小时内失败 ≥8 次（跨 IP 低速撞库，低于 15 分钟窗口的锁定阈值）
async function loginRiskNeedsChallenge(env, identifier, clientIP) {
  try {
    const ipIdents = await env.DB.prepare(
      `SELECT COUNT(DISTINCT identifier) as cnt FROM login_attempts WHERE ip_address = ? AND created_at > datetime('now', '-15 minutes')`
    ).bind(clientIP).first();
    if (ipIdents && ipIdents.cnt >= 8) return { need: true, reason: 'ip_spray' };
    const identHour = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM login_attempts WHERE identifier = ? AND success = 0 AND created_at > datetime('now', '-1 hour')`
    ).bind(identifier).first();
    if (identHour && identHour.cnt >= 8) return { need: true, reason: 'ident_sustained' };
    return { need: false };
  } catch (e) {
    return { need: false };
  }
}

async function checkAndUpdatePunishment(env, userId) {
  if (!env.DB) throw new Error('数据库未绑定');
  const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId).first();
  if (!user) return null;
  if (user.privacy_setting === 'punished_whitelist' && user.punished_until) {
    const now = new Date().toISOString();
    if (user.punished_until < now) {
      await env.DB.prepare(
        `UPDATE users SET privacy_setting = 'searchable', punished_until = NULL, punish_reason = NULL WHERE id = ?`
      ).bind(userId).run();
      user.privacy_setting = 'searchable';
    }
  }
  return user;
}

export async function onRequestPost(context) {
  // 首先检查环境变量
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定，请在Cloudflare Pages设置中绑定D1数据库' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { env, request } = context;
    const body = await request.json().catch(() => ({}));
    const { identifier, password, turnstile_token, canvas_hash, canvas_status } = body;

    if (!identifier || !password) {
      return Response.json({ success: false, error: '请输入账号和密码' });
    }

    // V8.0：只信 Cloudflare 可信边缘头，不接受可伪造的 X-Forwarded-For
    const clientIP = getClientIp(request);
    const cmeta = cfMeta(request);
    const ua = request.headers.get('User-Agent') || '';

    // V5.13：暴力破解防护——失败过多直接锁定（先于密码校验，避免给爆破者做算力）
    const tableReady = await ensureLoginAttemptsTable(env);
    if (tableReady && await isLoginLocked(env, String(identifier), clientIP)) {
      await logRiskEvent(env, {
        event_type: 'login_fail', ip: clientIP, ...cmeta, ua,
        action: 'blocked', risk_score: 40,
        detail: { reason: 'locked', identifier: String(identifier).slice(0, 100) },
      });
      return Response.json({ success: false, error: '登录尝试过于频繁，请 15 分钟后再试' });
    }

    // V8.0：撞库风险信号 → 要求 Turnstile 复验（未配置密钥时 verifyTurnstile 自动放行）
    const risk = tableReady ? await loginRiskNeedsChallenge(env, String(identifier), clientIP) : { need: false };
    if (risk.need) {
      const ts = await verifyTurnstile(turnstile_token, env, clientIP);
      if (!ts.success) {
        await logRiskEvent(env, {
          event_type: 'login_fail', ip: clientIP, ...cmeta, ua,
          action: 'challenge', risk_score: 35,
          detail: { reason: risk.reason, identifier: String(identifier).slice(0, 100) },
        });
        return Response.json({
          success: false,
          need_turnstile: true,
          error: '登录环境存在风险，请完成人机验证',
        });
      }
    }

    // V8.0：昵称登录——优先级 豆包号 → 智能体链接 → 规范化昵称（与注册同一 normalizeName）
    const identStr = String(identifier).trim();
    let user = await env.DB.prepare(`SELECT * FROM users WHERE doubao_id = ?`).bind(identStr).first();
    if (!user) user = await env.DB.prepare(`SELECT * FROM users WHERE agent_url = ?`).bind(identStr).first();
    if (!user) {
      const norm = normalizeName(identStr);
      if (norm) user = await env.DB.prepare(`SELECT * FROM users WHERE name_norm = ?`).bind(norm).first();
    }

    // V8.0：设备标记解析（先于尝试记录，便于落 device_hash）
    // - 已有标记：有效则续期，封禁则拒
    // - 无标记：服务端补签（签发限流时降级为「不绑定」而非拒绝登录，避免共享出口 IP 用户无法登录）
    let device = null;
    let freshDevRaw = null;
    const devRes = await getDeviceByCookie(env, request);
    if (devRes.device) {
      if (devRes.device.status === 'banned') {
        await logRiskEvent(env, {
          event_type: 'login_fail', device_id: devRes.device.id,
          ip: clientIP, ...cmeta, ua, action: 'blocked', risk_score: 60,
          detail: { reason: 'banned_device', identifier: identStr.slice(0, 100) },
        });
        return Response.json({ success: false, error: '登录失败，请更换网络环境后重试' }, { status: 403 });
      }
      device = devRes.device;
      env.DB.prepare(`UPDATE devices SET last_seen_at = datetime('now') WHERE id = ?`)
        .bind(device.id).run().catch(() => {});
    } else {
      const iss = await issueDevice(env, { ip: clientIP });
      if (iss.ok) {
        freshDevRaw = iss.raw;
        device = await env.DB.prepare(`SELECT * FROM devices WHERE id = ?`).bind(iss.id).first();
      } else {
        // 签发限流：不阻塞登录，记录风险信号
        await logRiskEvent(env, {
          event_type: 'login_fail', ip: clientIP, ...cmeta, ua,
          action: 'allowed', risk_score: 20,
          detail: { reason: 'device_issue_limited', identifier: identStr.slice(0, 100) },
        });
      }
    }

    // 记录尝试（失败场景先落库）；成功场景在下方标记 success=1
    const attemptId = generateToken().slice(0, 24);
    if (tableReady) {
      env.DB.prepare(
        `INSERT INTO login_attempts (id, identifier, ip_address, success, asn, country, canvas_hash, device_hash)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
      ).bind(
        attemptId, identStr.slice(0, 200), clientIP,
        cmeta.asn, cmeta.country,
        canvas_hash ? String(canvas_hash).slice(0, 64) : null,
        device ? device.token_hash : null
      ).run().catch(() => {});
    }

    if (!user) {
      await logRiskEvent(env, {
        event_type: 'login_fail', ip: clientIP, ...cmeta, ua,
        canvas_hash: canvas_hash ? String(canvas_hash).slice(0, 64) : null,
        canvas_status: canvas_status || null,
        device_id: device && device.id,
        action: 'allowed', risk_score: 15,
        detail: { reason: 'unknown_identifier', identifier: identStr.slice(0, 100) },
      });
      return Response.json({ success: false, error: '账号或密码错误' });
    }

    const valid = await verifyPassword(password, user.password);
    if (!valid) {
      await logRiskEvent(env, {
        event_type: 'login_fail', user_id: user.id, ip: clientIP, ...cmeta, ua,
        canvas_hash: canvas_hash ? String(canvas_hash).slice(0, 64) : null,
        canvas_status: canvas_status || null,
        device_id: device && device.id,
        action: 'allowed', risk_score: 25,
        detail: { reason: 'bad_password' },
      });
      return Response.json({ success: false, error: '账号或密码错误' });
    }

    // V8.0：隔离（惩罚性隐身）/已停用账号——密码正确也以通用错误拒绝，不暴露隔离状态
    if (user.quarantined_at || user.deactivated_at) {
      await logRiskEvent(env, {
        event_type: 'login_fail', user_id: user.id, device_id: device && device.id,
        ip: clientIP, ...cmeta, ua, action: 'blocked', risk_score: 50,
        detail: { reason: 'quarantined' },
      });
      return Response.json({ success: false, error: '账号或密码错误' });
    }

    if (tableReady) {
      env.DB.prepare(`UPDATE login_attempts SET success = 1 WHERE id = ?`).bind(attemptId).run().catch(() => {});
      // 成功登录清零该账号的失败记录：受害者不因撞库尝试被持续锁定
      env.DB.prepare(`DELETE FROM login_attempts WHERE identifier = ? AND success = 0`)
        .bind(identStr.slice(0, 200)).run().catch(() => {});
    }

    // 如果是旧版明文密码，登录成功后升级为 PBKDF2 哈希
    if (!user.password || !user.password.startsWith('pbkdf2$')) {
      const hashedPassword = await hashPassword(password);
      await env.DB.prepare('UPDATE users SET password = ? WHERE id = ?').bind(hashedPassword, user.id).run();
    }

    await checkAndUpdatePunishment(env, user.id);

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await env.DB.prepare(
      `INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)`
    ).bind(user.id, token, expiresAt).run();

    // 签发 Supabase JWT（用于 RLS 鉴权）
    const supabaseToken = await signSupabaseJWT(user.id, env);

    // V8.0：最后有效活跃（仅成功认证刷新；匿名请求不得刷新）+ 缺 IP 账号登录补录标记
    await env.DB.prepare(
      `UPDATE users SET last_login_at = datetime('now'), last_active_at = datetime('now'),
        last_login_ip = ?, last_login_ua = ?,
        ip_backfilled_at = CASE WHEN registered_ip IS NULL OR registered_ip = '' THEN datetime('now') ELSE ip_backfilled_at END
       WHERE id = ?`
    ).bind(clientIP, ua, user.id).run();

    // V8.0：设备绑定（服务端唯一入口；已绑定其他账号不抢绑，只记录共享设备信号）
    if (device) {
      const bind = await bindDeviceForUser(env, device.id, user.id, 'login');
      if (!bind.ok && bind.reason === 'device_bound') {
        await logRiskEvent(env, {
          event_type: 'login_fail', user_id: user.id, device_id: device.id,
          ip: clientIP, ...cmeta, ua, action: 'allowed', risk_score: 30,
          detail: { reason: 'login_on_bound_device' },
        });
      }
    }

    await logRiskEvent(env, {
      event_type: 'login_ok', user_id: user.id, device_id: device && device.id,
      ip: clientIP, ...cmeta, ua,
      canvas_hash: canvas_hash ? String(canvas_hash).slice(0, 64) : null,
      canvas_status: canvas_status || null,
      action: 'allowed', risk_score: freshDevRaw ? 10 : 0,
      detail: { fresh_device: !!freshDevRaw },
    });

    // 安全地移除 password 字段
    const safeUser = {
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      bio: user.bio,
      doubao_id: user.doubao_id,
      agent_url: user.agent_url,
      is_developer: user.is_developer,
      privacy_setting: user.privacy_setting,
      invite_code: user.invite_code,
      created_at: user.created_at,
      updated_at: user.updated_at,
      last_login_at: user.last_login_at,
      last_login_ip: clientIP,
      last_login_ua: ua,
      pat_suffix: user.pat_suffix
    };

    const respHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (freshDevRaw) respHeaders['Set-Cookie'] = deviceSetCookie(freshDevRaw);

    return new Response(
      JSON.stringify({ success: true, data: safeUser, token, supabase_token: supabaseToken }),
      { status: 200, headers: respHeaders }
    );
  } catch (e) {
    console.error('[LOGIN] error:', e.message);
    return Response.json({ success: false, error: '登录失败，请稍后重试' });
  }
}
