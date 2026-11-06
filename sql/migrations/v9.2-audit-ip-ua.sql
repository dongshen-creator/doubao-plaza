-- v9.2: admin_audit_log 记录操作者 IP 与 User-Agent
-- 幂等性：ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS，重复执行会报
-- "duplicate column name" —— 执行前先用 PRAGMA table_info(admin_audit_log) 确认。
ALTER TABLE admin_audit_log ADD COLUMN ip TEXT;
ALTER TABLE admin_audit_log ADD COLUMN ua TEXT;
