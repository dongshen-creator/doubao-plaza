-- ===== 频道加入申请表 =====
CREATE TABLE IF NOT EXISTS channel_join_requests (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  message TEXT DEFAULT '',
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(room_id, user_id)
);

-- ===== 频道邀请表 =====
CREATE TABLE IF NOT EXISTS channel_invites (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  max_uses INTEGER DEFAULT 0,
  used_count INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===== 频道问卷题目表 =====
CREATE TABLE IF NOT EXISTS channel_questionnaires (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  question TEXT NOT NULL,
  question_type TEXT DEFAULT 'single',
  options TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===== 问卷作答记录表 =====
CREATE TABLE IF NOT EXISTS channel_questionnaire_answers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===== chat_channel_settings 新增字段 =====
ALTER TABLE chat_channel_settings ADD COLUMN admission_password TEXT;
ALTER TABLE chat_channel_settings ADD COLUMN admission_custom_page_id TEXT;
ALTER TABLE chat_channel_settings ADD COLUMN admission_questionnaire JSON;
ALTER TABLE chat_channel_settings ADD COLUMN admission_mode TEXT DEFAULT 'open';
