-- ═══════════════════════════════════════════════════════════
-- 逗包用户广场 Supabase 数据库迁移脚本（唯一文件）
-- 使用方法：
--   1. 打开 Supabase Dashboard → SQL Editor → New query
--   2. 把这个文件的全部内容复制粘贴进去
--   3. 点 Run 执行
--   4. 可以重复执行，不会丢数据，不会报错
-- ═══════════════════════════════════════════════════════════

-- ===== 1. 聊天室 =====
CREATE TABLE IF NOT EXISTS chat_rooms (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'private',
  name TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===== 2. 聊天室成员 =====
CREATE TABLE IF NOT EXISTS chat_room_members (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  mute_notifications BOOLEAN DEFAULT FALSE,
  UNIQUE(room_id, user_id)
);

-- ===== 3. 消息 =====
CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  event_id TEXT,
  room_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT,
  sender_avatar TEXT,
  sender_doubao_id TEXT,
  content TEXT NOT NULL,
  reply_to TEXT,
  recalled BOOLEAN DEFAULT FALSE,
  rel_type TEXT,
  relates_to_event_id TEXT,
  ts BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===== 4. 表情反应 =====
CREATE TABLE IF NOT EXISTS chat_reactions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  reaction TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(event_id, reaction, sender_id)
);

-- ===== 5. 管理员 =====
CREATE TABLE IF NOT EXISTS chat_admins (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  set_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(room_id, user_id)
);

-- ===== 6. 禁言 =====
CREATE TABLE IF NOT EXISTS chat_muted (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  muted_by TEXT NOT NULL,
  muted_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(room_id, user_id)
);

-- ===== 7. 封禁 =====
CREATE TABLE IF NOT EXISTS chat_banned (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  banned_by TEXT NOT NULL,
  reason TEXT DEFAULT '',
  permanent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(room_id, user_id)
);

-- ===== 8. 频道设置 =====
CREATE TABLE IF NOT EXISTS chat_channel_settings (
  room_id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  admission TEXT DEFAULT 'open',
  admission_password TEXT,
  admission_custom_page_id TEXT,
  admission_questionnaire JSON,
  admission_mode TEXT DEFAULT 'open',
  topic TEXT DEFAULT '',
  avatar_url TEXT,
  guest_mode BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===== 9. 未读计数 =====
CREATE TABLE IF NOT EXISTS chat_unread (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  last_event_id TEXT,
  UNIQUE(room_id, user_id)
);

-- ===== 10. 频道公告 =====
CREATE TABLE IF NOT EXISTS chat_channel_announcements (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  pinned INTEGER DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

-- ===== 11. 频道工具（快捷链接）=====
CREATE TABLE IF NOT EXISTS chat_channel_tools (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  icon TEXT DEFAULT '🔗',
  sort_order INTEGER DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===== 12. 频道加入申请 =====
CREATE TABLE IF NOT EXISTS channel_join_requests (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  message TEXT DEFAULT '',
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(room_id, user_id)
);

-- ===== 13. 频道邀请码 =====
CREATE TABLE IF NOT EXISTS channel_invites (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  max_uses INTEGER DEFAULT 0,
  used_count INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ===== 14. 问卷题目表（幂等：不重置已有数据）=====
CREATE TABLE IF NOT EXISTS channel_questionnaires (
  id TEXT PRIMARY KEY,
  room_id TEXT,
  question TEXT,
  question_type TEXT DEFAULT 'single',
  options JSON,
  correct_answer JSON,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS channel_questionnaire_answers (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  question_id TEXT,
  user_answer JSON,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- 补齐可能缺失的列（幂等）
ALTER TABLE channel_questionnaires ADD COLUMN IF NOT EXISTS room_id TEXT;
ALTER TABLE channel_questionnaires ADD COLUMN IF NOT EXISTS question TEXT;
ALTER TABLE channel_questionnaires ADD COLUMN IF NOT EXISTS question_type TEXT DEFAULT 'single';
ALTER TABLE channel_questionnaires ADD COLUMN IF NOT EXISTS options JSON;
ALTER TABLE channel_questionnaires ADD COLUMN IF NOT EXISTS correct_answer JSON;
ALTER TABLE channel_questionnaires ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
ALTER TABLE channel_questionnaire_answers ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE channel_questionnaire_answers ADD COLUMN IF NOT EXISTS question_id TEXT;
ALTER TABLE channel_questionnaire_answers ADD COLUMN IF NOT EXISTS user_answer JSON;

-- ===== 15. 索引 =====
CREATE INDEX IF NOT EXISTS idx_msg_room_id ON chat_messages(room_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_msg_event ON chat_messages(event_id);
CREATE INDEX IF NOT EXISTS idx_member_room ON chat_room_members(room_id);
CREATE INDEX IF NOT EXISTS idx_member_user ON chat_room_members(user_id);
CREATE INDEX IF NOT EXISTS idx_unread_user ON chat_unread(user_id);
CREATE INDEX IF NOT EXISTS idx_cca_room ON chat_channel_announcements(room_id);
CREATE INDEX IF NOT EXISTS idx_cct_room ON chat_channel_tools(room_id);

-- ===== 16. 频道设置补字段（幂等） =====
ALTER TABLE chat_channel_settings ADD COLUMN IF NOT EXISTS admission_password TEXT;
ALTER TABLE chat_channel_settings ADD COLUMN IF NOT EXISTS admission_custom_page_id TEXT;
ALTER TABLE chat_channel_settings ADD COLUMN IF NOT EXISTS admission_questionnaire JSON;
ALTER TABLE chat_channel_settings ADD COLUMN IF NOT EXISTS admission_mode TEXT DEFAULT 'open';
ALTER TABLE chat_channel_settings ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE chat_channel_settings ADD COLUMN IF NOT EXISTS guest_mode BOOLEAN DEFAULT false;

-- ===== 16.1 公告可见性字段（幂等） =====
ALTER TABLE chat_channel_announcements ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'all';

-- ===== 16.2 公开频道表（开发者管理的全局公开频道） =====
CREATE TABLE IF NOT EXISTS public_channels (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL UNIQUE,
  group_name TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pubch_room ON public_channels(room_id);
CREATE INDEX IF NOT EXISTS idx_pubch_group ON public_channels(group_name);

-- ===== 16.3 公开频道 RLS 策略（所有人可读，仅开发者可写） =====
ALTER TABLE public_channels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_channels_read" ON public_channels;
CREATE POLICY "public_channels_read" ON public_channels FOR SELECT USING (true);
DROP POLICY IF EXISTS "public_channels_insert" ON public_channels;
CREATE POLICY "public_channels_insert" ON public_channels FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "public_channels_update" ON public_channels;
CREATE POLICY "public_channels_update" ON public_channels FOR UPDATE USING (true);
DROP POLICY IF EXISTS "public_channels_delete" ON public_channels;
CREATE POLICY "public_channels_delete" ON public_channels FOR DELETE USING (true);

-- ===== 17. 外键约束（幂等：先检查是否存在，先清理孤立数据） =====
-- 先清理引用了已删除房间的孤立记录，否则外键会创建失败
-- 使用 NOT EXISTS 而非 NOT IN，防止空表导致全量删除
DELETE FROM chat_unread WHERE NOT EXISTS (SELECT 1 FROM chat_rooms WHERE chat_rooms.id = chat_unread.room_id);
DELETE FROM chat_room_members WHERE NOT EXISTS (SELECT 1 FROM chat_rooms WHERE chat_rooms.id = chat_room_members.room_id);
DELETE FROM chat_messages WHERE NOT EXISTS (SELECT 1 FROM chat_rooms WHERE chat_rooms.id = chat_messages.room_id);
DELETE FROM chat_reactions WHERE NOT EXISTS (SELECT 1 FROM chat_rooms WHERE chat_rooms.id = chat_reactions.room_id);
DELETE FROM chat_admins WHERE NOT EXISTS (SELECT 1 FROM chat_rooms WHERE chat_rooms.id = chat_admins.room_id);
DELETE FROM chat_muted WHERE NOT EXISTS (SELECT 1 FROM chat_rooms WHERE chat_rooms.id = chat_muted.room_id);
DELETE FROM chat_banned WHERE NOT EXISTS (SELECT 1 FROM chat_rooms WHERE chat_rooms.id = chat_banned.room_id);
DELETE FROM chat_channel_settings WHERE NOT EXISTS (SELECT 1 FROM chat_rooms WHERE chat_rooms.id = chat_channel_settings.room_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_crm_room') THEN
    ALTER TABLE chat_room_members ADD CONSTRAINT fk_crm_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_cmsg_room') THEN
    ALTER TABLE chat_messages ADD CONSTRAINT fk_cmsg_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_crxn_room') THEN
    ALTER TABLE chat_reactions ADD CONSTRAINT fk_crxn_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_cadm_room') THEN
    ALTER TABLE chat_admins ADD CONSTRAINT fk_cadm_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_cmut_room') THEN
    ALTER TABLE chat_muted ADD CONSTRAINT fk_cmut_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_cban_room') THEN
    ALTER TABLE chat_banned ADD CONSTRAINT fk_cban_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_ccs_room') THEN
    ALTER TABLE chat_channel_settings ADD CONSTRAINT fk_ccs_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_curd_room') THEN
    ALTER TABLE chat_unread ADD CONSTRAINT fk_curd_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id);
  END IF;
END $$;

-- ===== 18. 未读计数触发器 =====
CREATE OR REPLACE FUNCTION increment_unread()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO chat_unread (room_id, user_id, count, last_event_id)
  SELECT NEW.room_id, m.user_id, 1, NEW.event_id
  FROM chat_room_members m
  WHERE m.room_id = NEW.room_id AND m.user_id != NEW.sender_id
  ON CONFLICT (room_id, user_id)
  DO UPDATE SET count = chat_unread.count + 1, last_event_id = NEW.event_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_unread_increment ON chat_messages;
CREATE TRIGGER trigger_unread_increment
AFTER INSERT ON chat_messages
FOR EACH ROW EXECUTE FUNCTION increment_unread();

-- ===== 19. 启用 Realtime（幂等：先检查是否已添加） =====
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_reactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_reactions;
  END IF;
END $$;
-- 注：user_presence 加入 Realtime 发布的语句已移至其建表语句（第 23 段）之后，
--     避免在全新数据库上执行时报"关系 user_presence 不存在"。

-- V5.9：聊天表设置 replica identity FULL，保证 postgres_changes 的 UPDATE/DELETE 能拿到完整旧行正确广播（幂等）
-- 群聊实时性依赖 Realtime 推送，此设置确保编辑/撤回/删除等变更也能实时同步到所有客户端
ALTER TABLE chat_messages REPLICA IDENTITY FULL;
ALTER TABLE chat_reactions REPLICA IDENTITY FULL;

-- ===== 20. 消息自动清理（7天保留 + pg_cron 定时任务）=====
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION cleanup_old_chat_messages()
RETURNS TABLE(deleted_messages bigint, deleted_reactions bigint) AS $$
DECLARE
  cutoff_ts bigint;
  msg_count bigint;
  react_count bigint;
BEGIN
  cutoff_ts := (EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days') * 1000)::bigint;

  DELETE FROM chat_reactions
  WHERE NOT EXISTS (
    SELECT 1 FROM chat_messages
    WHERE chat_messages.event_id = chat_reactions.event_id
  );
  GET DIAGNOSTICS react_count = ROW_COUNT;

  DELETE FROM chat_messages
  WHERE ts < cutoff_ts;
  GET DIAGNOSTICS msg_count = ROW_COUNT;

  DELETE FROM chat_reactions
  WHERE NOT EXISTS (
    SELECT 1 FROM chat_messages
    WHERE chat_messages.event_id = chat_reactions.event_id
  );

  RETURN QUERY SELECT msg_count, react_count;
END;
$$ LANGUAGE plpgsql;

-- 每日 03:00 清理 7 天前的旧消息；先删同名任务再重建，保证重复执行脚本不会堆积多余定时任务
DO $do$ BEGIN
  BEGIN
    PERFORM cron.unschedule('cleanup-old-chat-messages');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  PERFORM cron.schedule('cleanup-old-chat-messages', '0 3 * * *', 'SELECT * FROM cleanup_old_chat_messages()');
END $do$;

-- ===== 21. Storage 存储桶权限（需要先在 Storage 页面创建 pages 桶）=====
DROP POLICY IF EXISTS "Public read" ON storage.objects;
CREATE POLICY "Public read" ON storage.objects
FOR SELECT USING (bucket_id = 'pages');

DROP POLICY IF EXISTS "Auth upload" ON storage.objects;
CREATE POLICY "Auth upload" ON storage.objects
FOR INSERT WITH CHECK (bucket_id = 'pages');

DROP POLICY IF EXISTS "Auth delete" ON storage.objects;
CREATE POLICY "Auth delete" ON storage.objects
FOR DELETE USING (bucket_id = 'pages');

DROP POLICY IF EXISTS "Auth update" ON storage.objects;
CREATE POLICY "Auth update" ON storage.objects
FOR UPDATE USING (bucket_id = 'pages');

-- ═══════════════════════════════════════════════════════════
-- 21.x 辅助判定函数 + 开发者白名单（在所有 RLS 策略与门禁 RPC 之前定义）
-- 说明：app_user_id / is_channel_public / is_room_* / is_developer 被下方
--       第 22/30/31 段的 RLS 策略与服务端 RPC 依赖，必须先定义，否则脚本
--       在全新数据库上执行到引用处会报"函数不存在"。此处统一前置定义。
-- ═══════════════════════════════════════════════════════════

-- 辅助函数：从 JWT 中提取用户 ID（兼容非 UUID 格式的自定义用户 ID）
CREATE OR REPLACE FUNCTION public.app_user_id() RETURNS TEXT
LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(
    -- 1. 尝试从 request.jwt.claim.app_metadata 提取（旧方式，对 HS256 有效）
    NULLIF((current_setting('request.jwt.claim.app_metadata', true)::jsonb)->>'d1_user_id', ''),
    -- 2. 从 request.jwt.claims 整体 JSON 中提取 app_metadata.d1_user_id（对 ES256 有效）
    NULLIF((current_setting('request.jwt.claims', true)::jsonb)->'app_metadata'->>'d1_user_id', ''),
    -- 3. 从 request.jwt.claims 整体 JSON 中提取 email 并解析
    NULLIF(substring(current_setting('request.jwt.claims', true)::jsonb->>'email' FROM '^d1_([a-f0-9]+)@dbp\.local$'), ''),
    -- 4. 回退到 request.jwt.claim.sub
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    -- 5. 回退到 request.jwt.claims 整体 JSON 中的 sub
    NULLIF(current_setting('request.jwt.claims', true)::jsonb->>'sub', '')
  )
$$;

-- developers 开发者白名单表（public_channels 写权限依据；由 postgres/service_role 维护）
CREATE TABLE IF NOT EXISTS public.developers (
  user_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.developers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "dev_read_self" ON public.developers;
CREATE POLICY "dev_read_self" ON public.developers FOR SELECT USING (app_user_id() = user_id);
-- 写：不授予 anon/authenticated（无策略=拒绝），仅 postgres/service_role 可维护

-- 辅助判定函数（SECURITY DEFINER，供 RLS 策略使用，避免同表递归/绕过 RLS）
CREATE OR REPLACE FUNCTION public.is_channel_public(p_room_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM chat_rooms WHERE id = p_room_id AND type = 'channel');
$$;

CREATE OR REPLACE FUNCTION public.is_room_creator(p_room_id text, p_user_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM chat_rooms WHERE id = p_room_id AND created_by = p_user_id);
$$;

CREATE OR REPLACE FUNCTION public.is_room_member(p_room_id text, p_user_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM chat_room_members WHERE room_id = p_room_id AND user_id = p_user_id);
$$;

CREATE OR REPLACE FUNCTION public.is_room_admin(p_room_id text, p_user_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM chat_admins WHERE room_id = p_room_id AND user_id = p_user_id);
$$;

CREATE OR REPLACE FUNCTION public.is_developer(p_user_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM developers WHERE user_id = p_user_id);
$$;

GRANT EXECUTE ON FUNCTION public.is_channel_public(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_room_creator(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_room_member(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_room_admin(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_developer(text) TO anon, authenticated;

-- ===== 22. 所有聊天表 RLS 策略 =====
-- 修复 admission_mode DEFAULT 'open' 覆盖旧 admission 值的问题
UPDATE chat_channel_settings SET admission_mode = admission WHERE admission_mode = 'open' AND admission IS NOT NULL AND admission != 'open';

-- 本应用使用自定义鉴权（D1 + Cloudflare Functions），Supabase 仅作数据存储
-- 因此所有表需要对 anon key 完全开放读写

-- chat_rooms
ALTER TABLE chat_rooms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chat_rooms_read" ON chat_rooms;
CREATE POLICY "chat_rooms_read" ON chat_rooms FOR SELECT USING (true);
DROP POLICY IF EXISTS "chat_rooms_insert" ON chat_rooms;
CREATE POLICY "chat_rooms_insert" ON chat_rooms FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "chat_rooms_update" ON chat_rooms;
CREATE POLICY "chat_rooms_update" ON chat_rooms FOR UPDATE USING (true);
DROP POLICY IF EXISTS "chat_rooms_delete" ON chat_rooms;
CREATE POLICY "chat_rooms_delete" ON chat_rooms FOR DELETE USING (true);

-- chat_room_members
ALTER TABLE chat_room_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chat_room_members_read" ON chat_room_members;
CREATE POLICY "chat_room_members_read" ON chat_room_members FOR SELECT USING (true);
DROP POLICY IF EXISTS "chat_room_members_insert" ON chat_room_members;
CREATE POLICY "chat_room_members_insert" ON chat_room_members FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "chat_room_members_update" ON chat_room_members;
CREATE POLICY "chat_room_members_update" ON chat_room_members FOR UPDATE USING (true);
DROP POLICY IF EXISTS "chat_room_members_delete" ON chat_room_members;
CREATE POLICY "chat_room_members_delete" ON chat_room_members FOR DELETE USING (true);

-- chat_messages
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chat_messages_read" ON chat_messages;
CREATE POLICY "chat_messages_read" ON chat_messages FOR SELECT USING (true);
DROP POLICY IF EXISTS "chat_messages_insert" ON chat_messages;
CREATE POLICY "chat_messages_insert" ON chat_messages FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "chat_messages_update" ON chat_messages;
CREATE POLICY "chat_messages_update" ON chat_messages FOR UPDATE USING (true);
DROP POLICY IF EXISTS "chat_messages_delete" ON chat_messages;
CREATE POLICY "chat_messages_delete" ON chat_messages FOR DELETE USING (true);

-- chat_reactions
ALTER TABLE chat_reactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chat_reactions_read" ON chat_reactions;
CREATE POLICY "chat_reactions_read" ON chat_reactions FOR SELECT USING (true);
DROP POLICY IF EXISTS "chat_reactions_insert" ON chat_reactions;
CREATE POLICY "chat_reactions_insert" ON chat_reactions FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "chat_reactions_delete" ON chat_reactions;
CREATE POLICY "chat_reactions_delete" ON chat_reactions FOR DELETE USING (true);

-- chat_admins
ALTER TABLE chat_admins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chat_admins_read" ON chat_admins;
CREATE POLICY "chat_admins_read" ON chat_admins FOR SELECT USING (true);
DROP POLICY IF EXISTS "chat_admins_insert" ON chat_admins;
CREATE POLICY "chat_admins_insert" ON chat_admins FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "chat_admins_delete" ON chat_admins;
CREATE POLICY "chat_admins_delete" ON chat_admins FOR DELETE USING (true);

-- chat_muted
ALTER TABLE chat_muted ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chat_muted_read" ON chat_muted;
CREATE POLICY "chat_muted_read" ON chat_muted FOR SELECT USING (true);
DROP POLICY IF EXISTS "chat_muted_insert" ON chat_muted;
CREATE POLICY "chat_muted_insert" ON chat_muted FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "chat_muted_update" ON chat_muted;
CREATE POLICY "chat_muted_update" ON chat_muted FOR UPDATE USING (true);
DROP POLICY IF EXISTS "chat_muted_delete" ON chat_muted;
CREATE POLICY "chat_muted_delete" ON chat_muted FOR DELETE USING (true);

-- chat_banned
ALTER TABLE chat_banned ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chat_banned_read" ON chat_banned;
CREATE POLICY "chat_banned_read" ON chat_banned FOR SELECT USING (true);
DROP POLICY IF EXISTS "chat_banned_insert" ON chat_banned;
CREATE POLICY "chat_banned_insert" ON chat_banned FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "chat_banned_delete" ON chat_banned;
CREATE POLICY "chat_banned_delete" ON chat_banned FOR DELETE USING (true);

-- chat_unread
ALTER TABLE chat_unread ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chat_unread_read" ON chat_unread;
CREATE POLICY "chat_unread_read" ON chat_unread FOR SELECT USING (true);
DROP POLICY IF EXISTS "chat_unread_insert" ON chat_unread;
CREATE POLICY "chat_unread_insert" ON chat_unread FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "chat_unread_update" ON chat_unread;
CREATE POLICY "chat_unread_update" ON chat_unread FOR UPDATE USING (true);
DROP POLICY IF EXISTS "chat_unread_delete" ON chat_unread;
CREATE POLICY "chat_unread_delete" ON chat_unread FOR DELETE USING (true);

-- chat_channel_settings
ALTER TABLE chat_channel_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chat_channel_settings_read" ON chat_channel_settings;
CREATE POLICY "chat_channel_settings_read" ON chat_channel_settings FOR SELECT USING (true);
DROP POLICY IF EXISTS "chat_channel_settings_insert" ON chat_channel_settings;
CREATE POLICY "chat_channel_settings_insert" ON chat_channel_settings FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "chat_channel_settings_update" ON chat_channel_settings;
CREATE POLICY "chat_channel_settings_update" ON chat_channel_settings FOR UPDATE USING (true);
DROP POLICY IF EXISTS "chat_channel_settings_delete" ON chat_channel_settings;
CREATE POLICY "chat_channel_settings_delete" ON chat_channel_settings FOR DELETE USING (true);

-- chat_channel_announcements
ALTER TABLE chat_channel_announcements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chat_channel_announcements_read" ON chat_channel_announcements;
CREATE POLICY "chat_channel_announcements_read" ON chat_channel_announcements FOR SELECT USING (true);
DROP POLICY IF EXISTS "chat_channel_announcements_insert" ON chat_channel_announcements;
CREATE POLICY "chat_channel_announcements_insert" ON chat_channel_announcements FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "chat_channel_announcements_update" ON chat_channel_announcements;
CREATE POLICY "chat_channel_announcements_update" ON chat_channel_announcements FOR UPDATE USING (true);
DROP POLICY IF EXISTS "chat_channel_announcements_delete" ON chat_channel_announcements;
CREATE POLICY "chat_channel_announcements_delete" ON chat_channel_announcements FOR DELETE USING (true);

-- chat_channel_tools
ALTER TABLE chat_channel_tools ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chat_channel_tools_read" ON chat_channel_tools;
CREATE POLICY "chat_channel_tools_read" ON chat_channel_tools FOR SELECT USING (true);
DROP POLICY IF EXISTS "chat_channel_tools_insert" ON chat_channel_tools;
CREATE POLICY "chat_channel_tools_insert" ON chat_channel_tools FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "chat_channel_tools_delete" ON chat_channel_tools;
CREATE POLICY "chat_channel_tools_delete" ON chat_channel_tools FOR DELETE USING (true);

-- channel_join_requests
ALTER TABLE channel_join_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "任何人可插入入群申请" ON channel_join_requests;
CREATE POLICY "任何人可插入入群申请" ON channel_join_requests
  FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "任何人可读取入群申请" ON channel_join_requests;
CREATE POLICY "任何人可读取入群申请" ON channel_join_requests
  FOR SELECT USING (true);
DROP POLICY IF EXISTS "任何人可更新入群申请" ON channel_join_requests;
CREATE POLICY "任何人可更新入群申请" ON channel_join_requests
  FOR UPDATE USING (true);
DROP POLICY IF EXISTS "任何人可删除入群申请" ON channel_join_requests;
CREATE POLICY "任何人可删除入群申请" ON channel_join_requests
  FOR DELETE USING (true);

-- channel_invites
ALTER TABLE channel_invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "channel_invites_read" ON channel_invites;
CREATE POLICY "channel_invites_read" ON channel_invites FOR SELECT USING (true);
DROP POLICY IF EXISTS "channel_invites_insert" ON channel_invites;
CREATE POLICY "channel_invites_insert" ON channel_invites FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "channel_invites_update" ON channel_invites;
CREATE POLICY "channel_invites_update" ON channel_invites FOR UPDATE USING (true);
DROP POLICY IF EXISTS "channel_invites_delete" ON channel_invites;
CREATE POLICY "channel_invites_delete" ON channel_invites FOR DELETE USING (true);

-- questionnaire tables
ALTER TABLE channel_questionnaires ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "channel_questionnaires_read" ON channel_questionnaires;
CREATE POLICY "channel_questionnaires_read" ON channel_questionnaires FOR SELECT USING (true);
DROP POLICY IF EXISTS "channel_questionnaires_insert" ON channel_questionnaires;
CREATE POLICY "channel_questionnaires_insert" ON channel_questionnaires FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "channel_questionnaires_delete" ON channel_questionnaires;
CREATE POLICY "channel_questionnaires_delete" ON channel_questionnaires FOR DELETE USING (true);

ALTER TABLE channel_questionnaire_answers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "channel_questionnaire_answers_read" ON channel_questionnaire_answers;
CREATE POLICY "channel_questionnaire_answers_read" ON channel_questionnaire_answers FOR SELECT USING (true);
DROP POLICY IF EXISTS "channel_questionnaire_answers_insert" ON channel_questionnaire_answers;
CREATE POLICY "channel_questionnaire_answers_insert" ON channel_questionnaire_answers FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "channel_questionnaire_answers_delete" ON channel_questionnaire_answers;
CREATE POLICY "channel_questionnaire_answers_delete" ON channel_questionnaire_answers FOR DELETE USING (true);

-- ===== 23. 在线用户状态表 =====
CREATE TABLE IF NOT EXISTS user_presence (
  user_id TEXT PRIMARY KEY,
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'online'
);
ALTER TABLE user_presence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_presence_read" ON user_presence;
CREATE POLICY "user_presence_read" ON user_presence FOR SELECT USING (true);
DROP POLICY IF EXISTS "user_presence_insert" ON user_presence;
CREATE POLICY "user_presence_insert" ON user_presence FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "user_presence_update" ON user_presence;
CREATE POLICY "user_presence_update" ON user_presence FOR UPDATE USING (true);
DROP POLICY IF EXISTS "user_presence_delete" ON user_presence;
CREATE POLICY "user_presence_delete" ON user_presence FOR DELETE USING (true);

-- 23.1 user_presence 加入 Realtime 发布，实现上线提醒实时推送（幂等；置于建表之后）
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'user_presence'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE user_presence;
  END IF;
END $$;

-- ===== 24. 频道工具扩展字段（支持多种工具类型） =====
ALTER TABLE chat_channel_tools ADD COLUMN IF NOT EXISTS tool_type TEXT DEFAULT 'link';
ALTER TABLE chat_channel_tools ADD COLUMN IF NOT EXISTS config JSON;
ALTER TABLE chat_channel_tools ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
-- 补充 UPDATE 策略（原来只有 CRUD 中的 R/I/D）
DROP POLICY IF EXISTS "chat_channel_tools_update" ON chat_channel_tools;
CREATE POLICY "chat_channel_tools_update" ON chat_channel_tools FOR UPDATE USING (true);

-- ===== 25. 投票工具表 =====
CREATE TABLE IF NOT EXISTS chat_tool_votes (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options JSON NOT NULL,
  closed BOOLEAN DEFAULT FALSE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ctv_tool ON chat_tool_votes(tool_id);
CREATE TABLE IF NOT EXISTS chat_tool_vote_records (
  id TEXT PRIMARY KEY,
  vote_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(vote_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_ctvr_vote ON chat_tool_vote_records(vote_id);

-- ===== 26. 接龙工具表 =====
CREATE TABLE IF NOT EXISTS chat_tool_chains (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  content TEXT NOT NULL,
  seq INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT,
  user_avatar TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ctc_tool ON chat_tool_chains(tool_id, seq);

-- ===== 27. 个人名片工具表（已废弃，删除残留表） =====
DROP TABLE IF EXISTS chat_tool_cards;

-- ===== 28. 新工具表 RLS 策略 =====
ALTER TABLE chat_tool_votes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ctv_read" ON chat_tool_votes;
CREATE POLICY "ctv_read" ON chat_tool_votes FOR SELECT USING (true);
DROP POLICY IF EXISTS "ctv_insert" ON chat_tool_votes;
CREATE POLICY "ctv_insert" ON chat_tool_votes FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "ctv_update" ON chat_tool_votes;
CREATE POLICY "ctv_update" ON chat_tool_votes FOR UPDATE USING (true);
DROP POLICY IF EXISTS "ctv_delete" ON chat_tool_votes;
CREATE POLICY "ctv_delete" ON chat_tool_votes FOR DELETE USING (true);

ALTER TABLE chat_tool_vote_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ctvr_read" ON chat_tool_vote_records;
CREATE POLICY "ctvr_read" ON chat_tool_vote_records FOR SELECT USING (true);
DROP POLICY IF EXISTS "ctvr_insert" ON chat_tool_vote_records;
CREATE POLICY "ctvr_insert" ON chat_tool_vote_records FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "ctvr_delete" ON chat_tool_vote_records;
CREATE POLICY "ctvr_delete" ON chat_tool_vote_records FOR DELETE USING (true);

ALTER TABLE chat_tool_chains ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ctc_read" ON chat_tool_chains;
CREATE POLICY "ctc_read" ON chat_tool_chains FOR SELECT USING (true);
DROP POLICY IF EXISTS "ctc_insert" ON chat_tool_chains;
CREATE POLICY "ctc_insert" ON chat_tool_chains FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "ctc_delete" ON chat_tool_chains;
CREATE POLICY "ctc_delete" ON chat_tool_chains FOR DELETE USING (true);

-- chat_tool_cards 已废弃，RLS 策略不再需要

-- ===== 29. 新工具表 Realtime =====
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'chat_tool_votes') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_tool_votes;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'chat_tool_vote_records') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_tool_vote_records;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'chat_tool_chains') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_tool_chains;
  END IF;
END $$;
-- chat_tool_cards 已废弃，Realtime 订阅不再需要

-- ═══════════════════════════════════════════════════════════
-- ===== 30. 安全加固：RLS 策略收紧（V1+V3 修复）=====
-- 原有策略对 anon 完全开放读写，现改为：
-- - SELECT 保持开放（Realtime 读取需要）
-- - INSERT/UPDATE/DELETE 收紧为 TO authenticated + 身份校验
-- 前端通过自定义 JWT（signSupabaseJWT）获取 authenticated 角色
-- （app_user_id 等辅助函数已在 21.x 前置定义）
-- ═══════════════════════════════════════════════════════════

-- chat_rooms：仅创建者可创建/修改/删除
DROP POLICY IF EXISTS "chat_rooms_insert" ON chat_rooms;
CREATE POLICY "chat_rooms_insert" ON chat_rooms FOR INSERT TO authenticated
  WITH CHECK (app_user_id() = created_by);
DROP POLICY IF EXISTS "chat_rooms_update" ON chat_rooms;
CREATE POLICY "chat_rooms_update" ON chat_rooms FOR UPDATE TO authenticated
  USING (app_user_id() = created_by);
DROP POLICY IF EXISTS "chat_rooms_delete" ON chat_rooms;
CREATE POLICY "chat_rooms_delete" ON chat_rooms FOR DELETE TO authenticated
  USING (app_user_id() = created_by);

-- chat_room_members：本人可加入/退出，频道创建者可删除所有成员（删除频道时）
DROP POLICY IF EXISTS "chat_room_members_insert" ON chat_room_members;
CREATE POLICY "chat_room_members_insert" ON chat_room_members FOR INSERT TO authenticated
  WITH CHECK (
    app_user_id() = user_id
    OR EXISTS (SELECT 1 FROM chat_rooms WHERE id = chat_room_members.room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_room_members.room_id AND user_id = app_user_id())
  );
DROP POLICY IF EXISTS "chat_room_members_update" ON chat_room_members;
CREATE POLICY "chat_room_members_update" ON chat_room_members FOR UPDATE TO authenticated
  USING (app_user_id() = user_id);
DROP POLICY IF EXISTS "chat_room_members_delete" ON chat_room_members;
CREATE POLICY "chat_room_members_delete" ON chat_room_members FOR DELETE TO authenticated
  USING (
    app_user_id() = user_id
    OR EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
  );

-- chat_messages：房间成员可发消息，sender_id 必须为本人；V5.0 修复：公开频道（is_channel_public）无需成员记录即可发送（与读取策略对齐，解决加入流程中断导致成员缺失时发不出消息）；管理员/创建者可撤回/删除
DROP POLICY IF EXISTS "chat_messages_insert" ON chat_messages;
CREATE POLICY "chat_messages_insert" ON chat_messages FOR INSERT TO authenticated
  WITH CHECK (
    app_user_id() = sender_id
    AND (
      is_channel_public(room_id)
      OR EXISTS (SELECT 1 FROM chat_room_members WHERE room_id = chat_messages.room_id AND user_id = app_user_id())
    )
  );
DROP POLICY IF EXISTS "chat_messages_update" ON chat_messages;
CREATE POLICY "chat_messages_update" ON chat_messages FOR UPDATE TO authenticated
  USING (
    app_user_id() = sender_id
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_messages.room_id AND user_id = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_rooms WHERE id = chat_messages.room_id AND created_by = app_user_id())
  );
DROP POLICY IF EXISTS "chat_messages_delete" ON chat_messages;
CREATE POLICY "chat_messages_delete" ON chat_messages FOR DELETE TO authenticated
  USING (
    app_user_id() = sender_id
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_messages.room_id AND user_id = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_rooms WHERE id = chat_messages.room_id AND created_by = app_user_id())
  );

-- chat_reactions：仅本人可添加/删除自己的反应；管理员/创建者可删除（删除频道时）
DROP POLICY IF EXISTS "chat_reactions_insert" ON chat_reactions;
CREATE POLICY "chat_reactions_insert" ON chat_reactions FOR INSERT TO authenticated
  WITH CHECK (app_user_id() = sender_id);
DROP POLICY IF EXISTS "chat_reactions_delete" ON chat_reactions;
CREATE POLICY "chat_reactions_delete" ON chat_reactions FOR DELETE TO authenticated
  USING (
    app_user_id() = sender_id
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_reactions.room_id AND user_id = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_rooms WHERE id = chat_reactions.room_id AND created_by = app_user_id())
  );

-- chat_admins：仅频道创建者可管理管理员
DROP POLICY IF EXISTS "chat_admins_insert" ON chat_admins;
CREATE POLICY "chat_admins_insert" ON chat_admins FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
  );
DROP POLICY IF EXISTS "chat_admins_delete" ON chat_admins;
CREATE POLICY "chat_admins_delete" ON chat_admins FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
  );

-- chat_muted：仅频道创建者/管理员可操作
DROP POLICY IF EXISTS "chat_muted_insert" ON chat_muted;
CREATE POLICY "chat_muted_insert" ON chat_muted FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_muted.room_id AND user_id = app_user_id())
  );
DROP POLICY IF EXISTS "chat_muted_update" ON chat_muted;
CREATE POLICY "chat_muted_update" ON chat_muted FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_muted.room_id AND user_id = app_user_id())
  );
DROP POLICY IF EXISTS "chat_muted_delete" ON chat_muted;
CREATE POLICY "chat_muted_delete" ON chat_muted FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_muted.room_id AND user_id = app_user_id())
  );

-- chat_banned：仅频道创建者/管理员可操作
DROP POLICY IF EXISTS "chat_banned_insert" ON chat_banned;
CREATE POLICY "chat_banned_insert" ON chat_banned FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_banned.room_id AND user_id = app_user_id())
  );
DROP POLICY IF EXISTS "chat_banned_delete" ON chat_banned;
CREATE POLICY "chat_banned_delete" ON chat_banned FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_banned.room_id AND user_id = app_user_id())
  );

-- chat_unread：仅本人可更新自己的未读计数；频道创建者可删除所有（删除频道时）
DROP POLICY IF EXISTS "chat_unread_insert" ON chat_unread;
CREATE POLICY "chat_unread_insert" ON chat_unread FOR INSERT TO authenticated
  WITH CHECK (app_user_id() = user_id);
DROP POLICY IF EXISTS "chat_unread_update" ON chat_unread;
CREATE POLICY "chat_unread_update" ON chat_unread FOR UPDATE TO authenticated
  USING (app_user_id() = user_id);
DROP POLICY IF EXISTS "chat_unread_delete" ON chat_unread;
CREATE POLICY "chat_unread_delete" ON chat_unread FOR DELETE TO authenticated
  USING (
    app_user_id() = user_id
    OR EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
  );

-- chat_channel_settings：仅频道创建者/管理员可修改
DROP POLICY IF EXISTS "chat_channel_settings_insert" ON chat_channel_settings;
CREATE POLICY "chat_channel_settings_insert" ON chat_channel_settings FOR INSERT TO authenticated
  WITH CHECK (app_user_id() = created_by);
DROP POLICY IF EXISTS "chat_channel_settings_update" ON chat_channel_settings;
CREATE POLICY "chat_channel_settings_update" ON chat_channel_settings FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_channel_settings.room_id AND user_id = app_user_id())
  );
DROP POLICY IF EXISTS "chat_channel_settings_delete" ON chat_channel_settings;
CREATE POLICY "chat_channel_settings_delete" ON chat_channel_settings FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_channel_settings.room_id AND user_id = app_user_id())
  );

-- chat_channel_announcements：仅频道创建者/管理员可发公告
DROP POLICY IF EXISTS "chat_channel_announcements_insert" ON chat_channel_announcements;
CREATE POLICY "chat_channel_announcements_insert" ON chat_channel_announcements FOR INSERT TO authenticated
  WITH CHECK (
    app_user_id() = created_by AND (
      EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
      OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_channel_announcements.room_id AND user_id = app_user_id())
    )
  );
DROP POLICY IF EXISTS "chat_channel_announcements_update" ON chat_channel_announcements;
CREATE POLICY "chat_channel_announcements_update" ON chat_channel_announcements FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_channel_announcements.room_id AND user_id = app_user_id())
  );
DROP POLICY IF EXISTS "chat_channel_announcements_delete" ON chat_channel_announcements;
CREATE POLICY "chat_channel_announcements_delete" ON chat_channel_announcements FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_channel_announcements.room_id AND user_id = app_user_id())
  );

-- chat_channel_tools：仅频道创建者/管理员可管理工具
DROP POLICY IF EXISTS "chat_channel_tools_insert" ON chat_channel_tools;
CREATE POLICY "chat_channel_tools_insert" ON chat_channel_tools FOR INSERT TO authenticated
  WITH CHECK (
    app_user_id() = created_by AND (
      EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
      OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_channel_tools.room_id AND user_id = app_user_id())
    )
  );
DROP POLICY IF EXISTS "chat_channel_tools_update" ON chat_channel_tools;
CREATE POLICY "chat_channel_tools_update" ON chat_channel_tools FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_channel_tools.room_id AND user_id = app_user_id())
  );
DROP POLICY IF EXISTS "chat_channel_tools_delete" ON chat_channel_tools;
CREATE POLICY "chat_channel_tools_delete" ON chat_channel_tools FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_channel_tools.room_id AND user_id = app_user_id())
  );

-- channel_join_requests：用户可提交自己的申请，频道管理员可审批
DROP POLICY IF EXISTS "任何人可插入入群申请" ON channel_join_requests;
DROP POLICY IF EXISTS "join_requests_insert" ON channel_join_requests;
CREATE POLICY "join_requests_insert" ON channel_join_requests FOR INSERT TO authenticated
  WITH CHECK (app_user_id() = user_id);
DROP POLICY IF EXISTS "任何人可更新入群申请" ON channel_join_requests;
DROP POLICY IF EXISTS "join_requests_update" ON channel_join_requests;
CREATE POLICY "join_requests_update" ON channel_join_requests FOR UPDATE TO authenticated
  USING (
    app_user_id() = user_id
    OR EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = channel_join_requests.room_id AND user_id = app_user_id())
  );
DROP POLICY IF EXISTS "任何人可删除入群申请" ON channel_join_requests;
DROP POLICY IF EXISTS "join_requests_delete" ON channel_join_requests;
CREATE POLICY "join_requests_delete" ON channel_join_requests FOR DELETE TO authenticated
  USING (
    app_user_id() = user_id
    OR EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = channel_join_requests.room_id AND user_id = app_user_id())
  );

-- channel_invites：仅频道创建者/管理员可操作
DROP POLICY IF EXISTS "channel_invites_insert" ON channel_invites;
CREATE POLICY "channel_invites_insert" ON channel_invites FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = channel_invites.room_id AND user_id = app_user_id())
  );
DROP POLICY IF EXISTS "channel_invites_update" ON channel_invites;
CREATE POLICY "channel_invites_update" ON channel_invites FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = channel_invites.room_id AND user_id = app_user_id())
  );
DROP POLICY IF EXISTS "channel_invites_delete" ON channel_invites;
CREATE POLICY "channel_invites_delete" ON channel_invites FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = channel_invites.room_id AND user_id = app_user_id())
  );

-- questionnaire tables：仅频道创建者/管理员可管理
DROP POLICY IF EXISTS "channel_questionnaires_insert" ON channel_questionnaires;
CREATE POLICY "channel_questionnaires_insert" ON channel_questionnaires FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = channel_questionnaires.room_id AND user_id = app_user_id())
  );
DROP POLICY IF EXISTS "channel_questionnaires_delete" ON channel_questionnaires;
CREATE POLICY "channel_questionnaires_delete" ON channel_questionnaires FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM chat_rooms WHERE id = room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = channel_questionnaires.room_id AND user_id = app_user_id())
  );
DROP POLICY IF EXISTS "channel_questionnaire_answers_insert" ON channel_questionnaire_answers;
CREATE POLICY "channel_questionnaire_answers_insert" ON channel_questionnaire_answers FOR INSERT TO authenticated
  WITH CHECK (app_user_id() = (SELECT user_id FROM channel_join_requests WHERE id = request_id));

-- user_presence：仅本人可更新在线状态
DROP POLICY IF EXISTS "user_presence_insert" ON user_presence;
CREATE POLICY "user_presence_insert" ON user_presence FOR INSERT TO authenticated
  WITH CHECK (app_user_id() = user_id);
DROP POLICY IF EXISTS "user_presence_update" ON user_presence;
CREATE POLICY "user_presence_update" ON user_presence FOR UPDATE TO authenticated
  USING (app_user_id() = user_id);
DROP POLICY IF EXISTS "user_presence_delete" ON user_presence;
CREATE POLICY "user_presence_delete" ON user_presence FOR DELETE TO authenticated
  USING (app_user_id() = user_id);

-- public_channels：需要登录才能操作（开发者权限由 Worker 端校验）
DROP POLICY IF EXISTS "public_channels_insert" ON public_channels;
CREATE POLICY "public_channels_insert" ON public_channels FOR INSERT TO authenticated
  WITH CHECK (true);
DROP POLICY IF EXISTS "public_channels_update" ON public_channels;
CREATE POLICY "public_channels_update" ON public_channels FOR UPDATE TO authenticated
  USING (true);
DROP POLICY IF EXISTS "public_channels_delete" ON public_channels;
CREATE POLICY "public_channels_delete" ON public_channels FOR DELETE TO authenticated
  USING (true);

-- chat_tool_votes：仅本人可创建投票（创建者权限由应用层校验）
DROP POLICY IF EXISTS "ctv_insert" ON chat_tool_votes;
CREATE POLICY "ctv_insert" ON chat_tool_votes FOR INSERT TO authenticated
  WITH CHECK (app_user_id() = created_by);
DROP POLICY IF EXISTS "ctv_update" ON chat_tool_votes;
CREATE POLICY "ctv_update" ON chat_tool_votes FOR UPDATE TO authenticated
  USING (app_user_id() = created_by);
DROP POLICY IF EXISTS "ctv_delete" ON chat_tool_votes;
CREATE POLICY "ctv_delete" ON chat_tool_votes FOR DELETE TO authenticated
  USING (app_user_id() = created_by);

-- chat_tool_vote_records：仅本人可投票
DROP POLICY IF EXISTS "ctvr_insert" ON chat_tool_vote_records;
CREATE POLICY "ctvr_insert" ON chat_tool_vote_records FOR INSERT TO authenticated
  WITH CHECK (app_user_id() = user_id);
DROP POLICY IF EXISTS "ctvr_delete" ON chat_tool_vote_records;
CREATE POLICY "ctvr_delete" ON chat_tool_vote_records FOR DELETE TO authenticated
  USING (app_user_id() = user_id);

-- chat_tool_chains：仅本人可添加接龙
DROP POLICY IF EXISTS "ctc_insert" ON chat_tool_chains;
CREATE POLICY "ctc_insert" ON chat_tool_chains FOR INSERT TO authenticated
  WITH CHECK (app_user_id() = user_id);
DROP POLICY IF EXISTS "ctc_delete" ON chat_tool_chains;
CREATE POLICY "ctc_delete" ON chat_tool_chains FOR DELETE TO authenticated
  USING (app_user_id() = user_id);

-- Storage：收紧上传权限为已认证用户
DROP POLICY IF EXISTS "Auth upload" ON storage.objects;
CREATE POLICY "Auth upload" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'pages');
DROP POLICY IF EXISTS "Auth delete" ON storage.objects;
CREATE POLICY "Auth delete" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'pages');
DROP POLICY IF EXISTS "Auth update" ON storage.objects;
CREATE POLICY "Auth update" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'pages');

-- ═══════════════════════════════════════════════════════════
-- ===== 31. 安全加固（完整版 · 来源 supabase-security-fix.sql）=====
-- 说明：本段补齐第 30 段之后的全部安全加固内容：开发者白名单 / 敏感列保护 /
--       读侧 RLS 收紧（覆盖第 22 段的开放读） / 写残留收紧 / 服务端门禁 RPC /
--       函数加固。所有 DROP ... IF EXISTS / CREATE OR REPLACE 均可重复执行。
-- ═══════════════════════════════════════════════════════════

-- 31.0 developers 白名单表 + is_channel_public / is_room_* / is_developer
--     辅助判定函数已在 21.x 段前置定义（供下方第 31 段策略与 RPC 使用），此处不再重复。

-- 31.2 敏感列保护（chat_channel_settings 的密码/问卷正确答案 对 anon/authenticated 列级不可读）
REVOKE SELECT (admission_password, admission_questionnaire) ON public.chat_channel_settings FROM anon, authenticated;

-- 31.3 读侧 RLS 收紧（覆盖第 22 段的开放读为最终安全态）
-- chat_rooms：公开频道(channel)游客可见；私聊房间仅 成员/房主/本人
DROP POLICY IF EXISTS "chat_rooms_read" ON chat_rooms;
CREATE POLICY "chat_rooms_read" ON chat_rooms FOR SELECT USING (
  type = 'channel'
  OR created_by = app_user_id()
  OR public.is_room_member(id, app_user_id())
);

-- chat_room_members：公开频道游客可见；私聊房间仅成员/房主
DROP POLICY IF EXISTS "chat_room_members_read" ON chat_room_members;
CREATE POLICY "chat_room_members_read" ON chat_room_members FOR SELECT USING (
  public.is_channel_public(room_id)
  OR public.is_room_creator(room_id, app_user_id())
  OR public.is_room_member(room_id, app_user_id())
);

-- chat_messages：公开频道游客可见；私聊房间仅成员/房主
DROP POLICY IF EXISTS "chat_messages_read" ON chat_messages;
CREATE POLICY "chat_messages_read" ON chat_messages FOR SELECT USING (
  public.is_channel_public(room_id)
  OR public.is_room_creator(room_id, app_user_id())
  OR public.is_room_member(room_id, app_user_id())
);

-- chat_reactions：同上
DROP POLICY IF EXISTS "chat_reactions_read" ON chat_reactions;
CREATE POLICY "chat_reactions_read" ON chat_reactions FOR SELECT USING (
  public.is_channel_public(room_id)
  OR public.is_room_creator(room_id, app_user_id())
  OR public.is_room_member(room_id, app_user_id())
);

-- chat_admins：本人 / 房主 / 管理员
DROP POLICY IF EXISTS "chat_admins_read" ON chat_admins;
CREATE POLICY "chat_admins_read" ON chat_admins FOR SELECT USING (
  user_id = app_user_id()
  OR public.is_room_creator(room_id, app_user_id())
  OR public.is_room_admin(room_id, app_user_id())
);

-- chat_muted：本人 / 房主 / 管理员
DROP POLICY IF EXISTS "chat_muted_read" ON chat_muted;
CREATE POLICY "chat_muted_read" ON chat_muted FOR SELECT USING (
  user_id = app_user_id()
  OR public.is_room_creator(room_id, app_user_id())
  OR public.is_room_admin(room_id, app_user_id())
);

-- chat_banned：本人 / 房主 / 管理员
DROP POLICY IF EXISTS "chat_banned_read" ON chat_banned;
CREATE POLICY "chat_banned_read" ON chat_banned FOR SELECT USING (
  user_id = app_user_id()
  OR public.is_room_creator(room_id, app_user_id())
  OR public.is_room_admin(room_id, app_user_id())
);

-- chat_unread：仅本人
DROP POLICY IF EXISTS "chat_unread_read" ON chat_unread;
CREATE POLICY "chat_unread_read" ON chat_unread FOR SELECT USING (
  app_user_id() = user_id
);

-- channel_invites：仅 房主/管理员（兑换走 redeem_invite RPC）
DROP POLICY IF EXISTS "channel_invites_read" ON channel_invites;
CREATE POLICY "channel_invites_read" ON channel_invites FOR SELECT USING (
  public.is_room_creator(room_id, app_user_id())
  OR public.is_room_admin(room_id, app_user_id())
);

-- channel_join_requests：本人 / 房主 / 管理员
DROP POLICY IF EXISTS "任何人可读取入群申请" ON channel_join_requests;
DROP POLICY IF EXISTS "join_requests_read" ON channel_join_requests;
CREATE POLICY "join_requests_read" ON channel_join_requests FOR SELECT USING (
  user_id = app_user_id()
  OR public.is_room_creator(room_id, app_user_id())
  OR public.is_room_admin(room_id, app_user_id())
);

-- channel_questionnaires（含正确答案）：仅 房主/管理员
DROP POLICY IF EXISTS "channel_questionnaires_read" ON channel_questionnaires;
CREATE POLICY "channel_questionnaires_read" ON channel_questionnaires FOR SELECT USING (
  public.is_room_creator(room_id, app_user_id())
  OR public.is_room_admin(room_id, app_user_id())
);

-- channel_questionnaire_answers：仅 本人(申请人) / 房主 / 管理员
DROP POLICY IF EXISTS "channel_questionnaire_answers_read" ON channel_questionnaire_answers;
CREATE POLICY "channel_questionnaire_answers_read" ON channel_questionnaire_answers FOR SELECT USING (
  EXISTS (SELECT 1 FROM channel_join_requests j WHERE j.id = request_id AND (j.user_id = app_user_id()))
  OR EXISTS (SELECT 1 FROM channel_join_requests j WHERE j.id = request_id AND public.is_room_creator(j.room_id, app_user_id()))
  OR EXISTS (SELECT 1 FROM channel_join_requests j WHERE j.id = request_id AND public.is_room_admin(j.room_id, app_user_id()))
);

-- 31.4 写残留收紧
-- channel_questionnaire_answers：删除 仅 本人(申请人) / 房主 / 管理员
DROP POLICY IF EXISTS "channel_questionnaire_answers_delete" ON channel_questionnaire_answers;
CREATE POLICY "channel_questionnaire_answers_delete" ON channel_questionnaire_answers FOR DELETE USING (
  EXISTS (SELECT 1 FROM channel_join_requests j WHERE j.id = request_id AND (j.user_id = app_user_id()))
  OR EXISTS (SELECT 1 FROM channel_join_requests j WHERE j.id = request_id AND public.is_room_creator(j.room_id, app_user_id()))
  OR EXISTS (SELECT 1 FROM channel_join_requests j WHERE j.id = request_id AND public.is_room_admin(j.room_id, app_user_id()))
);

-- public_channels：仅 开发者白名单 或 频道创建者 可写（读保持公开）；
-- 注：Supabase 无 users 表，开发者身份在 Cloudflare D1，故同时保留频道创建者写权限。
DROP POLICY IF EXISTS "public_channels_insert" ON public_channels;
CREATE POLICY "public_channels_insert" ON public_channels FOR INSERT TO authenticated
WITH CHECK (public.is_developer(app_user_id())
  OR EXISTS (SELECT 1 FROM chat_rooms c WHERE c.id = room_id AND c.created_by = app_user_id()));
DROP POLICY IF EXISTS "public_channels_update" ON public_channels;
CREATE POLICY "public_channels_update" ON public_channels FOR UPDATE TO authenticated
USING (public.is_developer(app_user_id())
  OR EXISTS (SELECT 1 FROM chat_rooms c WHERE c.id = room_id AND c.created_by = app_user_id()));
DROP POLICY IF EXISTS "public_channels_delete" ON public_channels;
CREATE POLICY "public_channels_delete" ON public_channels FOR DELETE TO authenticated
USING (public.is_developer(app_user_id())
  OR EXISTS (SELECT 1 FROM chat_rooms c WHERE c.id = room_id AND c.created_by = app_user_id()));

-- 31.5 服务端门禁 RPC（SECURITY DEFINER + 固定 search_path）
CREATE OR REPLACE FUNCTION public.verify_admission(
  p_room_id text,
  p_password text DEFAULT NULL,
  p_answers jsonb DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_settings chat_channel_settings%ROWTYPE;
  v_mode text;
  v_q jsonb;
  v_a jsonb;
  v_item jsonb;
  v_type text;
  v_correct jsonb;
  v_u jsonb;
  v_ans text;
  v_i int;
  v_j int;
  v_found boolean;
  v_has_password boolean;
  v_c_arr text[];
  v_u_arr text[];
BEGIN
  SELECT * INTO v_settings FROM chat_channel_settings WHERE room_id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', '频道不存在');
  END IF;

  v_mode := COALESCE(NULLIF(v_settings.admission_mode, ''), NULLIF(v_settings.admission, ''), 'open');
  IF v_mode = 'open' THEN
    RETURN jsonb_build_object('ok', true);
  END IF;
  IF v_mode = 'approval' THEN
    RETURN jsonb_build_object('ok', false, 'error', '该频道需申请审批');
  END IF;

  v_has_password := v_settings.admission_password IS NOT NULL AND v_settings.admission_password <> '';

  -- 密码校验（password / composite 模式）
  IF v_mode IN ('password', 'composite') AND v_has_password THEN
    IF p_password IS NULL OR p_password = '' THEN
      RETURN jsonb_build_object('ok', false, 'need_password', true, 'error', '请输入入群密码');
    END IF;
    IF p_password <> v_settings.admission_password THEN
      RETURN jsonb_build_object('ok', false, 'error', '密码错误');
    END IF;
  END IF;

  -- 问卷校验（questionnaire / composite 模式）
  v_q := v_settings.admission_questionnaire::jsonb;
  IF v_mode IN ('questionnaire', 'composite') AND jsonb_typeof(v_q) = 'array' AND jsonb_array_length(v_q) > 0 THEN
    IF p_answers IS NULL OR jsonb_typeof(p_answers) <> 'array' THEN
      RETURN jsonb_build_object('ok', false, 'error', '请完成入群问卷');
    END IF;
    FOR v_i IN 0 .. jsonb_array_length(v_q) - 1 LOOP
      v_item := v_q->v_i;
      v_type := v_item->>'type';
      IF v_type IS NULL OR v_type = 'fill' THEN
        CONTINUE;
      END IF;
      v_found := false;
      v_ans := NULL;
      FOR v_j IN 0 .. jsonb_array_length(p_answers) - 1 LOOP
        IF (p_answers->v_j->>'index')::int = v_i THEN
          v_ans := p_answers->v_j->>'value';
          v_found := true;
          EXIT;
        END IF;
      END LOOP;
      IF NOT v_found THEN
        RETURN jsonb_build_object('ok', false, 'error', '请完成全部题目');
      END IF;
      IF v_type IN ('single', 'choice', 'multiple') THEN
        v_correct := v_item->'correct_answer';
        IF jsonb_typeof(v_correct) <> 'array' THEN
          v_correct := jsonb_build_array(v_correct);
        END IF;
        BEGIN
          v_u := COALESCE(v_ans, '[]')::jsonb;
        EXCEPTION WHEN OTHERS THEN
          v_u := jsonb_build_array(v_ans);
        END;
        IF jsonb_typeof(v_u) <> 'array' THEN
          v_u := jsonb_build_array(v_ans);
        END IF;
        SELECT array_agg(e #>> '{}') INTO v_c_arr FROM jsonb_array_elements(v_correct) e;
        SELECT array_agg(e #>> '{}') INTO v_u_arr FROM jsonb_array_elements(v_u) e;
        IF NOT (v_u_arr <@ v_c_arr AND v_c_arr <@ v_u_arr) THEN
          RETURN jsonb_build_object('ok', false, 'error', '未通过入群测试，请重新作答');
        END IF;
      ELSIF v_type = 'fill_standard' THEN
        IF lower(trim(COALESCE(v_ans, ''))) <> lower(trim(COALESCE(v_item->>'correct_answer', ''))) THEN
          RETURN jsonb_build_object('ok', false, 'error', '未通过入群测试，请重新作答');
        END IF;
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- 5.2 get_admission_questions：返回题目（剥离 correct_answer），供入群问卷渲染
CREATE OR REPLACE FUNCTION public.get_admission_questions(p_room_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_q jsonb;
  v_out jsonb;
  v_item jsonb;
  v_i int;
BEGIN
  SELECT admission_questionnaire::jsonb INTO v_q FROM chat_channel_settings WHERE room_id = p_room_id;
  IF v_q IS NULL OR jsonb_typeof(v_q) <> 'array' THEN
    RETURN '[]'::jsonb;
  END IF;
  v_out := '[]'::jsonb;
  FOR v_i IN 0 .. jsonb_array_length(v_q) - 1 LOOP
    v_item := v_q->v_i;
    v_out := v_out || jsonb_build_object(
      'index', v_i,
      'question', v_item->>'question',
      'type', v_item->>'type',
      'options', COALESCE(v_item->'options', '[]'::jsonb)
    );
  END LOOP;
  RETURN v_out;
END;
$$;

-- get_admission_settings：管理员/房主读取完整设置（含密码/问卷），供准入管理面板
CREATE OR REPLACE FUNCTION public.get_admission_settings(p_room_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid text;
  v_settings chat_channel_settings%ROWTYPE;
BEGIN
  v_uid := app_user_id();
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', '未登录');
  END IF;
  IF NOT (public.is_room_creator(p_room_id, v_uid)
          OR public.is_room_admin(p_room_id, v_uid)
          OR public.is_developer(v_uid)) THEN
    RETURN jsonb_build_object('ok', false, 'error', '无权限');
  END IF;
  SELECT * INTO v_settings FROM chat_channel_settings WHERE room_id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', '设置不存在');
  END IF;
  RETURN jsonb_build_object('ok', true, 'settings', to_jsonb(v_settings));
END;
$$;

-- redeem_invite：服务端原子兑换邀请码（校验 + used_count 原子递增）
CREATE OR REPLACE FUNCTION public.redeem_invite(p_invite_code text, p_room_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_inv channel_invites%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM channel_invites
  WHERE invite_code = p_invite_code AND room_id = p_room_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', '邀请码无效');
  END IF;
  IF v_inv.expires_at IS NOT NULL AND v_inv.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', '邀请码已过期');
  END IF;
  IF v_inv.max_uses > 0 AND v_inv.used_count >= v_inv.max_uses THEN
    RETURN jsonb_build_object('ok', false, 'error', '邀请码已达使用上限');
  END IF;
  UPDATE channel_invites SET used_count = used_count + 1 WHERE id = v_inv.id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_admission(text, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admission_questions(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admission_settings(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_invite(text, text) TO anon, authenticated;

-- 31.6 函数加固
-- sign_auth_jwt：HS256 遗留函数，禁止 anon/authenticated 调用（休眠地雷拆除），固定 search_path
CREATE OR REPLACE FUNCTION public.sign_auth_jwt(p_user_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_secret TEXT;
  v_now BIGINT;
  v_payload JSONB;
  v_header JSONB;
  v_header_b64 TEXT;
  v_payload_b64 TEXT;
  v_signature TEXT;
BEGIN
  BEGIN
    v_secret := current_setting('config.jwt_secret', true);
  EXCEPTION WHEN OTHERS THEN
    v_secret := NULL;
  END;
  IF v_secret IS NULL OR v_secret = '' THEN
    RETURN NULL;
  END IF;
  v_now := EXTRACT(EPOCH FROM NOW())::BIGINT;
  v_header := jsonb_build_object('alg', 'HS256', 'typ', 'JWT');
  v_payload := jsonb_build_object(
    'iss', 'https://qwslopgbfkvnxrkqlvjl.supabase.co/auth/v1/',
    'sub', p_user_id,
    'aud', 'authenticated',
    'exp', v_now + 86400,
    'iat', v_now,
    'role', 'authenticated',
    'aal', 'aal1',
    'session_id', gen_random_uuid()::text,
    'is_anonymous', false
  );
  v_header_b64 := replace(replace(replace(encode(convert_to(v_header::text, 'UTF8'), 'base64'), E'\n', ''), '+', '-'), '/', '_');
  v_header_b64 := regexp_replace(v_header_b64, '=+$', '');
  v_payload_b64 := replace(replace(replace(encode(convert_to(v_payload::text, 'UTF8'), 'base64'), E'\n', ''), '+', '-'), '/', '_');
  v_payload_b64 := regexp_replace(v_payload_b64, '=+$', '');
  v_signature := replace(replace(replace(encode(hmac(v_header_b64 || '.' || v_payload_b64, v_secret, 'sha256'), 'base64'), E'\n', ''), '+', '-'), '/', '_');
  v_signature := regexp_replace(v_signature, '=+$', '');
  RETURN v_header_b64 || '.' || v_payload_b64 || '.' || v_signature;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.sign_auth_jwt(text) FROM anon, authenticated;

-- increment_unread：触发器专用，禁止外部直接调用
REVOKE EXECUTE ON FUNCTION public.increment_unread() FROM anon, authenticated;

-- cleanup_old_chat_messages：固定 search_path
CREATE OR REPLACE FUNCTION public.cleanup_old_chat_messages()
RETURNS TABLE(deleted_messages bigint, deleted_reactions bigint)
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  cutoff_ts bigint;
  msg_count bigint;
  react_count bigint;
BEGIN
  cutoff_ts := (EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days') * 1000)::bigint;
  DELETE FROM chat_reactions
  WHERE NOT EXISTS (
    SELECT 1 FROM chat_messages
    WHERE chat_messages.event_id = chat_reactions.event_id
  );
  GET DIAGNOSTICS react_count = ROW_COUNT;
  DELETE FROM chat_messages
  WHERE ts < cutoff_ts;
  GET DIAGNOSTICS msg_count = ROW_COUNT;
  DELETE FROM chat_reactions
  WHERE NOT EXISTS (
    SELECT 1 FROM chat_messages
    WHERE chat_messages.event_id = chat_reactions.event_id
  );
  RETURN QUERY SELECT msg_count, react_count;
END;
$$;

-- ===== 完成 =====
-- 这个文件是 Supabase 的唯一迁移脚本（单一文件），覆盖：表结构 / 索引 / 外键 / 触发器 /
-- 辅助函数 / 服务端门禁 RPC / 完整 RLS 策略（读+写统一收紧）/ Realtime / Storage / 函数加固。
-- 已完整整合原 supabase-security-fix.sql 与 fix-chat-members-rls.sql 的全部内容。
-- 可无限次重复执行，不会丢数据，不会报错（DROP 均带 IF EXISTS，CREATE 均用 IF NOT EXISTS / OR REPLACE）。
-- 执行：Supabase Dashboard → SQL Editor → New query → 粘贴全部内容 → Run。
-- 开发者白名单初始化（需管理员 SQL 控制台执行）：
--   INSERT INTO public.developers (user_id) VALUES ('<用户ID>');
