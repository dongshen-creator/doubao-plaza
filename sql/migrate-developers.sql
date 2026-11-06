-- 开发者权限迁移脚本
-- 背景：移除代码中硬编码的 DEV_IDS 白名单后，需在 D1 数据库中将原有白名单用户标记为开发者
-- 执行入口：Cloudflare Dashboard → Workers & Pages → D1 数据库 → Console

-- 1. 将原有硬编码白名单中的用户设为开发者
--    doubao_id = '470208447' 和 doubao_id = 'East_pairs'
UPDATE users SET is_developer = 1, updated_at = datetime('now')
WHERE doubao_id IN ('470208447', 'East_pairs') AND is_developer = 0;

-- 2. 验证：查看当前所有开发者
SELECT id, name, doubao_id, is_developer, updated_at
FROM users WHERE is_developer = 1;

-- 3. 后续管理：添加新开发者（替换 doubao_id 为目标用户的逗包ID）
-- UPDATE users SET is_developer = 1, updated_at = datetime('now') WHERE doubao_id = '新的逗包ID';

-- 4. 撤销开发者权限
-- UPDATE users SET is_developer = 0, updated_at = datetime('now') WHERE doubao_id = '目标逗包ID';
