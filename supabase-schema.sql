-- 逗包广场 Supabase 建表 SQL — 复制到 Supabase SQL Editor 直接运行
-- 不需要任何扩展，纯标准 PostgreSQL

-- ===== 聊天室 =====
CREATE TABLE IF NOT EXISTS chat_rooms (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'private',
  name TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===== 聊天室成员 =====
CREATE TABLE IF NOT EXISTS chat_room_members (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  mute_notifications BOOLEAN DEFAULT FALSE,
  UNIQUE(room_id, user_id)
);

-- ===== 消息 =====
CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  event_id TEXT,
  room_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT,
  sender_avatar TEXT,
  sender_doubao_id TEXT,
  content TEXT NOT NULL,
  reply_to TEXT,
  recalled BOOLEAN DEFAULT FALSE,
  rel_type TEXT,
  relates_to_event_id TEXT,
  ts BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===== 表情反应 =====
CREATE TABLE IF NOT EXISTS chat_reactions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  reaction TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(event_id, reaction, sender_id)
);

-- ===== 管理员 =====
CREATE TABLE IF NOT EXISTS chat_admins (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  set_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(room_id, user_id)
);

-- ===== 禁言 =====
CREATE TABLE IF NOT EXISTS chat_muted (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  muted_by TEXT NOT NULL,
  muted_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(room_id, user_id)
);

-- ===== 封禁 =====
CREATE TABLE IF NOT EXISTS chat_banned (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  banned_by TEXT NOT NULL,
  reason TEXT DEFAULT '',
  permanent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(room_id, user_id)
);

-- ===== 频道设置 =====
CREATE TABLE IF NOT EXISTS chat_channel_settings (
  room_id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  admission TEXT DEFAULT 'open',
  admission_password TEXT,
  admission_custom_page_id TEXT,
  admission_questionnaire JSON,
  admission_mode TEXT DEFAULT 'open',
  topic TEXT DEFAULT '',
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===== 未读计数 =====
CREATE TABLE IF NOT EXISTS chat_unread (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  last_event_id TEXT,
  UNIQUE(room_id, user_id)
);

-- ===== 索引 =====
CREATE INDEX IF NOT EXISTS idx_msg_room_id ON chat_messages(room_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_msg_event ON chat_messages(event_id);
CREATE INDEX IF NOT EXISTS idx_member_room ON chat_room_members(room_id);
CREATE INDEX IF NOT EXISTS idx_member_user ON chat_room_members(user_id);
CREATE INDEX IF NOT EXISTS idx_unread_user ON chat_unread(user_id);

-- ===== 启用 Realtime =====
ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE chat_reactions;
