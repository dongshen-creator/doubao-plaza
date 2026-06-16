-- 逗包广场 Supabase 迁移：为 chat_channel_settings 添加 avatar_url 列
-- 将此 SQL 复制到 Supabase SQL Editor 中运行

ALTER TABLE chat_channel_settings ADD COLUMN IF NOT EXISTS avatar_url TEXT;
