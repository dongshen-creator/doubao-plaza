// V8.0 开发者通道统一鉴权（服务端强制，前端隐藏不作安全边界）
// - 基础门槛：有效会话 + (is_developer=1 或 is_global_admin=1)（且非隔离/停用）
// - step-up 门槛：高风险操作还需 X-Stepup-Token（10 分钟内有效的近期认证）
import { getAuthUserId } from './jwt.js';

export function isDeveloperFlag(v) {
  return v === 1 || v === '1' || v === true;
}

// 全局管理员标识（v9.2）：与开发者同权通过 devauth，但身份标记独立
export function isGlobalAdminFlag(v) {
  return v === 1 || v === '1' || v === true;
}

// 站务管理权 = 开发者 或 全局管理员（隔离/停用判定由调用方负责）
export function isSiteAdmin(user) {
  return !!(user && (isDeveloperFlag(user.is_developer) || isGlobalAdminFlag(user.is_global_admin)));
}

// 统一 JSON 响应：敏感后台一律 no-store，不落任何缓存
export function devJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function devErr(error, status, extra = {}) {
  return devJson({ success: false, error, ...extra }, status);
}

/**
 * 开发者鉴权
 * @param {object} env
 * @param {Request} request
 * @param {object} opts - { stepup: true } 时要求有效 X-Stepup-Token
 * @returns {Promise<{ok:true, userId:string, user:object} | {ok:false, response:Response}>>
 */
export async function requireDeveloper(env, request, opts = {}) {
  const userId = await getAuthUserId(env, request);
  if (!userId) {
    return { ok: false, response: devErr('未登录', 401) };
  }
  const user = await env.DB.prepare(
    `SELECT id, name, is_developer, is_global_admin, totp_enabled, quarantined_at, deactivated_at FROM users WHERE id = ?`
  ).bind(userId).first();
  // 隔离 / 停用账号即使历史是开发者也不再放行（惩罚性隐身的统一出口）
  if (!user || !isSiteAdmin(user) || user.quarantined_at || user.deactivated_at) {
    return { ok: false, response: devErr('无权限', 403) };
  }
  if (opts.stepup) {
    const sToken = request.headers.get('X-Stepup-Token') || '';
    const rec = sToken
      ? await env.DB.prepare(
          `SELECT token FROM stepup_tokens
           WHERE token = ? AND user_id = ? AND expires_at > datetime('now')`
        ).bind(sToken, userId).first()
      : null;
    if (!rec) {
      return { ok: false, response: devErr('需要重新验证身份', 403, { need_stepup: true }) };
    }
  }
  return { ok: true, userId, user };
}
