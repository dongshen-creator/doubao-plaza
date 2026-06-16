-- 清理48小时前的聊天记录相关过期数据
-- chat_reactions 表（如果有）的清理在 backend handleCleanupMessages 中处理

-- 清理过期 mute
DELETE FROM chat_muted WHERE muted_until IS NOT NULL AND muted_until < datetime('now');

-- 清理过期 ban（非永久封禁，48h 后自动解封）
DELETE FROM chat_banned WHERE permanent=0 AND created_at < datetime('now', '-2 days');

-- 清理孤立 unread 记录（房间已被删除）
DELETE FROM chat_unread WHERE room_id NOT IN (SELECT id FROM chat_rooms);

-- 清理孤立 room_members（房间已被删除）
DELETE FROM chat_room_members WHERE room_id NOT IN (SELECT id FROM chat_rooms);

-- 清理孤立 admins（房间已被删除）
DELETE FROM chat_admins WHERE room_id NOT IN (SELECT id FROM chat_rooms);

-- 清理孤立 muted（房间已被删除）
DELETE FROM chat_muted WHERE room_id NOT IN (SELECT id FROM chat_rooms);

-- 清理孤立 banned（房间已被删除）
DELETE FROM chat_banned WHERE room_id NOT IN (SELECT id FROM chat_rooms);

-- 清理孤立 channel_settings（房间已被删除）
DELETE FROM chat_channel_settings WHERE room_id NOT IN (SELECT id FROM chat_rooms);
