-- 问卷题目表（重新设计）
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

-- 问卷作答（新增，关联 request）
DROP TABLE IF EXISTS channel_questionnaire_answers;
CREATE TABLE channel_questionnaire_answers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  user_answer JSON,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
