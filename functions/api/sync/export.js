// Cloudflare Pages Function — 统一服务网关 / 增量导出端
// GET /api/sync/export?since=<ISO|SQLite datetime>&sources=d1,supabase&tables=<name,...>&limit=<1..200>
// OPTIONS 同上（CORS 预检）
//
// 架构约定（V12）：
//   doubao-plaza.pages.dev 的 D1 + Supabase 是**唯一事实来源**。
//   WorkBuddy 发布域与本站两个前端共用这一组 API，不各自维护一份业务数据。
//   本端点只做「公开字段投影 + 增量导出」，绝不写出密码/令牌/密保/IP/设备指纹/私信内容。
//   表级白名单硬编码，任何用户输入都不参与 SQL 拼接；时间参数一律绑定传参。

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Token',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store, max-age=0',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

// D1 投影白名单：cols / extra 均为硬编码常量，不接收客户端 SQL 片段
const D1_PROJECTIONS = {
  users: {
    table: 'users',
    cols: 'id, name, avatar, bio, doubao_id, privacy_setting, created_at, updated_at',
    timeExpr: 'COALESCE(updated_at, created_at)',
    extra: "privacy_setting = 'searchable'",   // 隐身/白名单/处罚账号不进入共享镜像
  },
  announcements: {
    table: 'announcements',
    cols: 'id, title, content, is_system, created_at, updated_at',
    timeExpr: 'COALESCE(updated_at, created_at)',
    extra: '',
  },
  features: {
    table: 'features',
    cols: 'id, title, icon_url, link_url, sort_order, created_at, updated_at',
    timeExpr: 'COALESCE(updated_at, created_at)',
    extra: '',
  },
  blog_posts: {
    table: 'blog_posts',
    cols: 'id, title, summary, cover_image, tags, author_id, author_name, author_avatar, status, category_id, created_at, updated_at',
    timeExpr: 'COALESCE(updated_at, created_at)',
    extra: "status = 'published'",
  },
  site_settings: {
    table: 'site_settings',
    cols: 'key, value, updated_at',
    timeExpr: 'updated_at',
    extra: '',
  },
};

// Supabase 投影白名单：仅公开频道元数据 / 公告 / 工具，绝不包含 chat_messages 私信
const SB_PROJECTIONS = {
  public_channels: { key: 'id', timeCol: 'created_at' },
  chat_channel_announcements: { key: 'id', timeCol: 'created_at' },
  chat_channel_tools: { key: 'id', timeCol: 'created_at' },
};

const ALLOWED_SOURCES = new Set(['d1', 'supabase']);

function parseList(value, allowed) {
  if (!value) return Object.keys(allowed);
  const picked = String(value).split(',').map((s) => s.trim()).filter((s) => Object.prototype.hasOwnProperty.call(allowed, s));
  return picked.length ? picked : Object.keys(allowed);
}

// 客户端水位可能是 ISO（云库返回）或 SQLite datetime（D1 返回），统一成两种格式
function toSqliteSince(since) {
  if (!since) return '';
  const s = String(since).trim().slice(0, 40);
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(s)) return '';
  return s.replace('T', ' ').replace(/\.\d+/, '').replace(/Z$/, '').slice(0, 19);
}
function toIsoSince(since) {
  if (!since) return '';
  const s = String(since).trim().slice(0, 40);
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(s)) return '';
  const iso = s.replace(' ', 'T');
  return /Z$|[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z';
}
function safeMessage(prefix, e) {
  const raw = e && e.message ? String(e.message) : 'unknown';
  return prefix + '：' + raw.replace(/[\r\n]+/g, ' ').slice(0, 120);
}

async function readD1(env, tables, since, limit) {
  const result = { status: 'ok', tables: {}, error: '' };
  const out = [];
  if (!env.DB) {
    result.status = 'degraded';
    result.error = 'D1 未绑定';
    return { result, out };
  }
  const sqliteSince = toSqliteSince(since);
  for (const name of tables) {
    const p = D1_PROJECTIONS[name];
    const where = [];
    const params = [];
    if (p.extra) where.push(p.extra);
    if (sqliteSince) {
      where.push(`${p.timeExpr} > ?`);
      params.push(sqliteSince);
    }
    const sql = `SELECT ${p.cols}, ${p.timeExpr} AS _sync_time FROM ${p.table}` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY ${p.timeExpr} ASC LIMIT ?`;
    params.push(limit);
    try {
      const rs = await env.DB.prepare(sql).bind(...params).all();
      const rows = (rs && rs.results) || [];
      result.tables[name] = rows.length;
      for (const row of rows) {
        const { _sync_time, ...payload } = row;
        out.push({
          source: 'd1',
          table_name: name,
          record_key: String(payload[p.table === 'site_settings' ? 'key' : 'id']),
          payload,
          updated_at: _sync_time || null,
        });
      }
    } catch (e) {
      result.status = 'degraded';
      result.tables[name] = 0;
      result.error = safeMessage(`D1 ${name} 读取失败`, e);
    }
  }
  return { result, out };
}

async function readSupabase(env, tables, since, limit) {
  const result = { status: 'ok', tables: {}, error: '' };
  const out = [];
  const base = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  if (!base || !key) {
    result.status = 'degraded';
    result.error = 'Supabase 凭据未配置';
    return { result, out };
  }
  const isoSince = toIsoSince(since);
  for (const name of tables) {
    const p = SB_PROJECTIONS[name];
    try {
      const url = new URL(`${base}/rest/v1/${name}`);
      url.searchParams.set('select', '*');
      url.searchParams.set('order', `${p.timeCol}.asc`);
      url.searchParams.set('limit', String(limit));
      if (isoSince) url.searchParams.set(p.timeCol, `gt.${isoSince}`);
      const res = await fetch(url.toString(), {
        headers: {
          'apikey': key,
          'Authorization': 'Bearer ' + key,
          'Accept': 'application/json',
        },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rows = await res.json();
      const list = Array.isArray(rows) ? rows : [];
      result.tables[name] = list.length;
      for (const row of list) {
        out.push({
          source: 'supabase',
          table_name: name,
          record_key: String(row[p.key]),
          payload: row,
          updated_at: row[p.timeCol] || row.updated_at || null,
        });
      }
    } catch (e) {
      result.status = 'degraded';
      result.tables[name] = 0;
      result.error = safeMessage(`Supabase ${name} 读取失败（可能被 RLS 拒绝）`, e);
    }
  }
  return { result, out };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '100', 10) || 100));
  const since = url.searchParams.get('since') || '';
  const sources = (url.searchParams.get('sources') || 'd1,supabase')
    .split(',').map((s) => s.trim()).filter((s) => ALLOWED_SOURCES.has(s));
  const wanted = new Set(sources.length ? sources : ['d1', 'supabase']);

  const d1Tables = parseList(url.searchParams.get('tables'), D1_PROJECTIONS);
  const sbTables = parseList(url.searchParams.get('tables'), SB_PROJECTIONS);

  const report = {};
  let records = [];
  if (wanted.has('d1')) {
    const r = await readD1(env, d1Tables, since, limit);
    report.d1 = r.result;
    records = records.concat(r.out);
  }
  if (wanted.has('supabase')) {
    const r = await readSupabase(env, sbTables, since, limit);
    report.supabase = r.result;
    records = records.concat(r.out);
  }

  // 水位取本批最大时间；无数据时沿用请求水位，保证幂等且不回退
  let watermark = since || '';
  for (const rec of records) {
    if (rec.updated_at && String(rec.updated_at) > String(watermark)) watermark = String(rec.updated_at);
  }
  const truncated = records.length >= limit * Math.max(1, d1Tables.length + sbTables.length);

  return json({
    success: true,
    service: 'doubao-plaza-shared',
    generated_at: new Date().toISOString(),
    sources: report,
    records,
    count: records.length,
    watermark,
    truncated,
    // 明确告诉调用方：这是增量快照，删除不会传播；冲突以来源侧为准
    policy: { source_of_truth: 'cf-d1 + supabase', conflict: 'source-wins', deletes: 'not-propagated' },
  });
}
