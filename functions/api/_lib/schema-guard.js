// V10.4 运行时索引自愈（D1 免费版日读配额耗尽事故修复，详见 CHANGELOG v10.4）
// 背景：热路径查询（好友列表 OR 条件、黑名单列表、博客列表、用户可发现列表）因目标表
//      无索引持续全表扫描，烧穿 D1 免费版每日行读配额 → 全站列表查询 500。
// 策略：_middleware.js 顶部 waitUntil 非阻塞调用（零请求延迟）；CREATE INDEX IF NOT EXISTS 幂等；
//      每隔离体成功即置 done 永不重跑；失败（常见为配额耗尽导致建索引读表失败）
//      冷却 5 分钟自动重试 → 跨 UTC 午夜配额重置后自愈，无需人工干预。
//      逐条执行 + 单条捕获：单条失败不阻断其余；已成功条目重试时 IF NOT EXISTS 直接过。
// V10.5：修正 blocked_users 索引命名对齐 schema.sql（防同列双索引）+ 追加 idx_reports_reporter（举报链路）。

const INDEX_STATEMENTS = [
  // friendships：好友页 WHERE (user_id=? OR friend_id=?) —— 事故头号烧配额点（原零索引）
  'CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id)',
  // blocked_users：黑名单列表 WHERE user_id=? JOIN users（原零索引）
  // V10.5 命名对齐 schema.sql 的 idx_blocked_user/idx_blocked_target——原名 idx_blocked_users_*
  // 与 schema.sql 已有索引不同名，配额恢复后会建出同列重复索引
  'CREATE INDEX IF NOT EXISTS idx_blocked_user ON blocked_users(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_blocked_target ON blocked_users(blocked_user_id)',
  // blog_posts：讲堂列表 ORDER BY bp.created_at DESC（原零索引）
  'CREATE INDEX IF NOT EXISTS idx_blog_posts_created ON blog_posts(created_at)',
  // users：可发现列表/搜索 ORDER BY created_at DESC LIMIT 500（原仅有 name_norm 等点查索引）
  'CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at)',
  // V10.5：举报提交链路 3 条 reporter_id+时间窗查询（rate/dup/惩罚判定，原全表扫）
  'CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id, created_at)'
];

// 模块级状态（每隔离体一份）：idle→running→done；失败回 idle + 冷却截止时间
let running = false;
let done = false;
let nextRetryAt = 0;
const RETRY_COOLDOWN_MS = 5 * 60 * 1000;

export async function ensureIndexes(db) {
  if (!db || done || running) return;
  if (Date.now() < nextRetryAt) return;
  running = true;
  try {
    let failed = 0;
    for (const sql of INDEX_STATEMENTS) {
      try {
        await db.prepare(sql).run();
      } catch (e) {
        failed++;
        console.warn('[schema-guard] index failed:', String((e && e.message) || e));
      }
    }
    if (failed === 0) {
      done = true;
      console.warn('[schema-guard] all runtime indexes ensured');
    } else {
      // 常见为 D1 日读配额耗尽（建索引需读整表）→ 冷却后自动重试
      nextRetryAt = Date.now() + RETRY_COOLDOWN_MS;
    }
  } finally {
    running = false;
  }
}
