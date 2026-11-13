// Cloudflare Pages Function — 统一服务网关 / 回写入口
// POST /api/sync/import   Header: X-Sync-Token: <SYNC_BRIDGE_TOKEN>
// Body: { records: [{ source, table_name, record_key, payload, updated_at }] }
// OPTIONS 同上（CORS 预检）
//
// 架构约定（V12）：
//   两个前端域名都把回写请求发给本端点，由本端点写入**唯一** D1 实例。
//   为避免污染生产业务表，回写落在专用收件箱表 cloud_sync_inbox：
//   管理员复核后再决定是否落到业务表，避免云端数据反向覆盖真实业务数据。
//   LWW（updated_at 较新者胜）+ 主键幂等，重复推送不会产生重复行。
//   SYNC_BRIDGE_TOKEN 未配置时一律 503 失败关闭，不放开匿名写入。

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Token, X-DP-Client',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store, max-age=0',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

// 长度固定分支 + 全量异或，避免短路比较造成的时间侧信道
function tokenEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const INBOX_DDL = `CREATE TABLE IF NOT EXISTS cloud_sync_inbox (
  source TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT,
  synced_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (source, table_name, record_key)
)`;

const UPSERT_SQL = `INSERT INTO cloud_sync_inbox
  (source, table_name, record_key, payload, updated_at, synced_at)
  VALUES (?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(source, table_name, record_key) DO UPDATE SET
    payload = excluded.payload,
    updated_at = excluded.updated_at,
    synced_at = datetime('now')
  WHERE cloud_sync_inbox.updated_at IS NULL
     OR excluded.updated_at IS NULL
     OR excluded.updated_at > cloud_sync_inbox.updated_at`;

function validRecord(rec) {
  if (!rec || typeof rec !== 'object') return false;
  const source = String(rec.source || '');
  const table = String(rec.table_name || '');
  const key = String(rec.record_key || '');
  return /^[a-z0-9_]{1,40}$/.test(source) &&
    /^[a-z0-9_]{1,60}$/.test(table) &&
    key.length > 0 && key.length <= 128 &&
    rec.payload !== undefined;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const configured = env.SYNC_BRIDGE_TOKEN;
  if (!configured) {
    return json({ success: false, error: '回写通道未启用：请先在 Cloudflare Pages 配置 SYNC_BRIDGE_TOKEN', code: 'BRIDGE_NOT_CONFIGURED' }, 503);
  }
  if (!tokenEqual(request.headers.get('X-Sync-Token'), configured)) {
    return json({ success: false, error: '回写令牌无效', code: 'BRIDGE_UNAUTHORIZED' }, 401);
  }
  if (!env.DB) {
    return json({ success: false, error: 'D1 未绑定', code: 'DB_MISSING' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ success: false, error: '请求体不是合法 JSON' }, 400);
  }
  const records = Array.isArray(body && body.records) ? body.records : [];
  if (records.length === 0) return json({ success: false, error: '没有需要回写的记录' }, 400);
  if (records.length > 200) return json({ success: false, error: '单次最多回写 200 条' }, 400);

  try {
    await env.DB.prepare(INBOX_DDL).run();
  } catch (e) {
    return json({ success: false, error: '收件箱表初始化失败' }, 500);
  }

  let processed = 0, skipped = 0, failed = 0;
  const errors = [];
  for (const rec of records) {
    if (!validRecord(rec)) {
      skipped++;
      if (errors.length < 5) errors.push('记录字段不合法，已跳过');
      continue;
    }
    try {
      await env.DB.prepare(UPSERT_SQL).bind(
        String(rec.source),
        String(rec.table_name),
        String(rec.record_key),
        JSON.stringify(rec.payload).slice(0, 20000),
        rec.updated_at ? String(rec.updated_at).slice(0, 40) : null,
      ).run();
      processed++;
    } catch (e) {
      failed++;
      if (errors.length < 5) errors.push(String(e && e.message ? e.message : '写入失败').slice(0, 120));
    }
  }

  return json({
    success: failed === 0,
    service: 'doubao-plaza-shared',
    target: 'd1:cloud_sync_inbox',
    processed,
    skipped,
    failed,
    errors,
    at: new Date().toISOString(),
  }, failed === 0 ? 200 : 207);
}
