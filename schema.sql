-- 逗包用户广场 D1 数据库初始化脚本
-- 更新版：移除email，添加举报相关字段

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  -- email 已移除
  avatar TEXT,
  bio TEXT,
  password TEXT NOT NULL,
  doubao_id TEXT UNIQUE,           -- 豆包号，唯一
  agent_url TEXT UNIQUE,           -- 智能体链接，唯一
  invite_code TEXT,                -- 邀请码
  privacy_setting TEXT DEFAULT 'searchable',  -- searchable/whitelist/stealth/punished_whitelist/punished_stealth
  -- 惩罚相关字段
  punished_until TEXT,             -- 惩罚结束时间（白名单惩罚）
  punish_reason TEXT,              -- 惩罚原因
  report_count_30d INTEGER DEFAULT 0,  -- 30天内被举报次数
  report_count_6m INTEGER DEFAULT 0,   -- 6个月内被举报次数
  last_report_reset TEXT,          -- 上次重置举报计数时间
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT,
  last_login_at TEXT               -- 最后登录时间（用于自动登录）
);

-- 好友关系表（status: pending/accepted/rejected）
CREATE TABLE IF NOT EXISTS friendships (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending=申请中, accepted=已通过, rejected=已拒绝
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

-- 黑名单表（双向屏蔽）
CREATE TABLE IF NOT EXISTS blocked_users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  blocked_user_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 举报记录表
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  reporter_id TEXT NOT NULL,       -- 举报人
  reported_id TEXT NOT NULL,       -- 被举报人
  reason TEXT,                     -- 举报原因（可选）
  created_at TEXT DEFAULT (datetime('now'))
);

-- 自动登录会话表
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,      -- 会话token
  expires_at TEXT NOT NULL,        -- 过期时间（7天）
  created_at TEXT DEFAULT (datetime('now'))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_users_doubao_id ON users(doubao_id);
CREATE INDEX IF NOT EXISTS idx_users_agent_url ON users(agent_url);
CREATE INDEX IF NOT EXISTS idx_users_privacy ON users(privacy_setting);
CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id);
CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id);
CREATE INDEX IF NOT EXISTS idx_friendships_status ON friendships(status);
CREATE INDEX IF NOT EXISTS idx_blocked_user ON blocked_users(user_id);
CREATE INDEX IF NOT EXISTS idx_blocked_target ON blocked_users(blocked_user_id);
CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports(reported_id);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
