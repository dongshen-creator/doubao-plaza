-- D1 (SQLite) 过期记录清理脚本
-- 在 Cloudflare D1 Console 中执行
-- 清理过期的禁言、封禁记录和孤立数据

-- 清理过期 mute
DELETE FROM chat_muted WHERE muted_until IS NOT NULL AND muted_until < datetime('now');

-- 清理过期 ban（非永久封禁，48h 后自动解封）
DELETE FROM chat_banned WHERE permanent=0 AND created_at < datetime('now', '-2 days');

-- 清理孤立记录（房间已被删除）
DELETE FROM chat_unread WHERE room_id NOT IN (SELECT id FROM chat_rooms);
DELETE FROM chat_room_members WHERE room_id NOT IN (SELECT id FROM chat_rooms);
DELETE FROM chat_admins WHERE room_id NOT IN (SELECT id FROM chat_rooms);
DELETE FROM chat_muted WHERE room_id NOT IN (SELECT id FROM chat_rooms);
DELETE FROM chat_banned WHERE room_id NOT IN (SELECT id FROM chat_rooms);
DELETE FROM chat_channel_settings WHERE room_id NOT IN (SELECT id FROM chat_rooms);
