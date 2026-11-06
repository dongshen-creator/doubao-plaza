-- ============================================================
-- v9.0 门禁与安全事件（AUDIT FIX 6.3 / 6.7 / 6.8）
-- 目标库：生产 D1（doubao-plaza）
-- 执行方式：
--   1) CREATE TABLE/INDEX 段：幂等（IF NOT EXISTS），可重复执行
--   2) ALTER TABLE 段：D1 无 ADD COLUMN IF NOT EXISTS，
--      对已存在的列会报 "duplicate column name"，执行方需逐条 try 并忽略该错误
--      （本文件各语句已按 batch 单条下发，单条失败不影响其余）
-- 时间基准：UTC（datetime('now') 即 UTC）
-- ============================================================

-- ------------------------------------------------------------
-- 1. users.api_allowed：第三方脚本 / API 直连白名单
--    0（默认）= 仅浏览器同源请求（带 X-DP-Client: plaza-v1 证明，
--               由三端 head 内联 fetch patch 注入）可调用 /api/*
--    1        = 允许 Bearer Token 直连绕过门禁（自动化 / 脚本白名单），
--               由开发者后台「账号查询管理」按需开通
-- ------------------------------------------------------------
ALTER TABLE users ADD COLUMN api_allowed INTEGER NOT NULL DEFAULT 0;

-- ------------------------------------------------------------
-- 2. security_events：门禁 403 / 蜜罐命中 / 限流 / 隔离诱饵审计事件
--    保留 90 天：中间件以 1% 概率执行
--      DELETE FROM security_events WHERE created_at < datetime('now','-90 days')
--    gate_403 的写入按 ip+path 在内存 Map 去重（~10 分钟），防刷爆表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,               -- gate_403 | honeypot | rate_limited | quarantine_401
  ip TEXT,                          -- CF-Connecting-IP（单源）
  path TEXT,                        -- 被拦 API 路径 / 蜜罐假路径
  user_id TEXT,                     -- 携带有效 Bearer 时记 user id，否则 NULL
  detail TEXT,                      -- 附加信息（限流 key、UA 摘要等），不存原始敏感数据
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_security_events_kind_time ON security_events(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at);
