// 书籍模块自举建表（V15.0）
// 无 Cloudflare 凭证也能让应用首次访问时自动建好 books / book_chapters。
// 所有语句均为 CREATE ... IF NOT EXISTS，幂等；模块级标记避免每个请求重复执行 DDL。
// 多个 Worker 实例各自持有标记，但 IF NOT EXISTS 保证并发安全。

let _ensured = false;

const DDL = [
  `CREATE TABLE IF NOT EXISTS books (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_books_status ON books(status)`,
  `CREATE INDEX IF NOT EXISTS idx_books_author ON books(author_id)`,
  `CREATE TABLE IF NOT EXISTS book_chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL,
    chapter_no INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    views INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(book_id, chapter_no)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_book_chapters_book ON book_chapters(book_id, chapter_no)`,
];

export async function ensureBooksSchema(env) {
  if (_ensured || !env || !env.DB) return;
  for (const sql of DDL) {
    await env.DB.prepare(sql).run();
  }
  _ensured = true;
}
