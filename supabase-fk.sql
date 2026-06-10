-- 补充外键约束 — 让 PostgREST 能解析表间关联
ALTER TABLE chat_room_members ADD CONSTRAINT fk_crm_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id);
ALTER TABLE chat_messages ADD CONSTRAINT fk_cmsg_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id);
ALTER TABLE chat_reactions ADD CONSTRAINT fk_crxn_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id);
ALTER TABLE chat_admins ADD CONSTRAINT fk_cadm_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id);
ALTER TABLE chat_muted ADD CONSTRAINT fk_cmut_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id);
ALTER TABLE chat_banned ADD CONSTRAINT fk_cban_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id);
ALTER TABLE chat_channel_settings ADD CONSTRAINT fk_ccs_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id);
ALTER TABLE chat_unread ADD CONSTRAINT fk_curd_room FOREIGN KEY (room_id) REFERENCES chat_rooms(id);
