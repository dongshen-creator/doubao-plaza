-- ===== 频道公告 =====
CREATE TABLE IF NOT EXISTS chat_channel_announcements (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  pinned INTEGER DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

-- ===== 频道工具（快捷链接）=====
CREATE TABLE IF NOT EXISTS chat_channel_tools (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  icon TEXT DEFAULT '🔗',
  sort_order INTEGER DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cca_room ON chat_channel_announcements(room_id);
CREATE INDEX IF NOT EXISTS idx_cct_room ON chat_channel_tools(room_id);
