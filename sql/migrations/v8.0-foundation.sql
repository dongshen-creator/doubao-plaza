-- ============================================================
-- v8.0 基础迁移（注册/登录简化 · 设备凭据 · 风控 · 隔离 · 清理）
-- 目标库：生产 D1（doubao-plaza）
-- 执行方式：
--   1) CREATE TABLE/INDEX 段：幂等（IF NOT EXISTS），可重复执行
--   2) ALTER TABLE 段：D1 无 ADD COLUMN IF NOT EXISTS，
--      对已存在的列会报 "duplicate column name"，执行方需逐条 try 并忽略该错误
--   3) users.name_norm 的 UNIQUE 索引必须在「历史昵称回填」完成后创建
--      （回填脚本见 tools/backfill-name-norm，见文末注释）
-- 时间基准：UTC（datetime('now') 即 UTC）
-- ============================================================

-- ------------------------------------------------------------
-- 1. users 表新列
-- ------------------------------------------------------------
ALTER TABLE users ADD COLUMN name_norm TEXT;              -- 昵称规范化登录键（NFC/零宽/空白/小写），UNIQUE 由索引保证
ALTER TABLE users ADD COLUMN quarantined_at TEXT;          -- 隔离（惩罚性隐身）开始时间 UTC
ALTER TABLE users ADD COLUMN quarantine_reason TEXT;
ALTER TABLE users ADD COLUMN quarantined_by TEXT;          -- 操作者 user id
ALTER TABLE users ADD COLUMN deactivated_at TEXT;          -- 清理：软删除时间（可恢复窗口起点）
ALTER TABLE users ADD COLUMN purge_after TEXT;             -- 清理：最终清除期限（软删除后默认 +30 天）
ALTER TABLE users ADD COLUMN last_active_at TEXT;          -- 最后「有效活跃」= 最近一次成功认证（登录/auto-login），匿名请求不得刷新
ALTER TABLE users ADD COLUMN totp_secret TEXT;             -- TOTP MFA 密钥（base32，敏感，永不返回前端）
ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN ip_backfilled_at TEXT;        -- 缺 IP 账号在补录窗口内正常登录时补录的标记

-- ------------------------------------------------------------
-- 2. login_attempts 扩展列（注册/登录风控信号）
-- ------------------------------------------------------------
ALTER TABLE login_attempts ADD COLUMN asn INTEGER;         -- request.cf.asn
ALTER TABLE login_attempts ADD COLUMN country TEXT;        -- request.cf.country
ALTER TABLE login_attempts ADD COLUMN canvas_hash TEXT;    -- Canvas 特征摘要（sha256 前 16 hex），仅辅助信号
ALTER TABLE login_attempts ADD COLUMN device_hash TEXT;    -- 设备标记 token 的 sha256（原始标记不落库不落日志）

-- ------------------------------------------------------------
-- 3. 设备凭据表（第一方高熵标记；只存 hash，不存原始 token）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,                     -- 服务端生成 32 hex
  token_hash TEXT NOT NULL UNIQUE,         -- sha256(raw token)，原始 token 仅存在于 __Host-dp_device Cookie
  status TEXT NOT NULL DEFAULT 'active',   -- active / banned / retired
  risk_level INTEGER DEFAULT 0,            -- 累积风险分（重领/新标记/代理等信号）
  claim_count INTEGER DEFAULT 0,           -- 领取次数（频繁重领是风险信号）
  created_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT,
  last_claim_at TEXT,
  created_ip TEXT                          -- 领取时来源 IP（限流与风控用）
);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
CREATE INDEX IF NOT EXISTS idx_devices_created_ip ON devices(created_ip, created_at);

-- ------------------------------------------------------------
-- 4. 设备-账号关系（可审计；一机一号由部分唯一索引在 DB 层保证）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_accounts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- active / released
  bound_at TEXT DEFAULT (datetime('now')),
  released_at TEXT,
  release_reason TEXT,                     -- rebind / admin_release / quarantine / cleanup
  UNIQUE(device_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_device_accounts_user ON device_accounts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_device_accounts_device ON device_accounts(device_id, status);
-- 一机一号核心约束：同一设备同时最多 1 个 active 绑定（并发绕过由该索引拒绝）
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_accounts_one_active
  ON device_accounts(device_id) WHERE status = 'active';

-- ------------------------------------------------------------
-- 5. 风控事件（设备标记及账号关联 / 注册 / 成功失败登录 / 隔离等）
--    用途、访问权限与保留期限见 docs/SECURITY.md；默认保留 90 天，定期清理
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS risk_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT,
  device_id TEXT,
  event_type TEXT NOT NULL,               -- register / login_ok / login_fail / device_claim / device_rebind / quarantine / quarantine_lift / cleanup / stepup / mfa
  ip TEXT,
  asn INTEGER,
  country TEXT,
  colo TEXT,
  ua TEXT,
  canvas_hash TEXT,
  canvas_status TEXT,                     -- ok / blocked / unsupported / absent
  risk_score INTEGER DEFAULT 0,
  action TEXT DEFAULT 'allowed',          -- allowed / challenge / blocked / quarantined
  detail TEXT,                            -- JSON（脱敏，不含密码/完整令牌）
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_risk_events_ip ON risk_events(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_risk_events_user ON risk_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_risk_events_type ON risk_events(event_type, created_at);

-- ------------------------------------------------------------
-- 6. 开发者后台审计日志（后台访问与管理操作）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,                   -- gate / search_user / quarantine / unquarantine / release_device / cleanup_dryrun / cleanup_execute / mfa_enable / stepup / ...
  target TEXT,                            -- 目标对象（user id / device id / run id）
  detail TEXT,                            -- JSON 脱敏
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON admin_audit_log(actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON admin_audit_log(action, created_at);

-- ------------------------------------------------------------
-- 7. step-up token（高风险操作要求近期认证，默认 10 分钟）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stepup_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  purpose TEXT DEFAULT 'devops',          -- 用途标签
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stepup_user ON stepup_tokens(user_id, expires_at);

-- ------------------------------------------------------------
-- 8. 清理运行记录（预演报告 / 执行报告持久化）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cleanup_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,                     -- dry_run / execute
  report TEXT NOT NULL,                   -- JSON 报告
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);

-- ------------------------------------------------------------
-- 9. UNIQUE 索引（必须最后单独执行，前置条件：name_norm 历史回填完成且无重复）
--    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name_norm ON users(name_norm);
--    （回填前执行会因历史重复昵称失败；由回填脚本收尾时创建）
-- ------------------------------------------------------------

-- site_settings 键（由运行时写入，无需预置）：
--   ip_backfill_deadline   — 缺 IP 账号 30 天补录窗口截止时间（ISO）
--   cleanup_final_run      — 最近一次清理运行 id
--   register_pow_secret / tor_exit_list_cache — 既有
