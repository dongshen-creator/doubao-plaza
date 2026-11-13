-- ============================================================
-- V12.0 — 统一服务网关 / 三库共享同步
-- 适用：已有生产 D1 数据库增量升级（幂等，可重复执行）
-- 目标：doubao-plaza.pages.dev 与 WorkBuddy 发布域共用同一套后端服务。
--       D1 + Supabase 保持唯一事实来源；云库只存增量水位、审计与共享镜像。
-- ============================================================

-- 回写收件箱：云端数据不直接覆盖业务表，先落收件箱由管理员复核
CREATE TABLE IF NOT EXISTS cloud_sync_inbox (
  source TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT,
  synced_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (source, table_name, record_key)
);
CREATE INDEX IF NOT EXISTS idx_cloud_sync_inbox_time ON cloud_sync_inbox(updated_at);

-- 增量导出用到的时间列索引（COALESCE(updated_at, created_at) 表达式索引不可直接建，
-- 这里补 updated_at 单列索引；首次全量同步走顺序扫描，之后由水位收窄范围）
CREATE INDEX IF NOT EXISTS idx_users_updated ON users(updated_at);
CREATE INDEX IF NOT EXISTS idx_announcements_updated ON announcements(updated_at);
CREATE INDEX IF NOT EXISTS idx_features_updated ON features(updated_at);
CREATE INDEX IF NOT EXISTS idx_blog_posts_updated ON blog_posts(updated_at);
CREATE INDEX IF NOT EXISTS idx_site_settings_updated ON site_settings(updated_at);

-- ============================================================
-- 部署后需在 Cloudflare Pages 环境变量中配置：
--   SYNC_BRIDGE_TOKEN = <一个高强度随机字符串>
-- 未配置时 /api/sync/import 一律 503 失败关闭，不会放开匿名写入。
-- 前端「云服务」面板里手工输入该令牌，仅存于内存，不写入代码或 localStorage。
-- ============================================================

-- 回滚（仅在确认收件箱数据不再需要时手工执行）：
-- DROP INDEX IF EXISTS idx_cloud_sync_inbox_time;
-- DROP TABLE IF EXISTS cloud_sync_inbox;
