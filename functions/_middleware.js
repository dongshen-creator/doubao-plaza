// Cloudflare Pages Function - 全局中间件（V9.0：门禁 + 蜜罐 + 限流 + 隔离检查 + API 安全响应头）
// AUDIT FIX 对照：
//   [6.7] /api/* 响应补齐安全头（Pages 函数不继承 _headers，实测 API 响应 0 个安全头）
//   [6.8] 门禁（无证明 403）+ translate/tts/proxy 按 IP 限流 + 蜜罐假 401
//   [7.1] 与 catch-all 404 JSON 配合（见 functions/api/[[...path]].js，修复未知路径回退 index.html）
// 职责顺序：蜜罐 → 限流 → Bearer 合并查询（隔离/停用/白名单）→ 门禁 → next()
//   1) 蜜罐：/api/admin|debug|env|backup|config|internal（含子路径前缀）→
//      与未登录完全一致的假 401（不暴露蜜罐身份）+ 记录 security_events(kind='honeypot')
//   2) 限流：translate(含 /stream) 30/min、moss/tts 10/min、proxy(/tools/proxy) 60/min，
//      每 IP 60 秒窗口，超限 429 + Retry-After；记 security_events(kind='rate_limited')
//   3) 合并查询：一次取回 会话有效性 + quarantined/deactivated + api_allowed 白名单；
//      隔离/停用命中 → 撤销该账号全部会话 + 与登出完全一致的 401 诱饵（惩罚性隐身）
//   4) 门禁：/api/* 需 X-DP-Client: plaza-v1（三端 head 内联 fetch patch 注入的同源证明）
//      且 Origin 存在时必须等于本请求 origin；Bearer 且 users.api_allowed=1 白名单绕过；
//      豁免 /api/img-proxy（<img> 无法携带自定义头）与 /api/ops/*（运维探针预留）
//   5) 放行后 /api/* 响应统一补安全头（204/304 空体安全；透传 body 保住 SSE 流式）
// 失败策略：DB 故障 → 隔离检查 fail-open（各端点仍有 getAuthUserId 兜底，宁可漏检
//      一次也不让 DB 抖动把全体用户误登出）；门禁 fail-closed（取不到白名单信息
//      即按无证明处理 → 403，不允许 DB 故障放大为绕过门禁）。
// security_events 保留 90 天：每次写入以 1% 概率执行过期清理（waitUntil 非阻塞）。

const GATE_HEADER_NAME = 'X-DP-Client';
const GATE_HEADER_VALUE = 'plaza-v1';

// 蜜罐路径（已对照 functions/api 全清单确认无真实端点撞名；含子路径）
const HONEYPOT_PREFIXES = [
  '/api/admin',
  '/api/debug',
  '/api/env',
  '/api/backup',
  '/api/config',
  '/api/internal',
];

// 限流规则（按族共享计数：/api/translate 与 /api/translate/stream 合用 30/min）
const RATE_RULES = [
  {
    name: 'translate',
    limit: 30,
    match: (p) => p === '/api/translate' || p.startsWith('/api/translate/'),
  },
  {
    name: 'moss-tts',
    limit: 10,
    match: (p) => p === '/api/moss/tts' || p.startsWith('/api/moss/tts/'),
  },
  {
    name: 'proxy',
    limit: 60,
    match: (p) => p === '/api/proxy' || p === '/api/tools/proxy',
  },
];

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAP_MAX = 500;

const EVENT_DEDUPE_TTL_MS = 10 * 60 * 1000; // 同 kind|ip|path 10 分钟内只写一条
const EVENT_DEDUPE_MAX = 500;
const EVENT_INSERT_CAP = 100; // 每 60 秒全局最多 100 条写入（防未知路径探测刷爆 D1）
const EVENT_RETENTION_DAYS = 90;

// 限流窗口：key = 规则名|ip -> { count, resetAt }
const rateWindows = new Map();
// 安全事件去重：key = kind|ip|path -> 上次写入时间戳
const eventDedupe = new Map();
let eventInsertCount = 0;
let eventInsertWindowStart = Date.now();

function isApiPath(path) {
  return path === '/api' || path.startsWith('/api/');
}

function isHoneypot(path) {
  return HONEYPOT_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

function isGateExempt(path) {
  // <img> 元素无法携带自定义请求头；/api/ops/* 为运维探针预留
  return path === '/api/img-proxy' || path === '/api/ops' || path.startsWith('/api/ops/');
}

function matchRateRule(path) {
  for (const rule of RATE_RULES) {
    if (rule.match(path)) return rule;
  }
  return null;
}

// 返回 { blocked, retryAfter? }；窗口过期自动重开，Map 过大整体清空（内存保护）
function checkRateLimit(key, limit, now) {
  let win = rateWindows.get(key);
  if (!win || now >= win.resetAt) {
    if (rateWindows.size >= RATE_MAP_MAX) rateWindows.clear();
    win = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateWindows.set(key, win);
  }
  win.count += 1;
  if (win.count <= limit) return { blocked: false };
  return { blocked: true, retryAfter: Math.max(1, Math.ceil((win.resetAt - now) / 1000)) };
}

function applyApiSecurityHeaders(headers) {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (!headers.has('Content-Security-Policy')) {
    // API 响应为 JSON/媒体数据，不需要执行资源；直接导航到 API 也不提供注入面
    headers.set(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'self'; base-uri 'none'"
    );
  }
  return headers;
}

function wrapApiResponse(res) {
  const headers = applyApiSecurityHeaders(new Headers(res.headers));
  // 透传 body（保住 SSE/流式）；204/304 的 body 为 null，构造安全
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function jsonError(status, obj, extraHeaders) {
  const headers = applyApiSecurityHeaders(new Headers(extraHeaders));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(obj), { status, headers });
}

// 写 security_events：去重 Map + 全局写入限速 + 1% 概率顺带清理 90 天前旧行
function logSecurityEvent(context, env, kind, ip, path, userId, detail) {
  if (!env.DB) return;
  const now = Date.now();
  const dedupeKey = kind + '|' + (ip || '') + '|' + (path || '');
  const last = eventDedupe.get(dedupeKey);
  if (last && now - last < EVENT_DEDUPE_TTL_MS) return;
  if (eventDedupe.size >= EVENT_DEDUPE_MAX) {
    for (const [k, ts] of eventDedupe) {
      if (now - ts >= EVENT_DEDUPE_TTL_MS) eventDedupe.delete(k);
    }
    if (eventDedupe.size >= EVENT_DEDUPE_MAX) eventDedupe.clear();
  }
  eventDedupe.set(dedupeKey, now);

  if (now - eventInsertWindowStart >= RATE_WINDOW_MS) {
    eventInsertWindowStart = now;
    eventInsertCount = 0;
  }
  if (eventInsertCount >= EVENT_INSERT_CAP) return;
  eventInsertCount += 1;

  const insert = env.DB.prepare(
    'INSERT INTO security_events (kind, ip, path, user_id, detail) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(kind, ip || null, path || null, userId || null, detail || null)
    .run()
    .then(() => {
      if (Math.random() < 0.01) {
        return env.DB.prepare(
          "DELETE FROM security_events WHERE created_at < datetime('now', '-" +
            EVENT_RETENTION_DAYS +
            " days')"
        ).run();
      }
    })
    .catch((e) => {
      console.error('[MIDDLEWARE] security_events insert failed:', e.message);
    });
  context.waitUntil(insert);
}

function uaSnippet(request) {
  const ua = request.headers.get('User-Agent') || '';
  return ua ? 'ua:' + ua.slice(0, 100) : null;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const api = isApiPath(path);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const now = Date.now();

  // ---- 1) 蜜罐：假 401（与普通未登录口径完全一致），不进入限流/门禁 ----
  if (api && isHoneypot(path)) {
    logSecurityEvent(context, env, 'honeypot', ip, path, null, uaSnippet(request));
    return jsonError(401, { success: false, error: '请先登录' });
  }

  // ---- 2) 限流（按 IP + 规则族共享计数）----
  if (api) {
    const rule = matchRateRule(path);
    if (rule) {
      const rl = checkRateLimit(rule.name + '|' + ip, rule.limit, now);
      if (rl.blocked) {
        logSecurityEvent(
          context,
          env,
          'rate_limited',
          ip,
          path,
          null,
          rule.name + ' ' + rule.limit + '/60s'
        );
        return jsonError(
          429,
          { success: false, error: '请求过于频繁，请稍后再试' },
          { 'Retry-After': String(rl.retryAfter) }
        );
      }
    }
  }

  // ---- 3) Bearer 合并查询：会话 + 隔离/停用 + 白名单 ----
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  let uid = null;
  let apiAllowed = false;
  if (token && env.DB) {
    try {
      const row = await env.DB.prepare(
        `SELECT s.user_id AS uid, u.quarantined_at AS q, u.deactivated_at AS d, u.api_allowed AS a
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > datetime('now')`
      )
        .bind(token)
        .first();

      if (row) {
        uid = row.uid;
        if (row.q || row.d) {
          // 惩罚性隐身：撤销该账号全部会话（含其他设备），旧 token 立即失效
          await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.uid).run();
          logSecurityEvent(
            context,
            env,
            'quarantine_401',
            ip,
            path,
            row.uid,
            row.q ? 'quarantined' : 'deactivated'
          );
          return jsonError(401, { success: false, error: '请先登录' });
        }
        apiAllowed = row.a === 1 || row.a === '1';
      }
    } catch (e) {
      // fail-open：DB 抖动不误登出；门禁阶段拿不到白名单信息会按 fail-closed 处理
      console.error('[MIDDLEWARE] quarantine check failed:', e.message);
    }
  }

  // ---- 4) 门禁：同源证明（白名单 Bearer 绕过）----
  if (api && !apiAllowed && !isGateExempt(path)) {
    const clientTag = request.headers.get(GATE_HEADER_NAME);
    const origin = request.headers.get('Origin');
    const originOk = !origin || origin === url.origin;
    if (clientTag !== GATE_HEADER_VALUE || !originOk) {
      logSecurityEvent(
        context,
        env,
        'gate_403',
        ip,
        path,
        uid,
        clientTag !== GATE_HEADER_VALUE
          ? 'missing-' + GATE_HEADER_NAME
          : 'origin-mismatch:' + origin
      );
      return jsonError(403, { success: false, error: '请求未通过来源校验' });
    }
  }

  // ---- 5) 放行：/api/* 响应统一补齐安全头 ----
  const res = await context.next();
  return api ? wrapApiResponse(res) : res;
}
