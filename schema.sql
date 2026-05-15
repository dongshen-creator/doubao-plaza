-- 逗包用户广场 D1 数据库初始化脚本
-- 更新版：添加设备指纹，去掉注册邀请码

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  avatar TEXT,
  bio TEXT,
  password TEXT NOT NULL,
  doubao_id TEXT UNIQUE,           -- 豆包号，唯一
  agent_url TEXT UNIQUE,           -- 智能体链接，唯一
  device_fingerprint TEXT,         -- 设备指纹，防多注册
  invite_code TEXT,                -- 白名单邀请码（仅白名单模式使用）
  privacy_setting TEXT DEFAULT 'searchable',
  punished_until TEXT,
  punish_reason TEXT,
  report_count_30d INTEGER DEFAULT 0,
  report_count_6m INTEGER DEFAULT 0,
  last_report_reset TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT,
  last_login_at TEXT
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
