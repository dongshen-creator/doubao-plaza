-- ============================================================================
-- 逗包用户广场 · 私聊成员 RLS 修复脚本（2026-08-09 · V5.2）
-- 用途：修复「即时私聊消息无法传送到对方 / 刷新读不到私聊记录」
--
-- 问题根因：
--   前端 openPrivateChatInFriends 创建私聊房间时，一次性插入两名成员
--   （[{user_id: 我}, {user_id: 对方}]）。但 chat_room_members_insert 策略
--   仅允许 app_user_id() = user_id（只允许给自己建成员记录）。
--   PostgREST 多行插入原子回滚 → 私聊房间一条成员记录都没有 → 消息插入
--   （需成员身份）失败、消息读取（需成员身份）失败，对方收不到、刷新读不到。
--   同时，审批通过加人（approveJoinRequest 以管理员身份插入申请人成员）也失败。
--
-- 修复：允许 本人 / 房间创建者 / 频道管理员 插入成员记录。
--
-- 幂等：DROP ... IF EXISTS + CREATE POLICY，可重复执行。
-- 注意：本文件只改成员写入策略，无需重跑 supabase-migration.sql（避免问卷表被重置）。
-- ============================================================================

DROP POLICY IF EXISTS "chat_room_members_insert" ON chat_room_members;
CREATE POLICY "chat_room_members_insert" ON chat_room_members FOR INSERT TO authenticated
  WITH CHECK (
    app_user_id() = user_id
    OR EXISTS (SELECT 1 FROM chat_rooms WHERE id = chat_room_members.room_id AND created_by = app_user_id())
    OR EXISTS (SELECT 1 FROM chat_admins WHERE room_id = chat_room_members.room_id AND user_id = app_user_id())
  );

-- ============================================================================
-- 完成。在 Supabase Dashboard → SQL Editor → New query 中粘贴执行即可。
-- 生产方式说明：每次在 SQL 控制台执行后，前端无需改动即可恢复私聊发送/刷新。
-- ============================================================================