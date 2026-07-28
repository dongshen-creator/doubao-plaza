-- 逗包用户广场 D1 数据库初始化脚本
-- 更新版：添加公告、功能、开发者管理

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  avatar TEXT,
  bio TEXT,
  password TEXT NOT NULL,
  doubao_id TEXT UNIQUE,
  agent_url TEXT UNIQUE,
  device_fingerprint TEXT,
  invite_code TEXT,
  pat_suffix TEXT DEFAULT '',
  is_developer INTEGER DEFAULT 0,
  privacy_setting TEXT DEFAULT 'searchable',
  punished_until TEXT,
  punish_reason TEXT,
  report_count_30d INTEGER DEFAULT 0,
  report_count_6m INTEGER DEFAULT 0,
  last_report_reset TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT,
  last_login_at TEXT,
  last_login_ip TEXT,
  last_login_ua TEXT,
  registered_ip TEXT,
  homepage_migrated INTEGER DEFAULT 0,
  security_question TEXT,
  security_answer TEXT,
  name_changed_at TEXT,
  bio_changed_at TEXT,
  security_question_changed_at TEXT
);

-- 好友关系表
CREATE TABLE IF NOT EXISTS friendships (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

-- 黑名单表
CREATE TABLE IF NOT EXISTS blocked_users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  blocked_user_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 举报记录表
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  reporter_id TEXT NOT NULL,
  reported_id TEXT NOT NULL,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 自动登录会话表
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 网站公告表
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

-- 功能图标表
CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title TEXT NOT NULL,
  icon_url TEXT,
  link_url TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

-- 自定义页面表（开发者本地功能）
CREATE TABLE IF NOT EXISTS custom_pages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title TEXT NOT NULL,
  html_content TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

-- 聊天室表
CREATE TABLE IF NOT EXISTS chat_rooms (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  matrix_room_id TEXT UNIQUE,
  type TEXT NOT NULL DEFAULT 'private',
  name TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_activity_at TEXT DEFAULT (datetime('now'))
);

-- 聊天室成员
CREATE TABLE IF NOT EXISTS chat_room_members (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  matrix_user_id TEXT,
  joined_at TEXT DEFAULT (datetime('now')),
  UNIQUE(room_id, user_id)
);

-- 陌生人发言限制
CREATE TABLE IF NOT EXISTS chat_stranger_limits (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  messages_sent INTEGER DEFAULT 1,
  UNIQUE(room_id, user_id)
);

-- 未读消息计数
CREATE TABLE IF NOT EXISTS chat_unread (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_event_id TEXT,
  count INTEGER DEFAULT 0,
  UNIQUE(room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_rooms_matrix ON chat_rooms(matrix_room_id);
CREATE INDEX IF NOT EXISTS idx_chat_members_room ON chat_room_members(room_id);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_room_members(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_unread_user ON chat_unread(user_id);

-- 索引
CREATE INDEX IF NOT EXISTS idx_users_doubao_id ON users(doubao_id);
CREATE INDEX IF NOT EXISTS idx_users_agent_url ON users(agent_url);
CREATE INDEX IF NOT EXISTS idx_users_fingerprint ON users(device_fingerprint);
CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id);
CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id);
CREATE INDEX IF NOT EXISTS idx_friendships_status ON friendships(status);
CREATE INDEX IF NOT EXISTS idx_blocked_user ON blocked_users(user_id);
CREATE INDEX IF NOT EXISTS idx_blocked_target ON blocked_users(blocked_user_id);
CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports(reported_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_features_order ON features(sort_order);

-- 禁言表（由 ensureTables 动态创建）
CREATE TABLE IF NOT EXISTS chat_muted (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  muted_by TEXT NOT NULL,
  muted_until TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(room_id, user_id)
);

-- 频道设置表（由 ensureTables 动态创建）
CREATE TABLE IF NOT EXISTS chat_channel_settings (
  room_id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  admission TEXT DEFAULT 'open',
  topic TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 频道封禁表（由 ensureTables 动态创建）
CREATE TABLE IF NOT EXISTS chat_banned (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  banned_by TEXT NOT NULL,
  reason TEXT DEFAULT '',
  permanent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(room_id, user_id)
);

-- 频道管理员表（由 ensureTables 动态创建）
CREATE TABLE IF NOT EXISTS chat_admins (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  set_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(room_id, user_id)
);

-- ===== 幂等迁移：为旧版数据库补列 =====
-- CREATE TABLE IF NOT EXISTS 不会为已存在的表添加新列，需要 ALTER TABLE
-- D1 不支持 IF NOT EXISTS 语法，用 try-catch 方式：如果列已存在会报错，忽略即可

-- users 表补列
ALTER TABLE users ADD COLUMN is_developer INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN pat_suffix TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN invite_code TEXT;
ALTER TABLE users ADD COLUMN punished_until TEXT;
ALTER TABLE users ADD COLUMN punish_reason TEXT;
ALTER TABLE users ADD COLUMN report_count_30d INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN report_count_6m INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN last_report_reset TEXT;
ALTER TABLE users ADD COLUMN updated_at TEXT;
ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN last_login_ip TEXT;
ALTER TABLE users ADD COLUMN last_login_ua TEXT;
ALTER TABLE users ADD COLUMN registered_ip TEXT;
ALTER TABLE users ADD COLUMN security_question TEXT;
ALTER TABLE users ADD COLUMN security_answer TEXT;
ALTER TABLE users ADD COLUMN name_changed_at TEXT;
ALTER TABLE users ADD COLUMN bio_changed_at TEXT;
ALTER TABLE users ADD COLUMN security_question_changed_at TEXT;

-- 站点设置表（维护模式 / 迁移模式）
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- 迁移语句（已有数据库需手动执行一次，新库无需执行）
-- ============================================================
-- 为已有 users 表添加"主页迁移标记"字段：
-- ALTER TABLE users ADD COLUMN homepage_migrated INTEGER DEFAULT 0;
--
-- 插入站点设置默认值（首次部署）：
-- INSERT OR IGNORE INTO site_settings (key, value) VALUES ('maintenance_mode', 'off');
-- INSERT OR IGNORE INTO site_settings (key, value) VALUES ('migration_mode', 'off');

-- ===== 工具包整合迁移 =====
-- features 表扩展：支持工具类型功能
ALTER TABLE features ADD COLUMN tool_type TEXT;
ALTER TABLE features ADD COLUMN tool_config TEXT;

-- ===== 小肥羊讲堂（博客系统）=====
CREATE TABLE IF NOT EXISTS blog_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT DEFAULT '',
  cover_image TEXT,
  tags TEXT DEFAULT '[]',
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_avatar TEXT,
  author_doubao_id TEXT,
  status TEXT DEFAULT 'published',
  views INTEGER DEFAULT 0,
  matrix_event_id TEXT,
  matrix_room_url TEXT DEFAULT 'https://chat.freserafim.com/zh-CN/rooms/b9d7d6e7-191f-408b-b308-b210dbe1a764',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS blog_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  user_avatar TEXT,
  content TEXT NOT NULL,
  parent_id INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_blog_comments_post ON blog_comments(post_id);

CREATE TABLE IF NOT EXISTS blog_announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  pinned INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
