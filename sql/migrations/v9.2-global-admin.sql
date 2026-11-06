-- ============================================================
-- V9.2 迁移：全局管理员标识 is_global_admin
-- - is_developer=0 但 is_global_admin=1 的账号可通过 devauth
--   （开发者后台 /api/developer/* 全部端点）鉴权
-- - 仅由真正的开发者（is_developer=1）在开发者弹窗中授予
-- D1 Console 逐条执行（重复执行报 duplicate column 忽略即可）
-- ============================================================

ALTER TABLE users ADD COLUMN is_global_admin INTEGER DEFAULT 0;
