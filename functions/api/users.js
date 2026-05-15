// Cloudflare Pages Function - Users API
// GET  /api/users?search=xxx&doubao_id=xxx&invite_code=xxx&current_user=xxx  - 搜索用户
// POST /api/users             - 注册
// (登录见 /api/users/login.js)
// (自动登录见 /api/users/auto-login.js)
// (注销见 /api/users/[id].js)

function isValidAgentUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname.includes('doubao.com') || 
           u.hostname.includes('coze') || 
           url.includes('bot') || 
           url.includes('agent');
  } catch {
    return false;
  }
}

function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
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
    const url = new URL(context.request.url);
    const search = url.searchParams.get('search') || '';
    const doubaoId = url.searchParams.get('doubao_id') || '';
    const inviteCode = url.searchParams.get('invite_code') || '';
    const currentUserId = url.searchParams.get('current_user') || '';

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (currentUserId) {
      const [currentUser, blockedByMe, blockedMe] = await Promise.all([
        env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(currentUserId).first(),
        env.DB.prepare(`SELECT blocked_user_id FROM blocked_users WHERE user_id = ?`).bind(currentUserId).all(),
        env.DB.prepare(`SELECT user_id FROM blocked_users WHERE blocked_user_id = ?`).bind(currentUserId).all()
      ]);
      
      if (!currentUser) {
        return Response.json({ success: false, error: '当前用户不存在' });
      }
      
      const blockedIds = new Set([
        ...(blockedByMe.results || []).map(r => r.blocked_user_id),
        ...(blockedMe.results || []).map(r => r.user_id)
      ]);
      
      if (blockedIds.size > 0) {
        whereClause += ` AND id NOT IN (${Array.from(blockedIds).map(() => '?').join(',')})`;
        params.push(...Array.from(blockedIds));
      }
      
      whereClause += ` AND id != ?`;
      params.push(currentUserId);
      whereClause += ` AND privacy_setting NOT IN ('stealth', 'punished_stealth')`;
      
      if (!doubaoId || !inviteCode) {
        whereClause += ` AND privacy_setting NOT IN ('whitelist', 'punished_whitelist')`;
      }
      
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
  } catch (e) {
    return Response.json({ success: false, error: '服务器错误：' + e.message });
  }
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
    const { name, password, doubao_id, agent_url, avatar, bio, invite_code } = body;

    if (!name || !password) {
      return Response.json({ success: false, error: '姓名和密码是必填项' });
    }
    if (password.length !== 6) {
      return Response.json({ success: false, error: '密码必须为6位' });
    }
    if (!doubao_id && !agent_url) {
      return Response.json({ success: false, error: '豆包号和智能体链接至少填一个' });
    }
    if (agent_url && !isValidAgentUrl(agent_url)) {
      return Response.json({ success: false, error: '智能体链接格式不正确，请使用豆包或Coze平台的链接' });
    }

    if (doubao_id) {
      const existing = await env.DB.prepare(`SELECT id FROM users WHERE doubao_id = ?`).bind(doubao_id).first();
      if (existing) return Response.json({ success: false, error: '该豆包号已被注册' });
    }
    if (agent_url) {
      const existing = await env.DB.prepare(`SELECT id FROM users WHERE agent_url = ?`).bind(agent_url).first();
      if (existing) return Response.json({ success: false, error: '该智能体链接已被注册' });
    }

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
