// Cloudflare Pages Function - Users API (完整版)
// GET  /api/users?search=xxx&doubao_id=xxx&invite_code=xxx&current_user=xxx  - 搜索用户
// POST /api/users             - 注册
// POST /api/users/login       - 登录
// POST /api/users/auto-login  - 自动登录
// DELETE /api/users/:id       - 注销账号

// 生成随机token
function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

// 检查智能体链接是否有效（简单检查格式）
function isValidAgentUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    // 允许 doubao.com 或包含 bot/agent 的链接
    return u.hostname.includes('doubao.com') || 
           u.hostname.includes('coze') || 
           url.includes('bot') || 
           url.includes('agent');
  } catch {
    return false;
  }
}

// 检查并更新惩罚状态
async function checkAndUpdatePunishment(env, userId) {
  const user = await env.DB.prepare(
    `SELECT * FROM users WHERE id = ?`
  ).bind(userId).first();
  
  if (!user) return null;
  
  const now = new Date().toISOString();
  
  // 检查白名单惩罚是否到期
  if (user.privacy_setting === 'punished_whitelist' && user.punished_until) {
    if (user.punished_until < now) {
      // 惩罚到期，恢复正常
      await env.DB.prepare(
        `UPDATE users SET privacy_setting = 'searchable', punished_until = NULL, punish_reason = NULL WHERE id = ?`
      ).bind(userId).run();
      user.privacy_setting = 'searchable';
      user.punished_until = null;
      user.punish_reason = null;
    }
  }
  
  return user;
}

export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const search = url.searchParams.get('search') || '';
  const doubaoId = url.searchParams.get('doubao_id') || '';
  const inviteCode = url.searchParams.get('invite_code') || '';
  const currentUserId = url.searchParams.get('current_user') || '';

  // 构建查询条件
  let whereClause = 'WHERE 1=1';
  const params = [];

  // 当前用户能看到谁？
  if (currentUserId) {
    // 获取当前用户和TA的黑名单
    const [currentUser, blockedByMe, blockedMe] = await Promise.all([
      env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(currentUserId).first(),
      env.DB.prepare(`SELECT blocked_user_id FROM blocked_users WHERE user_id = ?`).bind(currentUserId).all(),
      env.DB.prepare(`SELECT user_id FROM blocked_users WHERE blocked_user_id = ?`).bind(currentUserId).all()
    ]);
    
    if (!currentUser) {
      return Response.json({ success: false, error: '当前用户不存在' });
    }
    
    // 检查并更新惩罚状态
    await checkAndUpdatePunishment(env, currentUserId);
    
    // 双向黑名单
    const blockedIds = new Set([
      ...(blockedByMe.results || []).map(r => r.blocked_user_id),
      ...(blockedMe.results || []).map(r => r.user_id)
    ]);
    
    if (blockedIds.size > 0) {
      whereClause += ` AND id NOT IN (${Array.from(blockedIds).map(() => '?').join(',')})`;
      params.push(...Array.from(blockedIds));
    }
    
    // 不能看到自己
    whereClause += ` AND id != ?`;
    params.push(currentUserId);
    
    // 隐私设置过滤
    // 1. stealth 和 punished_stealth 完全不可见
    whereClause += ` AND privacy_setting NOT IN ('stealth', 'punished_stealth')`;
    
    // 2. whitelist 和 punished_whitelist 需要豆包号+邀请码
    if (!doubaoId || !inviteCode) {
      whereClause += ` AND privacy_setting NOT IN ('whitelist', 'punished_whitelist')`;
    }
    
    // 搜索逻辑
    if (search) {
      whereClause += ` AND (name LIKE ? OR bio LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }
    
    if (doubaoId) {
      whereClause += ` AND doubao_id = ?`;
      params.push(doubaoId);
    }
    
    if (inviteCode) {
      whereClause += ` AND invite_code = ?`;
      params.push(inviteCode);
    }
  } else {
    // 未登录用户只能看到 searchable 的用户
    whereClause += ` AND privacy_setting = 'searchable'`;
    
    if (search) {
      whereClause += ` AND (name LIKE ? OR bio LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }
  }

  const results = await env.DB.prepare(
    `SELECT id, name, avatar, bio, doubao_id, agent_url, privacy_setting, invite_code, created_at 
     FROM users ${whereClause} ORDER BY created_at DESC`
  ).bind(...params).all();

  return Response.json({ success: true, data: results.results });
}

export async function onRequestPost(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const body = await context.request.json();

  // 自动登录
  if (url.pathname === '/api/users/auto-login') {
    const { token } = body;
    if (!token) {
      return Response.json({ success: false, error: '无会话token' });
    }
    
    const session = await env.DB.prepare(
      `SELECT s.*, u.* FROM sessions s JOIN users u ON s.user_id = u.id 
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    ).bind(token).first();
    
    if (!session) {
      return Response.json({ success: false, error: '会话已过期' });
    }
    
    // 更新最后登录时间
    await env.DB.prepare(
      `UPDATE users SET last_login_at = datetime('now') WHERE id = ?`
    ).bind(session.user_id).run();
    
    // 检查惩罚状态
    const user = await checkAndUpdatePunishment(env, session.user_id);
    
    const { password, ...safeUser } = user;
    return Response.json({ success: true, data: safeUser, token });
  }

  // 登录
  if (url.pathname === '/api/users/login') {
    const { identifier, password } = body;
    if (!identifier || !password) {
      return Response.json({ success: false, error: '请输入账号和密码' });
    }
    
    // 豆包号或智能体链接二选一
    const user = await env.DB.prepare(
      `SELECT * FROM users WHERE (doubao_id = ? OR agent_url = ?) AND password = ?`
    ).bind(identifier, identifier, password).first();

    if (!user) {
      return Response.json({ success: false, error: '账号或密码错误' });
    }
    
    // 检查惩罚状态
    await checkAndUpdatePunishment(env, user.id);
    
    // 创建会话token（7天有效）
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    
    await env.DB.prepare(
      `INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)`
    ).bind(user.id, token, expiresAt).run();
    
    // 更新最后登录时间
    await env.DB.prepare(
      `UPDATE users SET last_login_at = datetime('now') WHERE id = ?`
    ).bind(user.id).run();
    
    const { password: _, ...safeUser } = user;
    return Response.json({ success: true, data: safeUser, token });
  }

  // 注册
  const { name, password, doubao_id, agent_url, avatar, bio, invite_code } = body;
  
  if (!name || !password) {
    return Response.json({ success: false, error: '姓名和密码是必填项' });
  }
  if (password.length !== 6) {
    return Response.json({ success: false, error: '密码必须为6位' });
  }
  
  // 豆包号和智能体链接至少填一个
  if (!doubao_id && !agent_url) {
    return Response.json({ success: false, error: '豆包号和智能体链接至少填一个' });
  }
  
  // 智能体链接格式检查
  if (agent_url && !isValidAgentUrl(agent_url)) {
    return Response.json({ success: false, error: '智能体链接格式不正确，请使用豆包或Coze平台的链接' });
  }

  // 检查豆包号重复
  if (doubao_id) {
    const existingDoubao = await env.DB.prepare(
      `SELECT id FROM users WHERE doubao_id = ?`
    ).bind(doubao_id).first();
    if (existingDoubao) {
      return Response.json({ success: false, error: '该豆包号已被注册' });
    }
  }

  // 检查智能体链接重复
  if (agent_url) {
    const existingAgent = await env.DB.prepare(
      `SELECT id FROM users WHERE agent_url = ?`
    ).bind(agent_url).first();
    if (existingAgent) {
      return Response.json({ success: false, error: '该智能体链接已被注册' });
    }
  }

  try {
    const result = await env.DB.prepare(
      `INSERT INTO users (name, password, doubao_id, agent_url, avatar, bio, invite_code) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(name, password, doubao_id || null, agent_url || null, avatar || null, bio || null, invite_code || null).run();

    const user = await env.DB.prepare(
      `SELECT id, name, avatar, bio, doubao_id, agent_url, privacy_setting, invite_code, created_at 
       FROM users WHERE id = ?`
    ).bind(result.meta.last_row_id).first();

    // 创建会话
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)`
    ).bind(user.id, token, expiresAt).run();

    return Response.json({ success: true, data: user, token });
  } catch (e) {
    return Response.json({ success: false, error: '注册失败：' + e.message });
  }
}

export async function onRequestDelete(context) {
  const { env } = context;
  const userId = context.params.id;
  
  if (!userId) {
    return Response.json({ success: false, error: '用户ID不能为空' });
  }
  
  try {
    // 删除相关数据（外键会自动处理，但为了彻底清理）
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
    await env.DB.prepare(`DELETE FROM friendships WHERE user_id = ? OR friend_id = ?`).bind(userId, userId).run();
    await env.DB.prepare(`DELETE FROM blocked_users WHERE user_id = ? OR blocked_user_id = ?`).bind(userId, userId).run();
    await env.DB.prepare(`DELETE FROM reports WHERE reporter_id = ? OR reported_id = ?`).bind(userId, userId).run();
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();
    
    return Response.json({ success: true, message: '账号已永久删除' });
  } catch (e) {
    return Response.json({ success: false, error: '注销失败：' + e.message });
  }
}
