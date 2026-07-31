// Cloudflare Pages Function - Password Recovery via Security Question
// GET /api/users/recover?user_id=xxx - 获取密保问题（含 IP 频率限制）
// POST /api/users/recover - 验证密保答案并重置密码（含多重防护）

import { signSupabaseJWT, generateToken } from '../_lib/jwt.js';

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

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
  // 恒定时间比较，防止时序攻击
  if (computedHash.length !== storedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHash.length; i++) {
    diff |= computedHash.charCodeAt(i) ^ storedHash.charCodeAt(i);
  }
  return diff === 0;
}

// 确保失败尝试表存在
async function ensureTables(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS password_recovery_attempts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ip_address TEXT,
      success INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`
  ).run().catch(() => {});
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_pra_user ON password_recovery_attempts(user_id, created_at)`
  ).run().catch(() => {});
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_pra_ip ON password_recovery_attempts(ip_address, created_at)`
  ).run().catch(() => {});
  // 迁移：确保 security 列存在
  await env.DB.prepare("ALTER TABLE users ADD COLUMN security_question TEXT").run().catch(() => {});
  await env.DB.prepare("ALTER TABLE users ADD COLUMN security_answer TEXT").run().catch(() => {});
  await env.DB.prepare("ALTER TABLE users ADD COLUMN security_question_changed_at TEXT").run().catch(() => {});
}

export async function onRequestGet(context) {
  if (!context.env.DB) {
    return Response.json({ success: false, error: '数据库未绑定' });
  }

  try {
    const { env } = context;
    await ensureTables(env);

    const clientIP = context.request.headers.get('CF-Connecting-IP')
      || context.request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
      || 'unknown';

    // IP 频率限制：同 IP 每小时最多请求 10 次密保问题
    const ipRequests = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM password_recovery_attempts WHERE ip_address = ? AND created_at > datetime('now', '-1 hour')`
    ).bind(clientIP).first();
    if (ipRequests && ipRequests.cnt >= 10) {
      return Response.json({ success: false, error: '请求过于频繁，请 1 小时后再试' });
    }

    const url = new URL(context.request.url);
    const userId = url.searchParams.get('user_id');

    if (!userId) {
      return Response.json({ success: false, error: '缺少用户ID' });
    }

    const user = await env.DB.prepare(
      `SELECT id, name, doubao_id, avatar, security_question FROM users WHERE id = ?`
    ).bind(userId).first();

    if (!user) {
      return Response.json({ success: false, error: '用户不存在' });
    }

    if (!user.security_question) {
      return Response.json({ success: false, error: '该账号未设置密保问题，无法找回' });
    }

    // 记录此 IP 的请求
    await env.DB.prepare(
      `INSERT INTO password_recovery_attempts (id, user_id, ip_address, success) VALUES (?, ?, ?, 0)`
    ).bind(genId(), userId, clientIP).run();

    return Response.json({
      success: true,
      data: {
        user_id: user.id,
        name: user.name,
        doubao_id: user.doubao_id,
        avatar: user.avatar,
        security_question: user.security_question
      }
    });
  } catch (e) {
    return Response.json({ success: false, error: '服务器错误：' + e.message });
  }
}

export async function onRequestPost(context) {
  if (!context.env.DB) {
    return Response.json({ success: false, error: '数据库未绑定' });
  }

  try {
    const { env } = context;
    await ensureTables(env);

    const clientIP = context.request.headers.get('CF-Connecting-IP')
      || context.request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
      || 'unknown';

    const body = await context.request.json().catch(() => ({}));
    const { user_id, security_answer, new_password } = body;

    if (!user_id || !security_answer || !new_password) {
      return Response.json({ success: false, error: '参数不完整' });
    }

    if (new_password.length < 6 || new_password.length > 32) {
      return Response.json({ success: false, error: '新密码长度必须为6-32位' });
    }

    // IP 频率限制：同 IP 每小时最多 5 次尝试
    const ipAttempts = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM password_recovery_attempts WHERE ip_address = ? AND created_at > datetime('now', '-1 hour')`
    ).bind(clientIP).first();
    if (ipAttempts && ipAttempts.cnt >= 5) {
      return Response.json({ success: false, error: '尝试次数过多，请 1 小时后再试' });
    }

    // 用户级锁定：同 user_id 每小时最多 3 次失败
    const userFails = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM password_recovery_attempts WHERE user_id = ? AND success = 0 AND created_at > datetime('now', '-1 hour')`
    ).bind(user_id).first();
    if (userFails && userFails.cnt >= 3) {
      return Response.json({ success: false, error: '该账号找回尝试次数过多，请 1 小时后再试' });
    }

    const user = await env.DB.prepare(
      `SELECT * FROM users WHERE id = ?`
    ).bind(user_id).first();

    if (!user) {
      return Response.json({ success: false, error: '用户不存在' });
    }

    if (!user.security_answer) {
      return Response.json({ success: false, error: '该账号未设置密保问题' });
    }

    // 记录本次尝试
    const attemptId = genId();
    await env.DB.prepare(
      `INSERT INTO password_recovery_attempts (id, user_id, ip_address, success) VALUES (?, ?, ?, 0)`
    ).bind(attemptId, user_id, clientIP).run();

    // 验证密保答案（恒定时间比较，防时序攻击）
    const answerValid = await verifyPassword(security_answer.trim(), user.security_answer);
    if (!answerValid) {
      return Response.json({ success: false, error: '密保答案错误' });
    }

    // 验证通过，更新尝试记录
    await env.DB.prepare(
      `UPDATE password_recovery_attempts SET success = 1 WHERE id = ?`
    ).bind(attemptId).run();

    // 重置密码
    const hashedPassword = await hashPassword(new_password);
    await env.DB.prepare(
      `UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(hashedPassword, user_id).run();

    // 删除该用户所有旧会话（防止旧设备继续使用旧密码登录后的 session）
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(user_id).run();

    // 创建新会话（24h 有效）
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)`
    ).bind(user_id, token, expiresAt).run();

    // 签发 Supabase JWT
    const supabaseToken = await signSupabaseJWT(user_id, env);

    const userAgent = context.request.headers.get('User-Agent') || '';
    await env.DB.prepare(
      `UPDATE users SET last_login_at = datetime('now'), last_login_ip = ?, last_login_ua = ? WHERE id = ?`
    ).bind(clientIP, userAgent, user_id).run();

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
      last_login_at: new Date().toISOString(),
      last_login_ip: clientIP,
      last_login_ua: userAgent,
      pat_suffix: user.pat_suffix
    };

    return Response.json({ success: true, data: safeUser, token, supabase_token: supabaseToken, message: '密码重置成功，已自动登录' });
  } catch (e) {
    return Response.json({ success: false, error: '服务器错误：' + e.message });
  }
}
