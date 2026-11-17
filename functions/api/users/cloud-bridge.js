// Cloudflare Pages Function - WorkBuddy 云会话桥
// POST /api/users/cloud-bridge
//
// V13.1：账号在 WorkBuddy 云服务（dp_auth_* RPC）完成认证后，
// 主站用“有效云令牌”换取一个 D1 会话令牌。这样前端仍只存 dp_token，
// 现有 58 个业务接口无需改动即可继续用 getAuthUserId() 鉴权。
//
// 安全边界：
// 1. 云令牌必须由 WorkBuddy 云数据面的 dp_auth_session RPC 验证为 ok=true；
// 2. 只接受来自已白名单发布域、带 X-DP-Client 的请求（由 _middleware.js 统一门禁）；
// 3. 不接收密码明文；hash 仅用于新镜像账号的 D1 密码字段，格式必须合法；
// 4. 角色/身份以云会话返回为准，前端传入的 is_developer 等字段一律忽略。

import { signSupabaseJWT, generateToken } from '../_lib/jwt.js';
import { normalizeName } from '../_lib/name.js';
import { getClientIp } from '../_lib/device.js';

const CLOUD_RPC_URL =
  'https://doubao-plaza-v11.app.workbuddy.host/.cloud/database/rest/v1/rpc/dp_auth_session';
const CLOUD_ACCESS_KEY = 'wbpk_5ErsgrS7fNKfn4IKKmMoat_77tZNn7eYNwZZq6t39KuJgumtRUYXHZ3';
const HASH_RE = /^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/;

function hex(arr) {
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function newId() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return hex(arr);
}

function impossibleHash() {
  const salt = new Uint8Array(16);
  const digest = new Uint8Array(32);
  crypto.getRandomValues(salt);
  crypto.getRandomValues(digest);
  return 'pbkdf2$100000$' + hex(salt) + '$' + hex(digest);
}

async function verifyCloudToken(token) {
  const res = await fetch(CLOUD_RPC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-wb-webapp-access-key': CLOUD_ACCESS_KEY,
      'Origin': 'https://doubao-plaza-v11.app.workbuddy.host',
    },
    body: JSON.stringify({ p_token: token }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('云服务校验失败：HTTP ' + res.status + (text ? ' ' + text.slice(0, 80) : ''));
  }
  const rows = await res.json().catch(() => null);
  if (!Array.isArray(rows) || !rows.length || !rows[0].ok) return null;
  return rows[0];
}

async function ensureMapTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS cloud_identity_map (
      cloud_uid TEXT PRIMARY KEY,
      d1_user_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`
  ).run();
}

function safeUser(user, clientIP, ua) {
  return {
    id: user.id,
    name: user.name,
    avatar: user.avatar || '',
    bio: user.bio || '',
    doubao_id: user.doubao_id || '',
    agent_url: user.agent_url || '',
    is_developer: user.is_developer || 0,
    is_global_admin: user.is_global_admin || 0,
    privacy_setting: user.privacy_setting || 'searchable',
    invite_code: user.invite_code || '',
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login_at: user.last_login_at,
    last_login_ip: clientIP,
    last_login_ua: ua,
    pat_suffix: user.pat_suffix || '',
  };
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) {
    return Response.json({ success: false, error: '数据库未绑定' }, { status: 500 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const cloudToken = String(body.token || '').trim();
    if (!cloudToken) return Response.json({ success: false, error: '缺少云会话令牌' });

    // 云令牌是唯一身份凭据；失败即拒绝，不提供任何降级旁路。
    const cloudUser = await verifyCloudToken(cloudToken);
    if (!cloudUser) return Response.json({ success: false, error: '云会话已失效，请重新登录' });

    const uid = String(cloudUser.uid || '').trim();
    const name = String(cloudUser.uname || '').trim();
    if (!uid || !name) return Response.json({ success: false, error: '云会话资料不完整' });

    const nameNorm = normalizeName(name);
    if (!nameNorm) return Response.json({ success: false, error: '昵称无效' });

    const doubaoId = String(cloudUser.doubao_id || body.doubao_id || '').trim().slice(0, 128) || null;
    const agentUrl = String(body.agent_url || '').trim().slice(0, 500) || null;
    const avatar = String(cloudUser.avatar || body.avatar || '').trim().slice(0, 1000) || '';
    const bio = String(cloudUser.bio || body.bio || '').trim().slice(0, 2000) || '';
    const password = HASH_RE.test(String(body.hash || '')) ? String(body.hash) : impossibleHash();

    const clientIP = getClientIp(request, env) || '';
    const ua = (request.headers.get('User-Agent') || '').slice(0, 500);

    await ensureMapTable(env);

    let map = await env.DB.prepare(
      `SELECT d1_user_id FROM cloud_identity_map WHERE cloud_uid = ?`
    ).bind(uid).first();

    let user = null;
    if (map && map.d1_user_id) {
      user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(map.d1_user_id).first();
    }
    if (!user && doubaoId) {
      user = await env.DB.prepare(`SELECT * FROM users WHERE doubao_id = ?`).bind(doubaoId).first();
    }
    if (!user && agentUrl) {
      user = await env.DB.prepare(`SELECT * FROM users WHERE agent_url = ?`).bind(agentUrl).first();
    }
    if (!user) {
      user = await env.DB.prepare(`SELECT * FROM users WHERE name_norm = ?`).bind(nameNorm).first();
    }

    if (!user) {
      const d1UserId = newId();
      await env.DB.prepare(
        `INSERT INTO users (
          id, name, name_norm, password, avatar, bio, doubao_id, agent_url,
          is_developer, is_global_admin, registered_ip, created_at, last_login_at, last_login_ua
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)`
      ).bind(
        d1UserId, name.slice(0, 64), nameNorm, password, avatar, bio,
        doubaoId, agentUrl,
        cloudUser.is_developer ? 1 : 0,
        cloudUser.is_global_admin ? 1 : 0,
        clientIP || null, ua || null
      ).run();
      user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(d1UserId).first();
    } else {
      await env.DB.prepare(
        `UPDATE users SET last_login_at = datetime('now'), last_active_at = datetime('now'),
          last_login_ip = ?, last_login_ua = ?,
          registered_ip = CASE WHEN registered_ip IS NULL OR registered_ip = '' THEN ? ELSE registered_ip END
         WHERE id = ?`
      ).bind(clientIP || null, ua || null, clientIP || null, user.id).run();
      user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(user.id).first();
    }

    if (!user) return Response.json({ success: false, error: '镜像用户创建失败' });

    if (!map) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO cloud_identity_map (cloud_uid, d1_user_id) VALUES (?, ?)`
      ).bind(uid, user.id).run();
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    await env.DB.prepare(
      `INSERT INTO sessions (user_id, token, expires_at, device_id, created_ip, last_seen_at)
       VALUES (?, ?, ?, NULL, ?, datetime('now'))`
    ).bind(user.id, token, expiresAt, clientIP || null).run();

    const supabaseToken = await signSupabaseJWT(user.id, env);

    return Response.json({
      success: true,
      token,
      supabase_token: supabaseToken,
      data: safeUser(user, clientIP, ua),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[CLOUD-BRIDGE] error:', e && e.message ? e.message : e);
    return Response.json({ success: false, error: '云会话桥接失败，请稍后重试' }, { status: 500 });
  }
}
