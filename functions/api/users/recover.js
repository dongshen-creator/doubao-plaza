// Cloudflare Pages Function - Password Recovery via Security Question
// GET /api/users/recover?user_id=xxx - 获取密保问题
// POST /api/users/recover - 验证密保答案并重置密码

function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
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

async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('pbkdf2$')) {
    return password === stored;
  }
  const parts = stored.split('$');
  const iterations = parseInt(parts[1]);
  const salt = new Uint8Array(parts[2].match(/.{2}/g).map(b => parseInt(b, 16)));
  const storedHash = parts[3];
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const computedHash = Array.from(new Uint8Array(derivedBits), b => b.toString(16).padStart(2, '0')).join('');
  return computedHash === storedHash;
}

export async function onRequestGet(context) {
  if (!context.env.DB) {
    return Response.json({ success: false, error: '数据库未绑定' });
  }

  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const userId = url.searchParams.get('user_id');

    if (!userId) {
      return Response.json({ success: false, error: '缺少用户ID' });
    }

    const user = await env.DB.prepare(
      `SELECT id, name, doubao_id, avatar, security_question FROM users WHERE id = ?`
    ).bind(userId).first();

    if (!user) {
      return Response.json({ success: false, error: '用户不存在' });
    }

    if (!user.security_question) {
      return Response.json({ success: false, error: '该账号未设置密保问题，无法找回' });
    }

    return Response.json({
      success: true,
      data: {
        user_id: user.id,
        name: user.name,
        doubao_id: user.doubao_id,
        avatar: user.avatar,
        security_question: user.security_question
      }
    });
  } catch (e) {
    return Response.json({ success: false, error: '服务器错误：' + e.message });
  }
}

export async function onRequestPost(context) {
  if (!context.env.DB) {
    return Response.json({ success: false, error: '数据库未绑定' });
  }

  try {
    const { env } = context;
    const body = await context.request.json().catch(() => ({}));
    const { user_id, security_answer, new_password } = body;

    if (!user_id || !security_answer || !new_password) {
      return Response.json({ success: false, error: '参数不完整' });
    }

    if (new_password.length < 6 || new_password.length > 32) {
      return Response.json({ success: false, error: '新密码长度必须为6-32位' });
    }

    const user = await env.DB.prepare(
      `SELECT * FROM users WHERE id = ?`
    ).bind(user_id).first();

    if (!user) {
      return Response.json({ success: false, error: '用户不存在' });
    }

    if (!user.security_answer) {
      return Response.json({ success: false, error: '该账号未设置密保问题' });
    }

    // 验证密保答案（不区分大小写）
    const answerValid = await verifyPassword(security_answer.trim().toLowerCase(), user.security_answer);
    if (!answerValid) {
      return Response.json({ success: false, error: '密保答案错误' });
    }

    // 验证通过，重置密码
    const hashedPassword = await hashPassword(new_password);
    await env.DB.prepare(
      `UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(hashedPassword, user_id).run();

    // 创建新会话
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)`
    ).bind(user_id, token, expiresAt).run();

    // 更新登录信息
    const clientIP = context.request.headers.get('CF-Connecting-IP')
      || context.request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
      || 'unknown';
    const userAgent = context.request.headers.get('User-Agent') || '';
    await env.DB.prepare(
      `UPDATE users SET last_login_at = datetime('now'), last_login_ip = ?, last_login_ua = ? WHERE id = ?`
    ).bind(clientIP, userAgent, user_id).run();

    const safeUser = {
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      bio: user.bio,
      doubao_id: user.doubao_id,
      agent_url: user.agent_url,
      is_developer: user.is_developer,
      privacy_setting: user.privacy_setting,
      invite_code: user.invite_code,
      created_at: user.created_at,
      updated_at: user.updated_at,
      last_login_at: new Date().toISOString(),
      last_login_ip: clientIP,
      last_login_ua: userAgent,
      pat_suffix: user.pat_suffix
    };

    return Response.json({ success: true, data: safeUser, token, message: '密码重置成功，已自动登录' });
  } catch (e) {
    return Response.json({ success: false, error: '服务器错误：' + e.message });
  }
}
