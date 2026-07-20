// Cloudflare Pages Function - User Settings
// PUT /api/users/[id]/settings
// GET /api/users/[id]/settings - 获取通知（惩罚提醒等）

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

    // 鉴权：仅本人可查看自己的通知
    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId || authUserId !== userId) {
      return Response.json({ success: false, error: '无权访问' }, { status: 403 });
    }
    
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

    // 鉴权：仅本人可修改自己的设置
    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId || authUserId !== userId) {
      return Response.json({ success: false, error: '无权操作，请先登录' }, { status: 403 });
    }

    const body = await context.request.json().catch(() => ({}));
    const { action, password, invite_code, privacy_setting, avatar } = body;

    if (action === 'update_avatar') {
      await env.DB.prepare(`UPDATE users SET avatar = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(avatar || null, userId).run();
      return Response.json({ success: true, message: '头像更新成功' });
    }

    if (action === 'change_password') {
      if (!password || password.length < 6 || password.length > 32) {
        return Response.json({ success: false, error: '新密码长度必须为6-32位' });
      }
      const hashedPassword = await hashPassword(password);
      await env.DB.prepare(`UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(hashedPassword, userId).run();
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

    if (action === 'migrate_homepage') {
      // 迁移主页链接：将 agent_url 切换为新链接（可留空），并标记已迁移
      const { new_homepage } = body;
      const newUrl = new_homepage ? String(new_homepage).trim() : '';
      // 留空表示清空主页链接；非空则校验 http(s) 格式
      if (newUrl) {
        try {
          const u = new URL(newUrl);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            return Response.json({ success: false, error: '主页链接必须以 http:// 或 https:// 开头' });
          }
        } catch {
          return Response.json({ success: false, error: '主页链接格式不正确' });
        }
        // 校验是否被他人占用
        const occupied = await env.DB.prepare(
          `SELECT id FROM users WHERE agent_url = ? AND id != ?`
        ).bind(newUrl, userId).first();
        if (occupied) {
          return Response.json({ success: false, error: '该主页链接已被其他用户使用' });
        }
      }
      await env.DB.prepare(
        `UPDATE users SET agent_url = ?, homepage_migrated = 1, updated_at = datetime('now') WHERE id = ?`
      ).bind(newUrl || null, userId).run();
      return Response.json({ success: true, message: '主页链接已更新' });
    }

    return Response.json({ success: false, error: '未知操作' });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
