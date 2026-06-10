-- 未读计数触发器：chat_messages INSERT 时自动递增 chat_unread
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
