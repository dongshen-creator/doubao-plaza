// JWT 获取工具 — 通过 Supabase Edge Function 获取真实 Supabase Auth JWT
// 项目已迁移到 ES256 非对称签名，旧的 HS256 JWT Secret 不再可用
// 改为通过 Edge Function 在 Supabase Auth 中创建用户并获取真实 access_token
// JWT 包含 app_metadata.d1_user_id，RLS 通过 app_user_id() 函数读取

/**
 * 获取 Supabase 兼容的 JWT（通过 Edge Function）
 * @param {string} userId - D1 中的用户 ID
 * @param {object} env - Cloudflare 环境变量，需含 SUPABASE_EDGE_FUNCTION_URL 和 EDGE_PROXY_SECRET
 * @param {number} expiresIn - 保留参数（过期时间由 Supabase Auth 控制）
 * @returns {Promise<string>} JWT 字符串，失败时返回空字符串
 */
export async function signSupabaseJWT(userId, env, expiresIn) {
  const edgeFunctionUrl = env.SUPABASE_EDGE_FUNCTION_URL;
  const proxySecret = env.EDGE_PROXY_SECRET;

  if (!edgeFunctionUrl || !proxySecret) {
    console.warn('[JWT] SUPABASE_EDGE_FUNCTION_URL 或 EDGE_PROXY_SECRET 未配置，跳过 JWT 获取');
    return '';
  }

  try {
    const res = await fetch(edgeFunctionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proxy_secret: proxySecret,
        user_id: userId,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('[JWT] Edge Function 返回错误:', res.status, errText);
      return '';
    }

    const data = await res.json();
    if (!data.token) {
      console.error('[JWT] Edge Function 未返回 token:', JSON.stringify(data));
      return '';
    }

    return data.token;
  } catch (e) {
    console.error('[JWT] 调用 Edge Function 失败:', e.message);
    return '';
  }
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
