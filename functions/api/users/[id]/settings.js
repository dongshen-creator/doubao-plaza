// Cloudflare Pages Function - User Settings
// PUT /api/users/[id]/settings
// GET /api/users/[id]/notifications - 获取通知（惩罚提醒等）

export async function onRequestGet(context) {
  // 首先检查环境变量
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定，请在Cloudflare Pages设置中绑定D1数据库' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { env } = context;
    const userId = context.params.id;
    
    // 获取用户的惩罚通知
    const user = await env.DB.prepare(
      `SELECT privacy_setting, punished_until, punish_reason FROM users WHERE id = ?`
    ).bind(userId).first();
    
    if (!user) {
      return Response.json({ success: false, error: '用户不存在' });
    }
    
    const notifications = [];
    
    // 检查是否有惩罚
    if (user.privacy_setting === 'punished_whitelist' && user.punished_until) {
      notifications.push({
        type: 'punishment',
        title: '账号处罚通知',
        message: `您的账号因${user.punish_reason || '被多次举报'}，已被强制开启白名单模式至 ${new Date(user.punished_until).toLocaleDateString('zh-CN')}。在此期间您只能被通过豆包号和邀请码搜索到。`,
        severity: 'warning'
      });
    } else if (user.privacy_setting === 'punished_stealth') {
      notifications.push({
        type: 'punishment',
        title: '账号处罚通知',
        message: `您的账号因${user.punish_reason || '被多次举报'}，已被强制开启隐身模式。您将完全不可被搜索到。`,
        severity: 'error'
      });
    }
    
    return Response.json({ success: true, data: notifications });
  } catch (e) {
    return Response.json({ success: false, error: '服务器错误：' + e.message });
  }
}

export async function onRequestPut(context) {
  // 首先检查环境变量
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定，请在Cloudflare Pages设置中绑定D1数据库' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { env } = context;
    const userId = context.params.id;
    const body = await context.request.json().catch(() => ({}));
    const { action, password, invite_code, privacy_setting, avatar } = body;

    if (action === 'update_avatar') {
      await env.DB.prepare(`UPDATE users SET avatar = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(avatar || null, userId).run();
      return Response.json({ success: true, message: '头像更新成功' });
    }

    if (action === 'change_password') {
      if (!password || password.length !== 6) {
        return Response.json({ success: false, error: '新密码必须为6位' });
      }
      await env.DB.prepare(`UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(password, userId).run();
      return Response.json({ success: true, message: '密码修改成功' });
    }

    if (action === 'set_invite_code') {
      await env.DB.prepare(`UPDATE users SET invite_code = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(invite_code || null, userId).run();
      return Response.json({ success: true, message: '邀请码设置成功' });
    }

    if (action === 'update_pat_suffix') {
      const { pat_suffix } = body;
      await env.DB.prepare("UPDATE users SET pat_suffix = ?, updated_at = datetime('now') WHERE id = ?").bind((pat_suffix || '').slice(0, 10), userId).run();
      return Response.json({ success: true });
    }

    if (action === 'set_privacy') {
      // 检查是否处于惩罚状态
      const user = await env.DB.prepare(
        `SELECT privacy_setting, punished_until FROM users WHERE id = ?`
      ).bind(userId).first();
      
      // 如果被惩罚，不能手动修改隐私设置
      if (user.privacy_setting.startsWith('punished_')) {
        const now = new Date().toISOString();
        if (user.punished_until && user.punished_until > now) {
          return Response.json({ success: false, error: '您当前处于处罚期，无法修改隐私设置' });
        }
      }
      
      if (!['searchable', 'whitelist', 'stealth'].includes(privacy_setting)) {
        return Response.json({ success: false, error: '无效的隐私设置' });
      }
      
      // 如果设置白名单但没有邀请码，默认123456
      if (privacy_setting === 'whitelist') {
        const currentUser = await env.DB.prepare(
          `SELECT invite_code FROM users WHERE id = ?`
        ).bind(userId).first();
        if (!currentUser.invite_code) {
          await env.DB.prepare(
            `UPDATE users SET privacy_setting = ?, invite_code = '123456', updated_at = datetime('now') WHERE id = ?`
          ).bind(privacy_setting, userId).run();
          return Response.json({ success: true, message: '隐私设置已更新，邀请码默认为 123456' });
        }
      }
      
      await env.DB.prepare(`UPDATE users SET privacy_setting = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(privacy_setting, userId).run();
      return Response.json({ success: true, message: '隐私设置已更新' });
    }

    return Response.json({ success: false, error: '未知操作' });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
