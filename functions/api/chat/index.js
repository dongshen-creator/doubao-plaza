function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
async function ensureTables(env) {
  const stmts = [
    "CREATE TABLE IF NOT EXISTS chat_rooms (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), matrix_room_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL DEFAULT 'private', name TEXT, created_by TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))",
    "CREATE TABLE IF NOT EXISTS chat_room_members (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), room_id TEXT NOT NULL, user_id TEXT NOT NULL, matrix_user_id TEXT, joined_at TEXT DEFAULT (datetime('now')), UNIQUE(room_id, user_id))",
    "CREATE TABLE IF NOT EXISTS chat_stranger_limits (room_id TEXT NOT NULL, user_id TEXT NOT NULL, messages_sent INTEGER DEFAULT 1, UNIQUE(room_id, user_id))",
    "CREATE TABLE IF NOT EXISTS chat_unread (room_id TEXT NOT NULL, user_id TEXT NOT NULL, last_event_id TEXT, count INTEGER DEFAULT 0, UNIQUE(room_id, user_id))",
    "CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), room_id TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT DEFAULT '', sender_avatar TEXT DEFAULT '', sender_doubao_id TEXT DEFAULT '', content TEXT NOT NULL, reply_to TEXT, recalled INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))"
  ];
  for (const sql of stmts) {
    try { await env.DB.prepare(sql).raw(); } catch(e) { try { await env.DB.prepare(sql).run(); } catch(e2) {} }
  }
}
export async function onRequest(context) {
  const { env, request } = context;
  if (!env.DB) return json({ error: '数据库未绑定' }, 500);
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
    return json({ error: '未知操作' }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
async function handleUnreadCount(env, url) {
  const user_id = url.searchParams.get('user_id');
  if (!user_id) return json({ error: 'user_id 必填' });
  try {
    const result = await env.DB.prepare("SELECT COALESCE(SUM(count), 0) as total FROM chat_unread WHERE user_id=?").bind(user_id).first();
    return json({ total: result?.total || 0 });
  } catch (e) { return json({ total: 0 }); }
}
async function handleHandshake(env, body) {
  const { user_id, friend_id } = body;
  if (!user_id || !friend_id) return json({ error: 'user_id 和 friend_id 必填' });
  const blocked = await env.DB.prepare("SELECT id FROM blocked_users WHERE (user_id=? AND blocked_user_id=?) OR (user_id=? AND blocked_user_id=?)").bind(user_id, friend_id, friend_id, user_id).first();
  if (blocked) return json({ error: '无法与已拉黑的用户聊天' });
  const recipient = await env.DB.prepare("SELECT id, privacy_setting, punished_until FROM users WHERE id=?").bind(friend_id).first();
  if (recipient) {
    if (recipient.privacy_setting === 'punished_stealth') return json({ error: '对方因违规已被限制使用聊天功能' });
    if (recipient.privacy_setting === 'stealth') {
      const isFriend = await env.DB.prepare("SELECT id FROM friendships WHERE status='accepted' AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?))").bind(user_id, friend_id, friend_id, user_id).first();
      if (!isFriend) return json({ error: '对方开启了隐身模式，无法发起会话' });
    }
    if (recipient.privacy_setting === 'whitelist' || recipient.privacy_setting === 'punished_whitelist') {
      const isFriend = await env.DB.prepare("SELECT id FROM friendships WHERE status='accepted' AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?))").bind(user_id, friend_id, friend_id, user_id).first();
      if (!isFriend) return json({ error: '对方开启了白名单模式，仅好友可发起会话' });
    }
  }
  const existing = await env.DB.prepare("SELECT cr.id, cr.matrix_room_id FROM chat_rooms cr JOIN chat_room_members m1 ON cr.id=m1.room_id AND m1.user_id=? JOIN chat_room_members m2 ON cr.id=m2.room_id AND m2.user_id=? WHERE cr.type='private'").bind(user_id, friend_id).first();
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
  const roomId = genId();
  await env.DB.prepare("INSERT INTO chat_rooms (id, matrix_room_id, type, name, created_by) VALUES (?, ?, 'private', ?, ?)").bind(roomId, roomId, roomName, user_id).run();
  await env.DB.prepare("INSERT INTO chat_room_members (room_id, user_id) VALUES (?, ?), (?, ?)").bind(roomId, user_id, roomId, friend_id).run();
  try {
    await env.DB.prepare("INSERT OR IGNORE INTO chat_unread (room_id, user_id, count) VALUES (?, ?, 0)").bind(roomId, user_id).run();
    await env.DB.prepare("INSERT OR IGNORE INTO chat_unread (room_id, user_id, count) VALUES (?, ?, 0)").bind(roomId, friend_id).run();
  } catch(e) {}
  return json({ room_id: roomId, matrix_room_id: roomId, users: [sanitize(u1), sanitize(u2)] });
}
async function handleSend(env, body) {
  const { user_id, room_id, content, reply_to } = body;
  if (!user_id || !room_id || !content?.trim()) return json({ error: '参数不完整' });
  const room = await env.DB.prepare("SELECT * FROM chat_rooms WHERE id=?").bind(room_id).first();
  if (!room) return json({ error: '房间不存在' });
  const members = await env.DB.prepare("SELECT user_id FROM chat_room_members WHERE room_id=?").bind(room_id).all();
  const otherId = members.results.find(m => m.user_id !== user_id)?.user_id;
  if (otherId) {
    const blocked = await env.DB.prepare("SELECT id FROM blocked_users WHERE (user_id=? AND blocked_user_id=?) OR (user_id=? AND blocked_user_id=?)").bind(user_id, otherId, otherId, user_id).first();
    if (blocked) return json({ error: '无法向已拉黑的用户发送消息' });
    if (room.type === 'private') {
      const isFriend = await env.DB.prepare("SELECT id FROM friendships WHERE status='accepted' AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?))").bind(user_id, otherId, otherId, user_id).first();
      if (!isFriend) {
        try {
          const limit = await env.DB.prepare("SELECT messages_sent FROM chat_stranger_limits WHERE room_id=? AND user_id=?").bind(room_id, user_id).first();
          if (limit && limit.messages_sent >= 1) {
            const otherReplied = await env.DB.prepare("SELECT messages_sent FROM chat_stranger_limits WHERE room_id=? AND user_id=?").bind(room_id, otherId).first();
            if (!otherReplied || otherReplied.messages_sent === 0) return json({ error: '请等待对方回复', stranger_limit: true });
          }
          await env.DB.prepare("INSERT INTO chat_stranger_limits (room_id, user_id, messages_sent) VALUES (?, ?, 1) ON CONFLICT(room_id, user_id) DO UPDATE SET messages_sent=messages_sent+1").bind(room_id, user_id).run();
        } catch(e) {}
      }
    }
  }
  const user = await env.DB.prepare("SELECT id, name, avatar, doubao_id FROM users WHERE id=?").bind(user_id).first();
  if (!user) return json({ error: '用户不存在' });
  const msgId = genId();
  await env.DB.prepare("INSERT INTO chat_messages (id, room_id, sender_id, sender_name, sender_avatar, sender_doubao_id, content, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(msgId, room_id, user_id, user.name, user.avatar || '', user.doubao_id || '', content, reply_to || '').run();
  try {
    const otherMembers = await env.DB.prepare("SELECT user_id FROM chat_room_members WHERE room_id=? AND user_id!=?").bind(room_id, user_id).all();
    for (const m of otherMembers.results) {
      await env.DB.prepare("INSERT INTO chat_unread (room_id, user_id, count) VALUES (?, ?, 1) ON CONFLICT(room_id, user_id) DO UPDATE SET count=count+1").bind(room_id, m.user_id).run();
    }
  } catch(e) {}
  return json({ success: true, event_id: msgId });
}
async function handlePoll(env, url) {
  const room_id = url.searchParams.get('room_id');
  const since = url.searchParams.get('since') || '';
  if (!room_id) return json({ error: 'room_id 必填' });
  const room = await env.DB.prepare("SELECT id FROM chat_rooms WHERE id=?").bind(room_id).first();
  if (!room) return json({ error: '房间不存在' });
  let messages = [];
  let nextBatch = '';
  try {
    const sql = since ? "SELECT * FROM chat_messages WHERE room_id=? AND id>? AND recalled=0 ORDER BY created_at ASC LIMIT 50" : "SELECT * FROM chat_messages WHERE room_id=? AND recalled=0 ORDER BY created_at ASC LIMIT 50";
    const rows = since ? await env.DB.prepare(sql).bind(room_id, since).all() : await env.DB.prepare(sql).bind(room_id).all();
    for (const row of (rows.results || [])) {
      messages.push({ event_id: row.id, sender: row.sender_name || '未知用户', sender_id: row.sender_id || '', sender_avatar: row.sender_avatar || '', sender_doubao_id: row.sender_doubao_id || '', content: row.content || '', reply_to: row.reply_to || null, ts: new Date(row.created_at).getTime(), type: 'm.room.message' });
      nextBatch = row.id;
    }
  } catch (e) { return json({ error: '查询失败: ' + e.message }); }
  return json({ messages, next_batch: nextBatch });
}
async function handleRooms(env, url) {
  const user_id = url.searchParams.get('user_id');
  if (!user_id) return json({ error: 'user_id 必填' });
  const rooms = await env.DB.prepare("SELECT cr.id, cr.matrix_room_id, cr.type, cr.name, cr.created_by, cr.created_at FROM chat_rooms cr JOIN chat_room_members m ON cr.id=m.room_id AND m.user_id=? ORDER BY cr.created_at DESC").bind(user_id).all().catch(() => ({ results: [] }));
  const result = [];
  for (const r of (rooms.results || [])) {
    let unread = 0;
    try { const u = await env.DB.prepare("SELECT count FROM chat_unread WHERE room_id=? AND user_id=?").bind(r.id, user_id).first(); unread = u?.count || 0; } catch(e) {}
    if (r.type === 'private') {
      const other = await env.DB.prepare("SELECT u.id, u.name, u.avatar, u.doubao_id FROM chat_room_members m JOIN users u ON u.id=m.user_id WHERE m.room_id=? AND m.user_id!=?").bind(r.id, user_id).first();
      result.push({ ...r, unread, other: sanitize(other), name: r.name || other?.name || '聊天' });
    } else {
      const members = await env.DB.prepare("SELECT COUNT(*) as count FROM chat_room_members WHERE room_id=?").bind(r.id).first();
      result.push({ ...r, unread, member_count: members?.count || 0 });
    }
  }
  return json({ rooms: result });
}
async function handleRead(env, body) {
  const { user_id, room_id, event_id } = body;
  if (!user_id || !room_id) return json({ error: '参数不完整' });
  try { await env.DB.prepare("INSERT INTO chat_unread (room_id, user_id, count, last_event_id) VALUES (?, ?, 0, ?) ON CONFLICT(room_id, user_id) DO UPDATE SET count=0, last_event_id=excluded.last_event_id").bind(room_id, user_id, event_id || '').run(); } catch(e) {}
  return json({ success: true });
}
async function handleCreateChannel(env, body) {
  const { user_id, name } = body;
  if (!user_id || !name?.trim()) return json({ error: '参数不完整' });
  const user = await env.DB.prepare("SELECT id, name FROM users WHERE id=?").bind(user_id).first();
  if (!user) return json({ error: '用户不存在' });
  const roomId = genId();
  await env.DB.prepare("INSERT INTO chat_rooms (id, matrix_room_id, type, name, created_by) VALUES (?, ?, 'channel', ?, ?)").bind(roomId, roomId, name.trim(), user_id).run();
  await env.DB.prepare("INSERT INTO chat_room_members (room_id, user_id) VALUES (?, ?)").bind(roomId, user_id).run();
  return json({ room_id: roomId, matrix_room_id: roomId });
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
  const members = await env.DB.prepare("SELECT u.id, u.name, u.avatar, u.doubao_id, m.joined_at FROM chat_room_members m JOIN users u ON u.id=m.user_id WHERE m.room_id=? ORDER BY m.joined_at ASC").bind(room_id).all();
  return json({ members: members.results.map(sanitize) });
}
async function handleListChannels(env, url) {
  const user_id = url.searchParams.get('user_id');
  const channels = await env.DB.prepare("SELECT cr.id, cr.name, cr.created_by, cr.created_at, (SELECT COUNT(*) FROM chat_room_members WHERE room_id=cr.id) as member_count FROM chat_rooms cr WHERE cr.type='channel' ORDER BY cr.created_at DESC").all();
  let joined = [];
  if (user_id) { const j = await env.DB.prepare("SELECT room_id FROM chat_room_members WHERE user_id=?").bind(user_id).all(); joined = j.results.map(r => r.room_id); }
  return json({ channels: channels.results.map(c => ({ ...c, joined: joined.includes(c.id) })) });
}
async function handleRecall(env, body) {
  const { user_id, room_id, event_id } = body;
  if (!user_id || !room_id || !event_id) return json({ error: '参数不完整' });
  const room = await env.DB.prepare("SELECT * FROM chat_rooms WHERE id=?").bind(room_id).first();
  if (!room) return json({ error: '房间不存在' });
  const member = await env.DB.prepare("SELECT id FROM chat_room_members WHERE room_id=? AND user_id=?").bind(room_id, user_id).first();
  if (!member) return json({ error: '您不是房间成员' });
  await env.DB.prepare("UPDATE chat_messages SET recalled=1 WHERE id=? AND room_id=?").bind(event_id, room_id).run();
  return json({ success: true });
}
function sanitize(u) {
  if (!u) return null;
  const { password, device_fingerprint, registered_ip, ...safe } = u;
  return safe;
}
