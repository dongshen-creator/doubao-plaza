-- ============================================================
-- V11.0 增量迁移：管理员组合查询 / 批量处置 / 多维设备身份确认
-- 适用于已存在的生产 D1 数据库；按逐条语句执行，重复列报 duplicate column 时忽略。
-- 新环境请直接运行 sql/schema.sql（已包含本节全部定义）。
-- ============================================================

-- 1. 多维设备信号：Cookie 被清除后，按服务端历史散列信号恢复原设备凭据。
-- 信号类型：fingerprint / canvas / persistent / context / network；原值不入库。
CREATE TABLE IF NOT EXISTS device_signals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  device_id TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  signal_hash TEXT NOT NULL,
  first_seen_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT DEFAULT (datetime('now')),
  seen_count INTEGER DEFAULT 1,
  last_ip TEXT,
  last_asn INTEGER,
  UNIQUE(device_id, signal_type, signal_hash)
);
CREATE INDEX IF NOT EXISTS idx_device_signals_lookup
  ON device_signals(signal_type, signal_hash, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_device_signals_device ON device_signals(device_id, last_seen_at);

-- 2. 设备封禁审计元数据（后台 /api/developer/devices 使用）。
ALTER TABLE devices ADD COLUMN ban_reason TEXT;
ALTER TABLE devices ADD COLUMN banned_at TEXT;
ALTER TABLE devices ADD COLUMN banned_by TEXT;

-- 3. 会话绑定设备：自动登录轮换时校验会话与设备是否一致。
ALTER TABLE sessions ADD COLUMN device_id TEXT;
ALTER TABLE sessions ADD COLUMN created_ip TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_id, expires_at);

-- 4. 查询性能：组合账号查询、设备查询与风险事件时间范围扫描。
CREATE INDEX IF NOT EXISTS idx_users_roles ON users(is_developer, is_global_admin);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(last_active_at, last_login_at);
CREATE INDEX IF NOT EXISTS idx_users_reports ON users(report_count_30d, created_at);
CREATE INDEX IF NOT EXISTS idx_device_accounts_active ON device_accounts(device_id, status, user_id);
CREATE INDEX IF NOT EXISTS idx_risk_events_created ON risk_events(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at);

-- 可选回滚（人工审查后执行；SQLite 旧版本不支持 DROP COLUMN 时请重建表）：
-- DROP INDEX IF EXISTS idx_admin_audit_created;
-- DROP INDEX IF EXISTS idx_risk_events_created;
-- DROP INDEX IF EXISTS idx_device_accounts_active;
-- DROP INDEX IF EXISTS idx_users_reports;
-- DROP INDEX IF EXISTS idx_users_active;
-- DROP INDEX IF EXISTS idx_users_roles;
-- DROP INDEX IF EXISTS idx_sessions_device;
-- DROP INDEX IF EXISTS idx_device_signals_device;
-- DROP INDEX IF EXISTS idx_device_signals_lookup;
-- DROP TABLE IF EXISTS device_signals;
