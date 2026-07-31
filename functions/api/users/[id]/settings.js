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

// 昵称规范化：去除零宽字符、不可见字符，NFC 归一化，折叠空白，转小写
function normalizeName(name) {
  if (!name) return '';
  let s = name.replace(/[\u200B\u200C\u200D\uFEFF\u2060\u00AD\u200E\u200F\u202A-\u202E\u2061-\u2064]/g, '');
  s = s.normalize('NFC');
  s = s.replace(/[\s\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g, ' ');
  s = s.trim();
  return s.toLowerCase();
}

// 昵称合法性检查
function validateName(name) {
  if (!name) return { valid: false, error: '昵称不能为空' };
  const trimmed = String(name).trim();
  if (trimmed.length === 0) return { valid: false, error: '昵称不能为空' };
  if (trimmed.length > 20) return { valid: false, error: '昵称长度不能超过20位' };
  const normalized = normalizeName(trimmed);
  if (normalized.length === 0) return { valid: false, error: '昵称不能仅包含不可见字符' };
  if (/^[\s\p{P}\p{S}]+$/u.test(trimmed)) {
    return { valid: false, error: '昵称不能仅包含标点符号或空白' };
  }
  return { valid: true, normalized };
}

// V12 修复：校验头像 URL 安全性
function isValidHttpUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateAvatarUrl(avatar) {
  if (!avatar || !String(avatar).trim()) return { valid: true, value: null };
  const url = String(avatar).trim();
  if (url.length > 500) return { valid: false, error: '头像链接过长' };
  if (/^\s*(javascript|data|vbscript|file|about):/i.test(url)) {
    return { valid: false, error: '头像链接协议不安全' };
  }
  if (!isValidHttpUrl(url)) {
    return { valid: false, error: '头像链接必须是 http:// 或 https:// 开头的有效链接' };
  }
  return { valid: true, value: url };
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

    // 迁移：确保 security_question / security_answer / security_question_changed_at 列存在
    await env.DB.prepare("ALTER TABLE users ADD COLUMN security_question TEXT").run().catch(() => {});
    await env.DB.prepare("ALTER TABLE users ADD COLUMN security_answer TEXT").run().catch(() => {});
    await env.DB.prepare("ALTER TABLE users ADD COLUMN security_question_changed_at TEXT").run().catch(() => {});
    await env.DB.prepare("ALTER TABLE users ADD COLUMN name_changed_at TEXT").run().catch(() => {});
    await env.DB.prepare("ALTER TABLE users ADD COLUMN bio_changed_at TEXT").run().catch(() => {});

    const body = await context.request.json().catch(() => ({}));
    const { action, password, invite_code, privacy_setting, avatar, name, bio } = body;

    if (action === 'update_profile') {
      // 更新昵称和自我介绍（bio），各自有30天冷却时间
      // 先查询当前冷却状态
      const curUser = await env.DB.prepare(
        `SELECT name, bio, name_changed_at, bio_changed_at FROM users WHERE id = ?`
      ).bind(userId).first();
      if (!curUser) return Response.json({ success: false, error: '用户不存在' });

      const now = new Date();
      const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30天

      const updates = [];
      const binds = [];
      if (name !== undefined) {
        const nameCheck = validateName(name);
        if (!nameCheck.valid) {
          return Response.json({ success: false, error: nameCheck.error });
        }
        const trimmedName = String(name).trim();
        if (nameCheck.normalized === normalizeName(curUser.name)) {
          return Response.json({ success: false, error: '新昵称与当前昵称相同' });
        }
        // 检查昵称是否与其他用户重复（规范化比较）
        const allUsers = await env.DB.prepare(`SELECT id, name FROM users WHERE id != ?`).bind(userId).all();
        for (const other of (allUsers.results || [])) {
          if (normalizeName(other.name) === nameCheck.normalized) {
            return Response.json({ success: false, error: '该昵称已被使用，请换一个' });
          }
        }
        // 检查冷却
        if (curUser.name_changed_at) {
          const lastChange = new Date(curUser.name_changed_at + 'Z');
          const elapsed = now - lastChange;
          if (elapsed < COOLDOWN_MS) {
            const remainingDays = Math.ceil((COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000));
            return Response.json({ success: false, error: `昵称修改冷却中，还需 ${remainingDays} 天` });
          }
        }
        updates.push('name = ?');
        binds.push(trimmedName);
        updates.push("name_changed_at = datetime('now')");
      }
      if (bio !== undefined) {
        const trimmedBio = String(bio).trim();
        if (trimmedBio.length > 200) {
          return Response.json({ success: false, error: '自我介绍不能超过200字' });
        }
        if (trimmedBio === (curUser.bio || '')) {
          return Response.json({ success: false, error: '新自我介绍与当前内容相同' });
        }
        // 检查冷却
        if (curUser.bio_changed_at) {
          const lastChange = new Date(curUser.bio_changed_at + 'Z');
          const elapsed = now - lastChange;
          if (elapsed < COOLDOWN_MS) {
            const remainingDays = Math.ceil((COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000));
            return Response.json({ success: false, error: `自我介绍修改冷却中，还需 ${remainingDays} 天` });
          }
        }
        updates.push('bio = ?');
        binds.push(trimmedBio || null);
        updates.push("bio_changed_at = datetime('now')");
      }
      if (updates.length === 0) {
        return Response.json({ success: false, error: '没有需要更新的内容' });
      }
      updates.push("updated_at = datetime('now')");
      binds.push(userId);
      await env.DB.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();
      return Response.json({ success: true, message: '资料更新成功' });
    }

    if (action === 'update_avatar') {
      // V12 修复：校验头像 URL
      const avatarCheck = validateAvatarUrl(avatar);
      if (!avatarCheck.valid) {
        return Response.json({ success: false, error: avatarCheck.error });
      }
      await env.DB.prepare(`UPDATE users SET avatar = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(avatarCheck.value, userId).run();
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

    if (action === 'set_security_question') {
      const { security_question, security_answer } = body;
      if (!security_question || !security_question.trim()) {
        return Response.json({ success: false, error: '请选择密保问题' });
      }
      if (!security_answer || security_answer.trim().length < 1 || security_answer.trim().length > 50) {
        return Response.json({ success: false, error: '密保答案长度必须为1-50位' });
      }
      // 检查冷却时间（30天），仅对已有密保问题的用户生效；首次设置不限制
      const secUser = await env.DB.prepare(
        `SELECT security_question_changed_at, security_question FROM users WHERE id = ?`
      ).bind(userId).first();
      if (secUser && secUser.security_question) {
        const now = new Date();
        const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
        if (secUser.security_question_changed_at) {
          const lastChange = new Date(secUser.security_question_changed_at + 'Z');
          const elapsed = now - lastChange;
          if (elapsed < COOLDOWN_MS) {
            const remainingDays = Math.ceil((COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000));
            return Response.json({ success: false, error: `密保问题修改冷却中，还需 ${remainingDays} 天` });
          }
        }
      }
      // 对密保答案进行哈希处理（与密码相同的安全级别）
      // 注意：不使用 toLowerCase()，因为中文没有大小写概念，且可能导致某些特殊字符处理异常
      const hashedAnswer = await hashPassword(security_answer.trim());
      await env.DB.prepare(
        `UPDATE users SET security_question = ?, security_answer = ?, security_question_changed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
      ).bind(security_question.trim(), hashedAnswer, userId).run();
      return Response.json({ success: true, message: '密保问题设置成功' });
    }

    if (action === 'get_security_question') {
      const user = await env.DB.prepare(
        `SELECT security_question, security_question_changed_at FROM users WHERE id = ?`
      ).bind(userId).first();
      const now = new Date();
      const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
      let cooldownRemaining = 0;
      if (user?.security_question && user?.security_question_changed_at) {
        const lastChange = new Date(user.security_question_changed_at + 'Z');
        const elapsed = now - lastChange;
        if (elapsed < COOLDOWN_MS) {
          cooldownRemaining = Math.ceil((COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000));
        }
      }
      return Response.json({ success: true, data: {
        security_question: user?.security_question || '',
        cooldown_remaining_days: cooldownRemaining
      } });
    }

    if (action === 'get_profile_cooldown') {
      // 返回昵称和自我介绍的冷却状态
      const user = await env.DB.prepare(
        `SELECT name_changed_at, bio_changed_at FROM users WHERE id = ?`
      ).bind(userId).first();
      const now = new Date();
      const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
      let nameCooldown = 0, bioCooldown = 0;
      if (user?.name_changed_at) {
        const lastChange = new Date(user.name_changed_at + 'Z');
        const elapsed = now - lastChange;
        if (elapsed < COOLDOWN_MS) nameCooldown = Math.ceil((COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000));
      }
      if (user?.bio_changed_at) {
        const lastChange = new Date(user.bio_changed_at + 'Z');
        const elapsed = now - lastChange;
        if (elapsed < COOLDOWN_MS) bioCooldown = Math.ceil((COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000));
      }
      return Response.json({ success: true, data: {
        name_cooldown_days: nameCooldown,
        bio_cooldown_days: bioCooldown
      } });
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
