// Chat API - 频道管理
// 聊天消息由前端直连 Supabase (Realtime + 轮询)，本接口仅保留 D1 元数据操作：
// channel-members / kick-member / delete-conversation / cleanup-messages

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

async function ensureTables(env) {
  const stmts = [
    "CREATE TABLE IF NOT EXISTS chat_rooms (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), matrix_room_id TEXT, type TEXT NOT NULL DEFAULT 'private', name TEXT, created_by TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))",
    "CREATE TABLE IF NOT EXISTS chat_room_members (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), room_id TEXT NOT NULL, user_id TEXT NOT NULL, matrix_user_id TEXT, joined_at TEXT DEFAULT (datetime('now')), UNIQUE(room_id, user_id))",
    "CREATE TABLE IF NOT EXISTS chat_stranger_limits (room_id TEXT NOT NULL, user_id TEXT NOT NULL, messages_sent INTEGER DEFAULT 1, UNIQUE(room_id, user_id))",
    "CREATE TABLE IF NOT EXISTS chat_unread (room_id TEXT NOT NULL, user_id TEXT NOT NULL, last_event_id TEXT, count INTEGER DEFAULT 0, UNIQUE(room_id, user_id))",
    "CREATE TABLE IF NOT EXISTS chat_muted (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL, muted_by TEXT NOT NULL, muted_until TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(room_id, user_id))",
    "CREATE TABLE IF NOT EXISTS chat_channel_settings (room_id TEXT PRIMARY KEY, created_by TEXT NOT NULL, admission TEXT DEFAULT 'open', topic TEXT DEFAULT '', avatar_url TEXT, created_at TEXT DEFAULT (datetime('now')))",
    "CREATE TABLE IF NOT EXISTS chat_banned (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL, banned_by TEXT NOT NULL, reason TEXT DEFAULT '', permanent INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), UNIQUE(room_id, user_id))",
    "CREATE TABLE IF NOT EXISTS chat_admins (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL, set_by TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), UNIQUE(room_id, user_id))"
  ];
  for (const sql of stmts) {
    try { await env.DB.prepare(sql).raw(); } catch(e) { try { await env.DB.prepare(sql).run(); } catch(e2) {} }
  }
  await env.DB.prepare("ALTER TABLE chat_channel_settings ADD COLUMN avatar_url TEXT").run().catch(function() {});
  await env.DB.prepare("ALTER TABLE users ADD COLUMN pat_suffix TEXT").run().catch(function() {});
}

async function isAdminOrCreator(env, room_id, user_id) {
  const room = await env.DB.prepare("SELECT created_by FROM chat_rooms WHERE id=?").bind(room_id).first();
  if (!room) return false;
  if (room.created_by === user_id) return 'creator';
  const admin = await env.DB.prepare("SELECT id FROM chat_admins WHERE room_id=? AND user_id=?").bind(room_id, user_id).first();
  return admin ? 'admin' : false;
}

function sanitize(u) {
  if (!u) return null;
  const { password, device_fingerprint, registered_ip, ...safe } = u;
  return safe;
}

export async function onRequest(context) {
  const { env, request } = context;
  env._request = request;
  if (!env.DB) return json({ error: '数据库未绑定' }, 500);

  await ensureTables(env);

  const url = new URL(request.url);
  const method = request.method;
  const action = url.searchParams.get('action') || '';

  try {
    const body = (method === 'POST' || method === 'PUT') ? await request.json().catch(() => ({})) : {};
    env._body = body;
    const resolvedAction = action || body.action || '';

    if (method === 'GET' && resolvedAction === 'channel-members') return await handleChannelMembers(env, url);
    if (method === 'POST' && resolvedAction === 'kick-member') return await handleKickMember(env, body);
    if (method === 'POST' && resolvedAction === 'delete-conversation') return await handleDeleteConversation(env, body);
    if (method === 'POST' && resolvedAction === 'cleanup-messages') return await handleCleanupMessages(env, body);

    return json({ error: '未知操作' }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ── 频道成员列表（前端 loadChannelMembers 调用） ──
async function handleChannelMembers(env, url) {
  const room_id = url.searchParams.get('room_id');
  if (!room_id) return json({ error: 'room_id 必填' });
  const members = await env.DB.prepare(
    "SELECT u.id, u.name, u.avatar, u.doubao_id, u.is_developer, m.joined_at, " +
    "(SELECT 1 FROM chat_muted cm WHERE cm.room_id=m.room_id AND cm.user_id=m.user_id AND (cm.muted_until IS NULL OR cm.muted_until > datetime('now'))) as is_muted, " +
    "(SELECT cm.muted_until FROM chat_muted cm WHERE cm.room_id=m.room_id AND cm.user_id=m.user_id) as muted_until, " +
    "(SELECT 1 FROM chat_admins ca WHERE ca.room_id=m.room_id AND ca.user_id=m.user_id) as is_admin " +
    "FROM chat_room_members m JOIN users u ON u.id=m.user_id " +
    "WHERE m.room_id=? ORDER BY m.joined_at ASC"
  ).bind(room_id).all();
  return json({ members: members.results.map(sanitize) });
}

// ── 踢出成员（前端 kickMember 调用） ──
async function handleKickMember(env, body) {
  const { user_id, room_id, target_user_id } = body;
  if (!user_id || !room_id || !target_user_id) return json({ error: '参数不完整' });
  const role = await isAdminOrCreator(env, room_id, user_id);
  if (!role) return json({ error: '只有频道创建者和管理员可以踢人' });
  const room = await env.DB.prepare("SELECT created_by FROM chat_rooms WHERE id=?").bind(room_id).first();
  if (!room) return json({ error: '频道不存在' });
  if (target_user_id === room.created_by) return json({ error: '不能踢出频道创建者' });
  if (role === 'admin') {
    const targetAdmin = await env.DB.prepare("SELECT id FROM chat_admins WHERE room_id=? AND user_id=?").bind(room_id, target_user_id).first();
    if (targetAdmin) return json({ error: '管理员不能踢出其他管理员' });
  }
  await env.DB.prepare("DELETE FROM chat_room_members WHERE room_id=? AND user_id=?").bind(room_id, target_user_id).run();
  await env.DB.prepare("DELETE FROM chat_unread WHERE room_id=? AND user_id=?").bind(room_id, target_user_id).run();
  return json({ success: true });
}

// ── 删除会话/退出频道（前端 deleteConversation 调用） ──
async function handleDeleteConversation(env, body) {
  const { user_id, room_id } = body;
  if (!user_id || !room_id) return json({ error: '参数不完整' });
  const room = await env.DB.prepare("SELECT * FROM chat_rooms WHERE id=?").bind(room_id).first();
  if (!room) return json({ error: '房间不存在' });
  const member = await env.DB.prepare("SELECT id FROM chat_room_members WHERE room_id=? AND user_id=?").bind(room_id, user_id).first();
  if (!member) return json({ error: '您不是房间成员' });
  if (room.type === 'channel') {
    const role = await isAdminOrCreator(env, room_id, user_id);
    if (!role) return json({ error: '只有频道创建者和管理员可以删除频道' });
    await env.DB.prepare("DELETE FROM chat_unread WHERE room_id=?").bind(room_id).run();
    await env.DB.prepare("DELETE FROM chat_stranger_limits WHERE room_id=?").bind(room_id).run();
    await env.DB.prepare("DELETE FROM chat_room_members WHERE room_id=?").bind(room_id).run();
    await env.DB.prepare("DELETE FROM chat_rooms WHERE id=?").bind(room_id).run();
    return json({ success: true, deleted: true });
  }
  await env.DB.prepare("DELETE FROM chat_unread WHERE room_id=? AND user_id=?").bind(room_id, user_id).run();
  await env.DB.prepare("DELETE FROM chat_room_members WHERE room_id=? AND user_id=?").bind(room_id, user_id).run();
  return json({ success: true, deleted: false });
}

// ── 清理过期元数据（禁言到期、临时封禁过期） ──
async function handleCleanupMessages(env, body) {
  try {
    const cutOff = new Date(Date.now() - 48 * 3600000).toISOString();
    let delMuted = 0, delBanned = 0;
    try {
      const muteRes = await env.DB.prepare("DELETE FROM chat_muted WHERE muted_until IS NOT NULL AND muted_until < datetime('now')").run();
      delMuted = muteRes.meta?.changes || 0;
    } catch(e) {}
    try {
      const banRes = await env.DB.prepare("DELETE FROM chat_banned WHERE permanent=0 AND created_at < ?").bind(cutOff).run();
      delBanned = banRes.meta?.changes || 0;
    } catch(e) {}
    return json({ success: true, deleted_muted: delMuted, deleted_banned: delBanned });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
}
