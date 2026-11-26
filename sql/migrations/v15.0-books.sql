-- ============================================================
-- V15.0 · 书籍模块迁移脚本（可重复执行）
-- 目标：为已有 D1 生产库新增书籍表与章节表，与小肥羊讲堂文章数据完全独立。
-- 执行方式：Cloudflare Dashboard → D1 → 查询，粘贴执行；或 wrangler d1 execute。
-- ============================================================

-- 一本书 = 一行元数据
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  summary TEXT DEFAULT '',
  cover_image TEXT,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_avatar TEXT,
  author_doubao_id TEXT,
  status TEXT DEFAULT 'published',
  category TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  views INTEGER DEFAULT 0,
  reject_reason TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_books_status ON books(status);
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author_id);

-- 章节：每章一行，按 chapter_no 排序；(book_id, chapter_no) 唯一防重复章号
CREATE TABLE IF NOT EXISTS book_chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  chapter_no INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  views INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(book_id, chapter_no)
);
CREATE INDEX IF NOT EXISTS idx_book_chapters_book ON book_chapters(book_id, chapter_no);
