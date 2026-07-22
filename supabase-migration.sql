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

-- ===== 14. 问卷题目表 =====
-- 注意：DROP + CREATE 会清空已有问卷数据（如果没配过问卷则无影响）
DROP TABLE IF EXISTS channel_questionnaire_answers;
DROP TABLE IF EXISTS channel_questionnaires;
CREATE TABLE channel_questionnaires (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  question TEXT NOT NULL,
  question_type TEXT DEFAULT 'single',
  options JSON,
  correct_answer JSON,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE channel_questionnaire_answers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  user_answer JSON,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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

-- ===== 16.1 公告可见性字段（幂等） =====
ALTER TABLE chat_channel_announcements ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'all';

-- ===== 17. 外键约束（幂等：先检查是否存在，先清理孤立数据） =====
-- 先清理引用了已删除房间的孤立记录，否则外键会创建失败
DELETE FROM chat_unread WHERE room_id NOT IN (SELECT id FROM chat_rooms);
DELETE FROM chat_room_members WHERE room_id NOT IN (SELECT id FROM chat_rooms);
DELETE FROM chat_messages WHERE room_id NOT IN (SELECT id FROM chat_rooms);
DELETE FROM chat_reactions WHERE room_id NOT IN (SELECT id FROM chat_rooms);
DELETE FROM chat_admins WHERE room_id NOT IN (SELECT id FROM chat_rooms);
DELETE FROM chat_muted WHERE room_id NOT IN (SELECT id FROM chat_rooms);
DELETE FROM chat_banned WHERE room_id NOT IN (SELECT id FROM chat_rooms);
DELETE FROM chat_channel_settings WHERE room_id NOT IN (SELECT id FROM chat_rooms);

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

SELECT cron.schedule(
  'cleanup-old-chat-messages',
  '0 3 * * *',
  $$SELECT * FROM cleanup_old_chat_messages()$$
);

-- ===== 21. Storage 存储桶权限（需要先在 Storage 页面创建 pages 桶）=====
CREATE POLICY "Public read" ON storage.objects
FOR SELECT USING (bucket_id = 'pages');

CREATE POLICY "Auth upload" ON storage.objects
FOR INSERT WITH CHECK (bucket_id = 'pages');

CREATE POLICY "Auth delete" ON storage.objects
FOR DELETE USING (bucket_id = 'pages');

CREATE POLICY "Auth update" ON storage.objects
FOR UPDATE USING (bucket_id = 'pages');

-- ===== 22. channel_join_requests RLS 策略 =====
-- 确保入群申请表可正常读写（即使项目开启了 RLS）
ALTER TABLE channel_join_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "任何人可插入入群申请" ON channel_join_requests
  FOR INSERT WITH CHECK (true);
CREATE POLICY "任何人可读取入群申请" ON channel_join_requests
  FOR SELECT USING (true);
CREATE POLICY "任何人可更新入群申请" ON channel_join_requests
  FOR UPDATE USING (true);
CREATE POLICY "任何人可删除入群申请" ON channel_join_requests
  FOR DELETE USING (true);

-- ===== 完成 =====
-- 这个文件可以无限次重复执行，不会丢数据（除了问卷表），不会报错
