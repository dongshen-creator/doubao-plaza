// JWT 签发工具 — 使用 Web Crypto API 签发 HS256 JWT
// 用于桥接 D1 自定义认证与 Supabase RLS（External JWT Generation 模式）
// PostgREST 只校验签名 + role + exp，不查 auth.users 表

function base64Url(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function textToBytes(str) {
  return new TextEncoder().encode(str);
}

/**
 * 签发 Supabase 兼容的 JWT
 * @param {string} userId - D1 中的用户 ID
 * @param {object} env - Cloudflare 环境变量，需含 SUPABASE_JWT_SECRET
 * @param {number} expiresIn - 过期时间（秒），默认 86400（24 小时）
 * @returns {Promise<string>} JWT 字符串
 */
export async function signSupabaseJWT(userId, env, expiresIn) {
  if (!env.SUPABASE_JWT_SECRET) {
    // JWT Secret 未配置，返回空字符串（前端会降级为 anon 模式）
    console.warn('[JWT] SUPABASE_JWT_SECRET 未配置，跳过 JWT 签发');
    return '';
  }

  const ttl = expiresIn || 86400; // 24 小时
  const now = Math.floor(Date.now() / 1000);
  const projectRef = env.SUPABASE_PROJECT_REF || 'qwslopgbfkvnxrkqlvjl';

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: `https://${projectRef}.supabase.co/auth/v1/`,
    sub: userId,
    aud: 'authenticated',
    exp: now + ttl,
    iat: now,
    role: 'authenticated',
    aal: 'aal1',
    session_id: crypto.randomUUID(),
    is_anonymous: false,
    app_metadata: { provider: 'custom' },
  };

  const headerB64 = base64Url(textToBytes(JSON.stringify(header)));
  const payloadB64 = base64Url(textToBytes(JSON.stringify(payload)));
  const data = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    textToBytes(env.SUPABASE_JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, textToBytes(data));
  return `${data}.${base64Url(new Uint8Array(sigBuf))}`;
}

/**
 * 统一鉴权：从 Authorization 头取 D1 token，校验会话有效性
 * @param {object} env - Cloudflare 环境变量
 * @param {Request} request - 请求对象
 * @returns {Promise<string|null>} user_id 或 null
 */
export async function getAuthUserId(env, request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const session = await env.DB.prepare(
    `SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
  return session ? session.user_id : null;
}

/**
 * 生成随机 token（32 字节十六进制）
 * @returns {string}
 */
export function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}
