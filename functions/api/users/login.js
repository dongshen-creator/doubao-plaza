// Cloudflare Pages Function - Login
// POST /api/users/login

import { signSupabaseJWT, generateToken } from '../_lib/jwt.js';

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

// V5.13 修复：登录暴力破解防护（原先密码可无限次试错）
// 失败尝试记录在 login_attempts 表（首次使用自动创建，与 recover.js 的 password_recovery_attempts 同一模式）：
// 同 IP 15 分钟内最多 10 次失败、同账号 15 分钟内最多 5 次失败
async function ensureLoginAttemptsTable(env) {
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS login_attempts (
        id TEXT PRIMARY KEY,
        identifier TEXT,
        ip_address TEXT,
        success INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )`
    ).run();
    await env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip_address, created_at)`
    ).run();
    await env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_login_attempts_ident ON login_attempts(identifier, created_at)`
    ).run();
    return true;
  } catch (e) {
    console.warn('[LOGIN] login_attempts 表创建失败:', e.message);
    return false;
  }
}

// 检查是否被锁定；并顺带清理 1 天前的旧记录（10% 概率触发）
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
    const { env } = context;
    const body = await context.request.json().catch(() => ({}));
    const { identifier, password } = body;

    if (!identifier || !password) {
      return Response.json({ success: false, error: '请输入账号和密码' });
    }

    const clientIP = context.request.headers.get('CF-Connecting-IP')
      || context.request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
      || 'unknown';

    // V5.13：暴力破解防护——失败过多直接锁定（先于密码校验，避免给爆破者做算力）
    const tableReady = await ensureLoginAttemptsTable(env);
    if (tableReady && await isLoginLocked(env, String(identifier), clientIP)) {
      return Response.json({ success: false, error: '登录尝试过于频繁，请 15 分钟后再试' });
    }

    const user = await env.DB.prepare(
      `SELECT * FROM users WHERE (doubao_id = ? OR agent_url = ?)`
    ).bind(identifier, identifier).first();

    // 记录尝试（失败场景）；成功场景在下方标记 success=1
    const attemptId = generateToken().slice(0, 24);
    if (tableReady) {
      env.DB.prepare(
        `INSERT INTO login_attempts (id, identifier, ip_address, success) VALUES (?, ?, ?, 0)`
      ).bind(attemptId, String(identifier).slice(0, 200), clientIP).run().catch(() => {});
    }

    if (!user) {
      return Response.json({ success: false, error: '账号或密码错误' });
    }

    const valid = await verifyPassword(password, user.password);
    if (!valid) {
      return Response.json({ success: false, error: '账号或密码错误' });
    }

    if (tableReady) {
      env.DB.prepare(`UPDATE login_attempts SET success = 1 WHERE id = ?`).bind(attemptId).run().catch(() => {});
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

    const userAgent = context.request.headers.get('User-Agent') || '';

    await env.DB.prepare(
      `UPDATE users SET last_login_at = datetime('now'), last_login_ip = ?, last_login_ua = ? WHERE id = ?`
    ).bind(clientIP, userAgent, user.id).run();

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
      last_login_ua: userAgent,
      pat_suffix: user.pat_suffix
    };

    return Response.json({ success: true, data: safeUser, token, supabase_token: supabaseToken });
  } catch (e) {
    return Response.json({ success: false, error: '服务器错误：' + e.message });
  }
}
