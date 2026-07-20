// Cloudflare Pages Function - Reports API (举报系统)
// POST /api/reports - 举报用户

// 统一鉴权：从 Authorization 头取 token，校验会话有效性，返回 user_id 或 null
async function getAuthUserId(env, request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const session = await env.DB.prepare(
    `SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
  return session ? session.user_id : null;
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
    const { reporter_id, reported_id, reason } = body;

    if (!reporter_id || !reported_id) {
      return Response.json({ success: false, error: 'reporter_id 和 reported_id 是必填项' });
    }
    if (reporter_id === reported_id) {
      return Response.json({ success: false, error: '不能举报自己' });
    }

    // 鉴权：仅本人可发起举报
    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId || authUserId !== reporter_id) {
      return Response.json({ success: false, error: '无权操作，请先登录' }, { status: 403 });
    }

    // 检查是否已举报过（同一举报人30天内不能重复举报同一用户）
    const existing = await env.DB.prepare(
      `SELECT * FROM reports WHERE reporter_id = ? AND reported_id = ? AND created_at > datetime('now', '-30 days')`
    ).bind(reporter_id, reported_id).first();

    if (existing) {
      return Response.json({ success: false, error: '您已举报过该用户，30天内不能重复举报' });
    }

    // 创建举报记录
    await env.DB.prepare(
      `INSERT INTO reports (reporter_id, reported_id, reason) VALUES (?, ?, ?)`
    ).bind(reporter_id, reported_id, reason || null).run();

    // 获取被举报用户的当前举报统计
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();

    // 30天内不同举报人的数量
    const reports30d = await env.DB.prepare(
      `SELECT COUNT(DISTINCT reporter_id) as count FROM reports 
       WHERE reported_id = ? AND created_at > ?`
    ).bind(reported_id, thirtyDaysAgo).first();

    // 6个月内不同举报人的数量
    const reports6m = await env.DB.prepare(
      `SELECT COUNT(DISTINCT reporter_id) as count FROM reports 
       WHERE reported_id = ? AND created_at > ?`
    ).bind(reported_id, sixMonthsAgo).first();

    // 更新用户举报计数
    await env.DB.prepare(
      `UPDATE users SET report_count_30d = ?, report_count_6m = ? WHERE id = ?`
    ).bind(reports30d.count, reports6m.count, reported_id).run();

    // 检查惩罚条件
    const reportedUser = await env.DB.prepare(
      `SELECT * FROM users WHERE id = ?`
    ).bind(reported_id).first();

    let punishment = null;

    // 条件1：30天内被不同账号举报超过3次 → 强制白名单1个月
    if (reports30d.count >= 3 && reportedUser.privacy_setting !== 'punished_whitelist' && reportedUser.privacy_setting !== 'stealth') {
      const punishedUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await env.DB.prepare(
        `UPDATE users SET privacy_setting = 'punished_whitelist', punished_until = ?, punish_reason = '被多次举报' WHERE id = ?`
      ).bind(punishedUntil, reported_id).run();
      punishment = { type: 'punished_whitelist', until: punishedUntil, reason: '被多次举报，已强制开启白名单模式' };
    }

    // 条件2：6个月内被不同账号举报超过10次 → 强制隐身
    if (reports6m.count >= 10 && reportedUser.privacy_setting !== 'punished_stealth' && reportedUser.privacy_setting !== 'stealth') {
      await env.DB.prepare(
        `UPDATE users SET privacy_setting = 'punished_stealth', punish_reason = '被多次举报' WHERE id = ?`
      ).bind(reported_id).run();
      punishment = { type: 'punished_stealth', reason: '被多次举报，已强制开启隐身模式' };
    }

    return Response.json({ 
      success: true, 
      message: '举报成功',
      punishment: punishment
    });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
