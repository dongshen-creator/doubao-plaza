// Chat API - Matrix proxy mode
// 环境变量: MATRIX_HOMESERVER, MATRIX_BOT_TOKEN, MATRIX_BOT_USER_ID, MATRIX_BOT_PASSWORD

var __botToken = '';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

function matrixUrl(env, path) {
  const hs = (env.MATRIX_HOMESERVER || 'https://matrix.example.com').replace(/\/+$/, '');
  return hs + path;
}

async function matrixLogin(env) {
  if (!env.MATRIX_BOT_USER_ID || !env.MATRIX_BOT_PASSWORD) throw new Error('Matrix 账号未配置（缺少 MATRIX_BOT_USER_ID 或 MATRIX_BOT_PASSWORD）');
  const hs = (env.MATRIX_HOMESERVER || 'https://matrix.example.com').replace(/\/+$/, '');
  // Try user_id login, fallback to email login if provided
  const identifiers = [];
  if (env.MATRIX_BOT_EMAIL) {
    identifiers.push({ type: 'm.id.thirdparty', medium: 'email', address: env.MATRIX_BOT_EMAIL });
  }
  identifiers.push({ type: 'm.id.user', user: env.MATRIX_BOT_USER_ID });
  let lastError = null;
  for (const identifier of identifiers) {
    const loginRes = await fetch(hs + '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'm.login.password', identifier, password: env.MATRIX_BOT_PASSWORD })
    });
    const data = await loginRes.json();
    if (data.access_token) {
      __botToken = data.access_token;
      return data.access_token;
    }
    lastError = 'Matrix 密码登录失败 (' + loginRes.status + '): ' + JSON.stringify(data);
  }
  throw new Error(lastError);
}

async function matrixFetch(env, path, options = {}) {
  const hs = (env.MATRIX_HOMESERVER || 'https://matrix.example.com').replace(/\/+$/, '');
  if (!__botToken) __botToken = env.MATRIX_BOT_TOKEN || '';
  const doFetch = function(tok) {
    return fetch(hs + path, {
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
  };
  var res = await doFetch(__botToken);
  if (res.status === 401) {
    if (env.MATRIX_BOT_PASSWORD) {
      try {
        __botToken = await matrixLogin(env);
        res = await doFetch(__botToken);
      } catch(loginErr) {
        // login failed, fall through to throw original error
        const txt = await res.text();
        throw new Error('Matrix 401: ' + txt.slice(0, 200) + ' (自动续期失败: ' + loginErr.message + ')');
      }
    } else {
      const txt = await res.text();
      throw new Error('Matrix 401: ' + txt.slice(0, 200) + '（如需自动续期，请设置 MATRIX_BOT_PASSWORD 环境变量）');
    }
  }
  const text = await res.text();
  if (!res.ok) throw new Error('Matrix ' + res.status + ': ' + text.slice(0, 200));
  try { return JSON.parse(text); } catch { return text; }
}

async function ensureTables(env) {
  // Mirror schema.sql exactly for column compatibility
  const stmts = [
    "CREATE TABLE IF NOT EXISTS chat_rooms (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), matrix_room_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL DEFAULT 'private', name TEXT, created_by TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))",
    "CREATE TABLE IF NOT EXISTS chat_room_members (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), room_id TEXT NOT NULL, user_id TEXT NOT NULL, matrix_user_id TEXT, joined_at TEXT DEFAULT (datetime('now')), UNIQUE(room_id, user_id))",
    "CREATE TABLE IF NOT EXISTS chat_stranger_limits (room_id TEXT NOT NULL, user_id TEXT NOT NULL, messages_sent INTEGER DEFAULT 1, UNIQUE(room_id, user_id))",
    "CREATE TABLE IF NOT EXISTS chat_unread (room_id TEXT NOT NULL, user_id TEXT NOT NULL, last_event_id TEXT, count INTEGER DEFAULT 0, UNIQUE(room_id, user_id))"
  ];
  for (const sql of stmts) {
    try { await env.DB.prepare(sql).raw(); } catch(e) { try { await env.DB.prepare(sql).run(); } catch(e2) {} }
  }
}

export async function onRequest(context) {
  const { env, request } = context;
  if (!env.DB) return json({ error: '数据库未绑定' }, 500);
  if (!env.MATRIX_HOMESERVER || (!env.MATRIX_BOT_TOKEN && !env.MATRIX_BOT_PASSWORD)) return json({ error: 'Matrix 未配置' }, 500);

  // Auto-create tables (schema.sql compatible column names)
  await ensureTables(env);

  const url = new URL(request.url);
  const method = request.method;
  const action = url.searchParams.get('action') || '';

  try {

    const body = (method === 'POST' || method === 'PUT') ? await request.json().catch(() => ({})) : {};
    const resolvedAction = action || body.action || '';
    if (method === 'POST' && resolvedAction === 'handshake') return await handleHandshake(env, body);
    if (method === 'POST' && resolvedAction === 'send') return await handleSend(env, body);
    if (method === 'GET' && resolvedAction === 'poll') return await handlePoll(env, url);
    if (method === 'GET' && resolvedAction === 'rooms') return await handleRooms(env, url);
    if (method === 'POST' && resolvedAction === 'read') return await handleRead(env, body);
    if (method === 'POST' && resolvedAction === 'create-channel') return await handleCreateChannel(env, body);
    if (method === 'POST' && resolvedAction === 'join-channel') return await handleJoinChannel(env, body);
    if (method === 'GET' && resolvedAction === 'channel-members') return await handleChannelMembers(env, url);
    if (method === 'GET' && resolvedAction === 'channels') return await handleListChannels(env, url);
    if (method === 'POST' && resolvedAction === 'recall') return await handleRecall(env, body);
    if (method === 'GET' && resolvedAction === 'unread-count') return await handleUnreadCount(env, url);
    if (method === 'POST' && resolvedAction === 'matrix-login-test') return await handleMatrixLoginTest(env, body);
    if (method === 'POST' && resolvedAction === 'reset-password') return await handleResetPassword(env, body);
  return json({ error: '未知操作' }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function handleMatrixLoginTest(env, body) {
  const { email, password } = body;
  if (!email && !password) {
    // Try with env vars
    const results = [];
    // Test 1: user_id login
    if (env.MATRIX_BOT_USER_ID && env.MATRIX_BOT_PASSWORD) {
      try {
        const r1 = await fetch((env.MATRIX_HOMESERVER || 'https://matrix.org').replace(/\/+$/, '') + '/_matrix/client/v3/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: env.MATRIX_BOT_USER_ID }, password: env.MATRIX_BOT_PASSWORD })
        });
        const d1 = await r1.json();
        results.push({ method: 'user_id', status: r1.status, data: d1.access_token ? 'SUCCESS' : d1 });
      } catch(e) { results.push({ method: 'user_id', error: e.message }); }
    }
    // Test 2: email login
    if (env.MATRIX_BOT_EMAIL && env.MATRIX_BOT_PASSWORD) {
      try {
        const r2 = await fetch((env.MATRIX_HOMESERVER || 'https://matrix.org').replace(/\/+$/, '') + '/_matrix/client/v3/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.thirdparty', medium: 'email', address: env.MATRIX_BOT_EMAIL }, password: env.MATRIX_BOT_PASSWORD })
        });
        const d2 = await r2.json();
        results.push({ method: 'email', status: r2.status, data: d2.access_token ? 'SUCCESS' : d2 });
      } catch(e) { results.push({ method: 'email', error: e.message }); }
    }
    return json({ results });
  } else {
    // Try custom login
    const results = [];
    for (const identifier of [
      body.email ? { type: 'm.id.thirdparty', medium: 'email', address: body.email } : null,
      body.user_id ? { type: 'm.id.user', user: body.user_id } : null
    ].filter(Boolean)) {
      try {
        const r = await fetch((env.MATRIX_HOMESERVER || 'https://matrix.org').replace(/\/+$/, '') + '/_matrix/client/v3/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'm.login.password', identifier, password: body.password })
        });
        const d = await r.json();
        results.push({ method: identifier.type, status: r.status, data: d.access_token ? 'SUCCESS token=' + d.access_token.substring(0,10)+'... user_id='+d.user_id : d });
      } catch(e) { results.push({ method: identifier.type, error: e.message }); }
    }
    return json({ results });
  }
}

async function handleUnreadCount(env, url) {
  const user_id = url.searchParams.get('user_id');
  if (!user_id) return json({ error: 'user_id 必填' });
  try {
    const result = await env.DB.prepare(
      "SELECT COALESCE(SUM(count), 0) as total FROM chat_unread WHERE user_id=?"
    ).bind(user_id).first();
    return json({ total: result?.total || 0 });
  } catch (e) {
    return json({ total: 0 });
  }
}

async function handleHandshake(env, body) {
  const { user_id, friend_id } = body;
  if (!user_id || !friend_id) return json({ error: 'user_id 和 friend_id 必填' });

  const blocked = await env.DB.prepare(
    "SELECT id FROM blocked_users WHERE (user_id=? AND blocked_user_id=?) OR (user_id=? AND blocked_user_id=?)"
  ).bind(user_id, friend_id, friend_id, user_id).first();
  if (blocked) return json({ error: '无法与已拉黑的用户聊天' });

  const recipient = await env.DB.prepare("SELECT id, privacy_setting, punished_until FROM users WHERE id=?").bind(friend_id).first();
  if (recipient) {
    if (recipient.privacy_setting === 'punished_stealth') {
      return json({ error: '对方因违规已被限制使用聊天功能' });
    }
    if (recipient.privacy_setting === 'stealth') {
      const isFriend = await env.DB.prepare(
        "SELECT id FROM friendships WHERE status='accepted' AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?))"
      ).bind(user_id, friend_id, friend_id, user_id).first();
      if (!isFriend) return json({ error: '对方开启了隐身模式，无法发起会话' });
    }
    if (recipient.privacy_setting === 'whitelist' || recipient.privacy_setting === 'punished_whitelist') {
      const isFriend = await env.DB.prepare(
        "SELECT id FROM friendships WHERE status='accepted' AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?))"
      ).bind(user_id, friend_id, friend_id, user_id).first();
      if (!isFriend) return json({ error: '对方开启了白名单模式，仅好友可发起会话' });
    }
  }

  const existing = await env.DB.prepare(
    "SELECT cr.id, cr.matrix_room_id FROM chat_rooms cr " +
    "JOIN chat_room_members m1 ON cr.id=m1.room_id AND m1.user_id=? " +
    "JOIN chat_room_members m2 ON cr.id=m2.room_id AND m2.user_id=? " +
    "WHERE cr.type='private'"
  ).bind(user_id, friend_id).first();

  if (existing) {
    const [u1, u2] = await Promise.all([
      env.DB.prepare("SELECT id, name, avatar, doubao_id FROM users WHERE id=?").bind(user_id).first(),
      env.DB.prepare("SELECT id, name, avatar, doubao_id FROM users WHERE id=?").bind(friend_id).first()
    ]);
    return json({ room_id: existing.id, matrix_room_id: existing.matrix_room_id, users: [sanitize(u1), sanitize(u2)] });
  }

  const [u1, u2] = await Promise.all([
    env.DB.prepare("SELECT id, name, avatar, doubao_id FROM users WHERE id=?").bind(user_id).first(),
    env.DB.prepare("SELECT id, name, avatar, doubao_id FROM users WHERE id=?").bind(friend_id).first()
  ]);
  if (!u1 || !u2) return json({ error: '用户不存在' });

  const roomName = u1.name + ' & ' + u2.name;
  const matrixRoom = await matrixFetch(env, '/_matrix/client/v3/createRoom', {
    method: 'POST',
    body: JSON.stringify({
      name: roomName,
      preset: 'private_chat',
      visibility: 'private',
      initial_state: [{ type: 'm.room.guest_access', state_key: '', content: { guest_access: 'can_join' } }],
      invite: env.MATRIX_BOT_USER_ID ? [env.MATRIX_BOT_USER_ID] : []
    })
  });

  const roomId = genId();
  await env.DB.prepare(
    "INSERT INTO chat_rooms (id, matrix_room_id, type, name, created_by) VALUES (?, ?, 'private', ?, ?)"
  ).bind(roomId, matrixRoom.room_id, roomName, user_id).run();
  await env.DB.prepare(
    "INSERT INTO chat_room_members (room_id, user_id) VALUES (?, ?), (?, ?)"
  ).bind(roomId, user_id, roomId, friend_id).run();
  try {
    await env.DB.prepare("INSERT OR IGNORE INTO chat_unread (room_id, user_id, count) VALUES (?, ?, 0)").bind(roomId, user_id).run();
    await env.DB.prepare("INSERT OR IGNORE INTO chat_unread (room_id, user_id, count) VALUES (?, ?, 0)").bind(roomId, friend_id).run();
  } catch(e) {}

  return json({ room_id: roomId, matrix_room_id: matrixRoom.room_id, users: [sanitize(u1), sanitize(u2)] });
}

async function handleSend(env, body) {
  const { user_id, room_id, content, reply_to } = body;
  if (!user_id || !room_id || !content?.trim()) return json({ error: '参数不完整' });

  const room = await env.DB.prepare("SELECT * FROM chat_rooms WHERE id=?").bind(room_id).first();
  if (!room) return json({ error: '房间不存在' });

  const members = await env.DB.prepare(
    "SELECT user_id FROM chat_room_members WHERE room_id=?"
  ).bind(room_id).all();
  const otherId = members.results.find(m => m.user_id !== user_id)?.user_id;

  if (otherId) {
    const blocked = await env.DB.prepare(
      "SELECT id FROM blocked_users WHERE (user_id=? AND blocked_user_id=?) OR (user_id=? AND blocked_user_id=?)"
    ).bind(user_id, otherId, otherId, user_id).first();
    if (blocked) return json({ error: '无法向已拉黑的用户发送消息' });

    if (room.type === 'private') {
      const isFriend = await env.DB.prepare(
        "SELECT id FROM friendships WHERE status='accepted' AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?))"
      ).bind(user_id, otherId, otherId, user_id).first();
      if (!isFriend) {
        try {
          const limit = await env.DB.prepare(
            "SELECT messages_sent FROM chat_stranger_limits WHERE room_id=? AND user_id=?"
          ).bind(room_id, user_id).first();
          if (limit && limit.messages_sent >= 1) {
            const otherReplied = await env.DB.prepare(
              "SELECT messages_sent FROM chat_stranger_limits WHERE room_id=? AND user_id=?"
            ).bind(room_id, otherId).first();
            if (!otherReplied || otherReplied.messages_sent === 0) {
              return json({ error: '请等待对方回复', stranger_limit: true });
            }
          }
          await env.DB.prepare(
            "INSERT INTO chat_stranger_limits (room_id, user_id, messages_sent) VALUES (?, ?, 1) " +
            "ON CONFLICT(room_id, user_id) DO UPDATE SET messages_sent=messages_sent+1"
          ).bind(room_id, user_id).run();
        } catch(e) {}
      }
    }
  }

  const user = await env.DB.prepare("SELECT id, name, avatar, doubao_id FROM users WHERE id=?").bind(user_id).first();
  if (!user) return json({ error: '用户不存在' });

  const txnId = genId();
  const msgContent = {
    msgtype: 'm.text',
    body: content,
    'com.doubao.sender_id': user_id,
    'com.doubao.sender_name': user.name,
    'com.doubao.sender_avatar': user.avatar || '',
    'com.doubao.sender_doubao_id': user.doubao_id || ''
  };
  if (reply_to) {
    msgContent['m.relates_to'] = { 'm.in_reply_to': { event_id: reply_to } };
  }

  const result = await matrixFetch(env, '/_matrix/client/v3/rooms/' + encodeURIComponent(room.matrix_room_id) + '/send/m.room.message/' + txnId, {
    method: 'PUT',
    body: JSON.stringify(msgContent)
  });

  try {
    const otherMembers = await env.DB.prepare(
      "SELECT user_id FROM chat_room_members WHERE room_id=? AND user_id!=?"
    ).bind(room_id, user_id).all();
    for (const m of otherMembers.results) {
      await env.DB.prepare(
        "INSERT INTO chat_unread (room_id, user_id, count) VALUES (?, ?, 1) " +
        "ON CONFLICT(room_id, user_id) DO UPDATE SET count=count+1"
      ).bind(room_id, m.user_id).run();
    }
  } catch(e) {}

  return json({ success: true, event_id: result.event_id || '' });
}

async function handlePoll(env, url) {
  const room_id = url.searchParams.get('room_id');
  const since = url.searchParams.get('since') || '';
  const userId = url.searchParams.get('user_id');
  if (!room_id) return json({ error: 'room_id 必填' });

  const room = await env.DB.prepare("SELECT matrix_room_id FROM chat_rooms WHERE id=?").bind(room_id).first();
  if (!room) return json({ error: '房间不存在' });

  let messages = [];
  let nextBatch = '';

  try {
    const filter = encodeURIComponent(JSON.stringify({room:{timeline:{limit:50}}}));
    let sync;
    if (since) {
      sync = await matrixFetch(env, '/_matrix/client/v3/sync?filter=' + filter + '&since=' + encodeURIComponent(since) + '&timeout=3000');
    } else {
      sync = await matrixFetch(env, '/_matrix/client/v3/sync?filter=' + filter + '&timeout=0');
    }
    nextBatch = sync.next_batch || '';
    const roomData = sync.rooms?.join?.[room.matrix_room_id];
    if (roomData) {
      const events = roomData.timeline?.events || [];
      for (const ev of events) {
        if (ev.type === 'm.room.message') messages.push(parseMatrixEvent(ev));
      }
    }
  } catch (e) {
    return json({ error: '同步失败: ' + e.message });
  }

  return json({ messages, next_batch: nextBatch });
}

function parseMatrixEvent(ev) {
  const content = ev.content || {};
  return {
    event_id: ev.event_id,
    sender: content['com.doubao.sender_name'] || '未知用户',
    sender_id: content['com.doubao.sender_id'] || '',
    sender_avatar: content['com.doubao.sender_avatar'] || '',
    sender_doubao_id: content['com.doubao.sender_doubao_id'] || '',
    content: content.body || '',
    reply_to: content['m.relates_to']?.['m.in_reply_to']?.event_id || null,
    ts: ev.origin_server_ts,
    type: ev.type
  };
}

async function handleRooms(env, url) {
  const user_id = url.searchParams.get('user_id');
  if (!user_id) return json({ error: 'user_id 必填' });

  const rooms = await env.DB.prepare(
    "SELECT cr.id, cr.matrix_room_id, cr.type, cr.name, cr.created_by, cr.created_at " +
    "FROM chat_rooms cr " +
    "JOIN chat_room_members m ON cr.id=m.room_id AND m.user_id=? " +
    "ORDER BY cr.created_at DESC"
  ).bind(user_id).all().catch(() => ({ results: [] }));

  const result = [];
  for (const r of (rooms.results || [])) {
    let unread = 0;
    try {
      const u = await env.DB.prepare("SELECT count FROM chat_unread WHERE room_id=? AND user_id=?").bind(r.id, user_id).first();
      unread = u?.count || 0;
    } catch(e) {}
    if (r.type === 'private') {
      const other = await env.DB.prepare(
        "SELECT u.id, u.name, u.avatar, u.doubao_id FROM chat_room_members m JOIN users u ON u.id=m.user_id " +
        "WHERE m.room_id=? AND m.user_id!=?"
      ).bind(r.id, user_id).first();
      result.push({ ...r, unread, other: sanitize(other), name: r.name || other?.name || '聊天' });
    } else {
      const members = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM chat_room_members WHERE room_id=?"
      ).bind(r.id).first();
      result.push({ ...r, unread, member_count: members?.count || 0 });
    }
  }
  return json({ rooms: result });
}

async function handleRead(env, body) {
  const { user_id, room_id, event_id } = body;
  if (!user_id || !room_id) return json({ error: '参数不完整' });
  try {
    await env.DB.prepare(
      "INSERT INTO chat_unread (room_id, user_id, count, last_event_id) VALUES (?, ?, 0, ?) " +
      "ON CONFLICT(room_id, user_id) DO UPDATE SET count=0, last_event_id=excluded.last_event_id"
    ).bind(room_id, user_id, event_id || '').run();
  } catch(e) {}
  return json({ success: true });
}

async function handleCreateChannel(env, body) {
  const { user_id, name } = body;
  if (!user_id || !name?.trim()) return json({ error: '参数不完整' });
  const user = await env.DB.prepare("SELECT id, name FROM users WHERE id=?").bind(user_id).first();
  if (!user) return json({ error: '用户不存在' });

  const matrixRoom = await matrixFetch(env, '/_matrix/client/v3/createRoom', {
    method: 'POST',
    body: JSON.stringify({ name: name.trim(), preset: 'public_chat', visibility: 'private' })
  });

  const roomId = genId();
  await env.DB.prepare(
    "INSERT INTO chat_rooms (id, matrix_room_id, type, name, created_by) VALUES (?, ?, 'channel', ?, ?)"
  ).bind(roomId, matrixRoom.room_id, name.trim(), user_id).run();
  await env.DB.prepare(
    "INSERT INTO chat_room_members (room_id, user_id) VALUES (?, ?)"
  ).bind(roomId, user_id).run();

  return json({ room_id: roomId, matrix_room_id: matrixRoom.room_id });
}

async function handleJoinChannel(env, body) {
  const { user_id, room_id } = body;
  if (!user_id || !room_id) return json({ error: '参数不完整' });
  const room = await env.DB.prepare("SELECT * FROM chat_rooms WHERE id=? AND type='channel'").bind(room_id).first();
  if (!room) return json({ error: '频道不存在' });
  await env.DB.prepare("INSERT OR IGNORE INTO chat_room_members (room_id, user_id) VALUES (?, ?)").bind(room_id, user_id).run();
  return json({ success: true });
}

async function handleChannelMembers(env, url) {
  const room_id = url.searchParams.get('room_id');
  if (!room_id) return json({ error: 'room_id 必填' });
  const members = await env.DB.prepare(
    "SELECT u.id, u.name, u.avatar, u.doubao_id, m.joined_at FROM chat_room_members m JOIN users u ON u.id=m.user_id " +
    "WHERE m.room_id=? ORDER BY m.joined_at ASC"
  ).bind(room_id).all();
  return json({ members: members.results.map(sanitize) });
}

async function handleListChannels(env, url) {
  const user_id = url.searchParams.get('user_id');
  const channels = await env.DB.prepare(
    "SELECT cr.id, cr.name, cr.created_by, cr.created_at, " +
    "(SELECT COUNT(*) FROM chat_room_members WHERE room_id=cr.id) as member_count " +
    "FROM chat_rooms cr WHERE cr.type='channel' ORDER BY cr.created_at DESC"
  ).all();
  let joined = [];
  if (user_id) {
    const j = await env.DB.prepare(
      "SELECT room_id FROM chat_room_members WHERE user_id=?"
    ).bind(user_id).all();
    joined = j.results.map(r => r.room_id);
  }
  return json({ channels: channels.results.map(c => ({ ...c, joined: joined.includes(c.id) })) });
}

async function handleRecall(env, body) {
  const { user_id, room_id, event_id } = body;
  if (!user_id || !room_id || !event_id) return json({ error: '参数不完整' });
  const room = await env.DB.prepare("SELECT * FROM chat_rooms WHERE id=?").bind(room_id).first();
  if (!room) return json({ error: '房间不存在' });
  const member = await env.DB.prepare("SELECT id FROM chat_room_members WHERE room_id=? AND user_id=?").bind(room_id, user_id).first();
  if (!member) return json({ error: '您不是房间成员' });
  const txnId = genId();
  await matrixFetch(env, '/_matrix/client/v3/rooms/' + encodeURIComponent(room.matrix_room_id) + '/redact/' + encodeURIComponent(event_id) + '/' + txnId, {
    method: 'PUT',
    body: JSON.stringify({ reason: '消息已撤回' })
  });
  return json({ success: true });
}


async function handleResetPassword(env, body) {
  const { email } = body;
  const hs = (env.MATRIX_HOMESERVER || 'https://matrix.org').replace(/\/+$/, '');
  const client_secret = 'reset-' + Date.now().toString(36);
  const result = await fetch(hs + '/_matrix/client/v3/account/password/reset/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_secret,
      email: email || env.MATRIX_BOT_EMAIL || '',
      send_attempt: 1
    })
  });
  const data = await result.json();
  return json({ status: result.status, data });
}

function sanitize(u) {
  if (!u) return null;
  const { password, device_fingerprint, registered_ip, ...safe } = u;
  return safe;
}
