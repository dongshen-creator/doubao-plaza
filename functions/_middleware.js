// Cloudflare Pages Function - 全局中间件（V8.0 惩罚性隐身统一拦截）
// 职责：所有带 Bearer 会话的请求，先查会话归属账号是否处于隔离 / 停用态。
//   - 命中 → 撤销该账号全部会话，返回与普通登出完全一致的 401 诱饵
//     （{"success":false,"error":"请先登录"}，与各端点未登录口径相同，不暴露隔离状态）
//   - 未命中 / 匿名请求 → 原样放行，公开端点不受影响
// 检查失败（DB 抖动）时放行：各端点自身仍有 getAuthUserId 鉴权兜底，
// 宁可漏检一次也不让数据库故障把全体用户误登出。
export async function onRequest(context) {
  const { request, env } = context;
  const auth = request.headers.get('Authorization') || '';
  if (!env.DB || !auth.startsWith('Bearer ')) return context.next();

  const token = auth.slice(7).trim();
  if (!token) return context.next();

  try {
    const row = await env.DB.prepare(
      `SELECT s.user_id AS uid, u.quarantined_at AS q, u.deactivated_at AS d
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    ).bind(token).first();

    if (row && (row.q || row.d)) {
      // 惩罚性隐身：撤销该账号全部会话（含其他设备），旧 token 立即失效
      await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(row.uid).run();
      return new Response(JSON.stringify({ success: false, error: '请先登录' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
  } catch (e) {
    console.error('[MIDDLEWARE] quarantine check failed:', e.message);
  }

  return context.next();
}
