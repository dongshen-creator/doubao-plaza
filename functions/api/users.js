// Cloudflare Pages Function - Users API
// GET  /api/users?search=xxx&doubao_id=xxx&invite_code=xxx&current_user=xxx  - 搜索用户
// POST /api/users             - 注册
// (登录见 /api/users/login.js)
// (自动登录见 /api/users/auto-login.js)
// (注销见 /api/users/[id].js)

import { signSupabaseJWT, generateToken } from './_lib/jwt.js';
import { verifyChallenge, consumeChallenge, isTorExitIP } from './_lib/pow.js';

// 校验是否为合法的 http(s) 链接（豆包智能体链接或创作视频链接等均可）
function isValidHttpUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// V12 修复：校验头像 URL 安全性
// 允许空值（无头像），非空时必须是 http(s) 链接，屏蔽 data:/javascript:/vbscript: 等危险协议
function validateAvatarUrl(avatar) {
  if (!avatar || !String(avatar).trim()) return { valid: true, value: null };
  const url = String(avatar).trim();
  if (url.length > 500) return { valid: false, error: '头像链接过长' };
  // 屏蔽危险协议
  if (/^\s*(javascript|data|vbscript|file|about):/i.test(url)) {
    return { valid: false, error: '头像链接协议不安全' };
  }
  if (!isValidHttpUrl(url)) {
    return { valid: false, error: '头像链接必须是 http:// 或 https:// 开头的有效链接' };
  }
  return { valid: true, value: url };
}

// 昵称规范化：去除零宽字符、不可见字符，NFC 归一化，折叠空白，转小写
// 用于检测视觉上完全一致的昵称（防止用特殊字符达到重复效果）
function normalizeName(name) {
  if (!name) return '';
  // 去除零宽字符和不可见字符：ZWSP, ZWNJ, ZWJ, BOM, WJ, soft hyphen, 方向控制符等
  let s = name.replace(/[\u200B\u200C\u200D\uFEFF\u2060\u00AD\u200E\u200F\u202A-\u202E\u2061-\u2064]/g, '');
  // NFC 归一化（合并组合字符序列）
  s = s.normalize('NFC');
  // 折叠所有空白（包括各种 Unicode 空格）为单个普通空格
  s = s.replace(/[\s\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g, ' ');
  // 去除首尾空白
  s = s.trim();
  // 转小写用于比较
  return s.toLowerCase();
}

// 昵称合法性检查：返回 { valid: bool, error: string }
function validateName(name) {
  if (!name) return { valid: false, error: '昵称不能为空' };
  const trimmed = String(name).trim();
  if (trimmed.length === 0) return { valid: false, error: '昵称不能为空' };
  if (trimmed.length > 20) return { valid: false, error: '昵称长度不能超过20位' };
  // 去除零宽字符后检查是否为空（防止用不可见字符注册空昵称）
  const normalized = normalizeName(trimmed);
  if (normalized.length === 0) return { valid: false, error: '昵称不能仅包含不可见字符' };
  // 禁止纯空白或纯标点符号昵称
  if (/^[\s\p{P}\p{S}]+$/u.test(trimmed)) {
    return { valid: false, error: '昵称不能仅包含标点符号或空白' };
  }
  return { valid: true, normalized };
}

// V11 修复：Cloudflare Turnstile 人机验证
async function verifyTurnstile(token, env, remoteIP) {
  // 如果未配置 Turnstile 密钥，跳过验证（向后兼容）
  if (!env.TURNSTILE_SECRET) return { success: true, skipped: true };
  if (!token) return { success: false, error: '请完成人机验证' };
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip: remoteIP || '',
      }),
    });
    const data = await resp.json();
    if (data.success) return { success: true };
    return { success: false, error: '人机验证失败，请重试' };
  } catch (e) {
    return { success: false, error: '人机验证服务异常' };
  }
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
      `SELECT id, name, avatar, bio, doubao_id, agent_url, pat_suffix, privacy_setting, created_at
       FROM users ${whereClause} ORDER BY created_at DESC LIMIT 500`
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
    const { name, password, doubao_id, agent_url, avatar, bio, device_fingerprint, turnstile_token, pow_token, pow_nonce, website } = body;

    // V5.13 修复：蜜罐字段——隐藏输入框正常用户不可见不会填写，机器人自动填表会填入，直接拒绝
    if (website && String(website).trim() !== '') {
      return Response.json({ success: false, error: '注册失败，请刷新页面重试' });
    }

    // V5.13：防批量注册——PoW 工作量证明校验（只读校验；挑战消耗在落库前原子执行，
    // 保证「昵称重复」等校验失败后用户无需重新解题，重试体验不受影响）
    const powResult = await verifyChallenge(env, pow_token, pow_nonce);
    if (!powResult.ok) {
      return Response.json({ success: false, error: powResult.error });
    }

    // V11 修复：Turnstile 人机验证（配置了 TURNSTILE_SECRET 时强制校验）
    const clientIP = context.request.headers.get('CF-Connecting-IP')
      || context.request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
      || 'unknown';
    const turnstileResult = await verifyTurnstile(turnstile_token, env, clientIP);
    if (!turnstileResult.success) {
      return Response.json({ success: false, error: turnstileResult.error });
    }

    // 基本验证
    if (!name || !password) {
      return Response.json({ success: false, error: '姓名和密码是必填项' });
    }
    // 昵称合法性检查
    const nameCheck = validateName(name);
    if (!nameCheck.valid) {
      return Response.json({ success: false, error: nameCheck.error });
    }
    // 检查昵称是否重复（规范化比较，防止视觉一致的昵称）
    const allUsers = await env.DB.prepare(`SELECT name FROM users`).all();
    const existingNames = (allUsers.results || []).map(r => r.name);
    for (const existingName of existingNames) {
      if (normalizeName(existingName) === nameCheck.normalized) {
        return Response.json({ success: false, error: '该昵称已被使用，请换一个' });
      }
    }
    if (!password || password.length < 6 || password.length > 32) {
      return Response.json({ success: false, error: '密码长度必须为6-32位' });
    }
    if (!doubao_id) {
      return Response.json({ success: false, error: '豆包号是必填项' });
    }
    
    // 主页链接为必填项：必须是AI视频链接，不支持智能体链接
    const homepageUrl = agent_url ? String(agent_url).trim() : '';
    if (!homepageUrl) {
      return Response.json({ success: false, error: 'AI视频链接是必填项' });
    }
    if (/\/bot\//i.test(homepageUrl) || /doubao\.com\/bot/i.test(homepageUrl)) {
      return Response.json({ success: false, error: '不支持AI智能体链接（/bot/），请填写AI视频链接' });
    }
    if (!isValidHttpUrl(homepageUrl)) {
      return Response.json({ success: false, error: '主页链接格式不正确，请填写以 http:// 或 https:// 开头的链接' });
    }

    // V12 修复：校验头像 URL
    const avatarCheck = validateAvatarUrl(avatar);
    if (!avatarCheck.valid) {
      return Response.json({ success: false, error: avatarCheck.error });
    }
    const safeAvatar = avatarCheck.value;

    // IP 频率限制：同 IP 1 小时内最多注册 5 次（轻量防刷）
    const recentRegs = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM users WHERE registered_ip = ? AND created_at > datetime('now', '-1 hour')`
    ).bind(clientIP).first();
    if (recentRegs && recentRegs.cnt >= 5) {
      return Response.json({ success: false, error: '该网络注册过于频繁，请 1 小时后再试' });
    }

    // V5.13：Tor 出口节点拦截——洋葱网络批量注册的直接出口 IP 来自 Tor 出口列表，
    // 命中即拒（列表 D1 缓存 6 小时，拉取失败自动放行，不影响正常注册；env.BLOCK_TOR_REGISTRATION='off' 可关闭）
    if (await isTorExitIP(env, clientIP)) {
      return Response.json({ success: false, error: '检测到匿名代理网络，请使用常规网络注册' });
    }

    // IP 总数限制：同 IP 最多注册 10 个账号（防止批量注册）
    const totalRegs = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM users WHERE registered_ip = ?`
    ).bind(clientIP).first();
    if (totalRegs && totalRegs.cnt >= 10) {
      return Response.json({ success: false, error: '该网络的注册账号数量已达上限' });
    }

    // 检查设备指纹（同一设备是否已注册过）
    if (device_fingerprint) {
      const existingDevice = await env.DB.prepare(
        `SELECT id FROM users WHERE device_fingerprint = ?`
      ).bind(device_fingerprint).first();
      
      if (existingDevice) {
        return Response.json({ success: false, error: '该设备/浏览器已注册过账号，每个设备只能注册一个账号' });
      }
    }

    // 检查豆包号是否已注册
    const existingDoubaoId = await env.DB.prepare(`SELECT id FROM users WHERE doubao_id = ?`).bind(doubao_id).first();
    if (existingDoubaoId) return Response.json({ success: false, error: '该豆包号已被注册' });
    
    // 检查主页链接是否已被占用
    const existingAgentUrl = await env.DB.prepare(`SELECT id FROM users WHERE agent_url = ?`).bind(homepageUrl).first();
    if (existingAgentUrl) return Response.json({ success: false, error: '该主页链接已被其他用户使用' });

    const regUA = context.request.headers.get('User-Agent') || '';

    // V5.13：所有校验通过、即将落库——原子消耗 PoW 挑战（单次有效，防重放）
    if (powResult.id && !(await consumeChallenge(env, powResult.id))) {
      return Response.json({ success: false, error: '注册验证已使用，请刷新页面重试' });
    }

    // 创建用户（ID由数据库自动生成）；主页链接为空时存 NULL
    const hashedPassword = await hashPassword(password);
    await env.DB.prepare(
      `INSERT INTO users (name, password, doubao_id, agent_url, device_fingerprint, avatar, bio, registered_ip, last_login_ip, last_login_ua) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(name, hashedPassword, doubao_id, homepageUrl || null, device_fingerprint || null, safeAvatar, bio || null, clientIP, clientIP, regUA).run();

    // 通过 doubao_id 查询刚创建的用户
    const user = await env.DB.prepare(
      `SELECT id, name, avatar, bio, doubao_id, agent_url, is_developer, privacy_setting, created_at, last_login_ip, pat_suffix 
       FROM users WHERE doubao_id = ?`
    ).bind(doubao_id).first();

    // 创建会话（30天有效期）
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)`
    ).bind(user.id, token, expiresAt).run();

    // 签发 Supabase JWT（用于 RLS 鉴权）
    const supabaseToken = await signSupabaseJWT(user.id, env);

    return Response.json({ success: true, data: user, token, supabase_token: supabaseToken });
  } catch (e) {
    return Response.json({ success: false, error: '注册失败：' + e.message });
  }
}
