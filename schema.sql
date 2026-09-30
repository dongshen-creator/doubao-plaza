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
CREATE INDEX IF NOT EXISTS idx_users_registered_ip ON users(registered_ip);
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
CREATE TABLE IF NOT EXISTS blog_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

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
  category_id INTEGER DEFAULT NULL,
  reject_reason TEXT DEFAULT '',
  views INTEGER DEFAULT 0,
  matrix_event_id TEXT,
  matrix_room_url TEXT DEFAULT 'https://chat.freserafim.com/zh-CN/rooms/b9d7d6e7-191f-408b-b308-b210dbe1a764',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON blog_posts(status);
CREATE INDEX IF NOT EXISTS idx_blog_posts_category ON blog_posts(category_id);

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

CREATE TABLE IF NOT EXISTS blog_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  post_id INTEGER NOT NULL,
  post_title TEXT NOT NULL,
  comment_id INTEGER NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  sender_avatar TEXT,
  content TEXT NOT NULL,
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_blog_notif_user ON blog_notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_blog_notif_post ON blog_notifications(post_id);

-- ============================================================
-- V5.13 新增：注册防滥用（PoW 挑战记录表）
-- 用于注册工作量证明的「单次有效 + 最短填写时间」校验，详见 functions/api/_lib/pow.js
-- 已有数据库需重跑本 schema.sql（幂等，CREATE IF NOT EXISTS 不影响现有数据）
-- ============================================================
CREATE TABLE IF NOT EXISTS register_challenges (
  id TEXT PRIMARY KEY,
  used INTEGER DEFAULT 0,
  issued_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_register_challenges_issued ON register_challenges(issued_at);

-- ============================================================
-- V8.0 迁移：注册/登录简化 · 设备凭据 · 风控 · 隔离 · 账号清理
-- 与 migrations/v8.0-foundation.sql 保持一致
-- 已有数据库同样重跑本 schema.sql（ALTER 重复列报错忽略，CREATE 幂等）
-- 注意：users.name_norm 的 UNIQUE 索引在历史昵称回填完成后单独创建：
--   CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name_norm ON users(name_norm);
-- ============================================================

-- users 表新列
ALTER TABLE users ADD COLUMN name_norm TEXT;
ALTER TABLE users ADD COLUMN quarantined_at TEXT;
ALTER TABLE users ADD COLUMN quarantine_reason TEXT;
ALTER TABLE users ADD COLUMN quarantined_by TEXT;
ALTER TABLE users ADD COLUMN deactivated_at TEXT;
ALTER TABLE users ADD COLUMN purge_after TEXT;
ALTER TABLE users ADD COLUMN last_active_at TEXT;
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN ip_backfilled_at TEXT;
-- AUDIT FIX [6.3] 第三方脚本/API 直连白名单（0=仅同源带门禁证明, 1=Bearer 直连放行）
ALTER TABLE users ADD COLUMN api_allowed INTEGER NOT NULL DEFAULT 0;

-- login_attempts 扩展列（风控信号）
ALTER TABLE login_attempts ADD COLUMN asn INTEGER;
ALTER TABLE login_attempts ADD COLUMN country TEXT;
ALTER TABLE login_attempts ADD COLUMN canvas_hash TEXT;
ALTER TABLE login_attempts ADD COLUMN device_hash TEXT;

-- 设备凭据表（只存 token hash，原始 token 仅在 __Host-dp_device Cookie 中）
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  risk_level INTEGER DEFAULT 0,
  claim_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT,
  last_claim_at TEXT,
  created_ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
CREATE INDEX IF NOT EXISTS idx_devices_created_ip ON devices(created_ip, created_at);

-- 设备-账号关系（一机一号由部分唯一索引在 DB 层保证）
CREATE TABLE IF NOT EXISTS device_accounts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  bound_at TEXT DEFAULT (datetime('now')),
  released_at TEXT,
  release_reason TEXT,
  UNIQUE(device_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_device_accounts_user ON device_accounts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_device_accounts_device ON device_accounts(device_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_accounts_one_active
  ON device_accounts(device_id) WHERE status = 'active';

-- 风控事件（保留 90 天，访问权限见 docs/SECURITY.md）
CREATE TABLE IF NOT EXISTS risk_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT,
  device_id TEXT,
  event_type TEXT NOT NULL,
  ip TEXT,
  asn INTEGER,
  country TEXT,
  colo TEXT,
  ua TEXT,
  canvas_hash TEXT,
  canvas_status TEXT,
  risk_score INTEGER DEFAULT 0,
  action TEXT DEFAULT 'allowed',
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_risk_events_ip ON risk_events(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_risk_events_user ON risk_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_risk_events_type ON risk_events(event_type, created_at);

-- 开发者后台审计日志
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON admin_audit_log(actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON admin_audit_log(action, created_at);

-- step-up token（高风险操作要求近期认证，默认 10 分钟）
CREATE TABLE IF NOT EXISTS stepup_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  purpose TEXT DEFAULT 'devops',
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stepup_user ON stepup_tokens(user_id, expires_at);

-- 清理运行记录（预演/执行报告持久化）
CREATE TABLE IF NOT EXISTS cleanup_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  report TEXT NOT NULL,
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);

-- AUDIT FIX [6.7/6.8] 门禁 403 / 蜜罐命中 / 限流审计事件（保留 90 天，中间件 1% 概率清理）
CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,               -- gate_403 | honeypot | rate_limited | quarantine_401
  ip TEXT,
  path TEXT,
  user_id TEXT,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_security_events_kind_time ON security_events(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at);
