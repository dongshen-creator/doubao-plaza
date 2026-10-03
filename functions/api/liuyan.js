// Cloudflare Pages Function - liuyan.coze.site 内容分类聚合（v9.2）
// GET /api/liuyan
// 服务端拉取 https://liuyan.coze.site 的频道分类 + 标签，按站点设置 liuyan_exclude 关键词
// （默认 宠物,娱乐,AI）过滤后返回，绕过浏览器 CORS；边缘缓存 10 分钟（按过滤词分键）。
// 数据源：
//   GET https://liuyan.coze.site/api/system-channel-categories → {success,categories:[{id,name,emoji,color,channels:[...]}]}
//   GET https://liuyan.coze.site/api/channel-tags              → {success,tags:[string]}
// 站点设置 liuyan_enabled=off 时返回 {enabled:false}（前端据 site-settings 决定是否请求）。

const UP_CATEGORIES = 'https://liuyan.coze.site/api/system-channel-categories';
const UP_TAGS = 'https://liuyan.coze.site/api/channel-tags';
const CACHE_PREFIX = 'https://cache.internal/dp-liuyan-aggregate?v=1&x=';
const CACHE_TTL_SEC = 600; // 10 分钟
const FETCH_TIMEOUT_MS = 8000;
const DEFAULT_EXCLUDE = '宠物,娱乐,AI';

// 过滤词解析：支持中英文逗号/顿号/空白分隔
export function parseExclude(str) {
  return String(str == null ? DEFAULT_EXCLUDE : str)
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 命中过滤词（ASCII 词不区分大小写，如 AI/ai）
export function hitKeyword(name, keywords) {
  const n = String(name == null ? '' : name).toLowerCase();
  if (!n) return false;
  return keywords.some((k) => n.includes(String(k).toLowerCase()));
}

// 过滤聚合结果：分类名 / 分类下频道名 / 标签 三层均按关键词剔除
export function filterPayload(categories, tags, keywords) {
  const cats = (Array.isArray(categories) ? categories : [])
    .filter((c) => c && !hitKeyword(c.name, keywords))
    .map((c) => ({
      id: c.id,
      name: c.name,
      emoji: c.emoji || '',
      color: c.color || '',
      channels: (Array.isArray(c.channels) ? c.channels : [])
        .filter((ch) => ch && !hitKeyword(ch.name, keywords))
        .map((ch) => ({ id: ch.id, name: ch.name, avatarUrl: ch.avatarUrl || '' })),
    }));
  const tgs = (Array.isArray(tags) ? tags : [])
    .filter((t) => typeof t === 'string' && !hitKeyword(t, keywords));
  return { categories: cats, tags: tgs };
}

function fetchJson(url, timeoutMs) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  if (ctl && timeoutMs) timer = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, timeoutMs);
  return fetch(url, ctl ? { signal: ctl.signal } : undefined)
    .then((r) => {
      if (timer) clearTimeout(timer);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .catch((e) => {
      if (timer) clearTimeout(timer);
      throw e;
    });
}

async function readSetting(env, key, dflt) {
  if (!env || !env.DB) return dflt;
  try {
    const row = await env.DB.prepare(`SELECT value FROM site_settings WHERE key = ?`).bind(key).first();
    return row && row.value != null ? row.value : dflt;
  } catch (e) {
    return dflt;
  }
}

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const [enabled, excludeRaw] = await Promise.all([
      readSetting(env, 'liuyan_enabled', 'on'),
      readSetting(env, 'liuyan_exclude', DEFAULT_EXCLUDE),
    ]);

    if (enabled !== 'on') {
      return Response.json({
        success: true,
        data: { enabled: false, exclude: [], categories: [], tags: [], fetched_at: 0 },
      });
    }

    const keywords = parseExclude(excludeRaw);
    const cacheUrl = CACHE_PREFIX + encodeURIComponent(keywords.join(','));
    const cacheReq = new Request(cacheUrl, { method: 'GET' });

    // 1) 边缘缓存命中直接返回
    try {
      const hit = await caches.default.match(cacheReq);
      if (hit) {
        const payload = await hit.json();
        return Response.json({ success: true, data: payload }, {
          headers: { 'Cache-Control': 'public, max-age=60' },
        });
      }
    } catch (e) { /* 缓存不可用则继续回源 */ }

    // 2) 并发拉取两个上游接口（8s 超时）
    let catJson, tagJson;
    try {
      [catJson, tagJson] = await Promise.all([
        fetchJson(UP_CATEGORIES, FETCH_TIMEOUT_MS),
        fetchJson(UP_TAGS, FETCH_TIMEOUT_MS),
      ]);
    } catch (e) {
      console.error('[liuyan.js] upstream failed:', e && e.message);
      return Response.json({ success: false, error: '聚合源暂不可用，请稍后重试' }, { status: 502 });
    }
    if (!catJson || catJson.success !== true || !Array.isArray(catJson.categories)) {
      return Response.json({ success: false, error: '聚合源返回数据异常' }, { status: 502 });
    }

    // 3) 关键词过滤
    const filtered = filterPayload(catJson.categories, (tagJson && tagJson.tags) || [], keywords);

    const payload = {
      enabled: true,
      exclude: keywords,
      categories: filtered.categories,
      tags: filtered.tags,
      fetched_at: Date.now(),
    };

    // 4) 写入边缘缓存（失败不影响本次返回）
    try {
      const cachePut = new Response(JSON.stringify(payload), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL_SEC}`,
        },
      });
      context.waitUntil(caches.default.put(cacheReq, cachePut));
    } catch (e) { /* ignore */ }

    return Response.json({ success: true, data: payload }, {
      headers: { 'Cache-Control': 'public, max-age=60' },
    });
  } catch (e) {
    console.error('[liuyan.js]', e);
    return Response.json({ success: false, error: '服务器内部错误' }, { status: 500 });
  }
}
