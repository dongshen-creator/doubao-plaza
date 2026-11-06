// Cloudflare Pages Function - freserafim（chocoChat）图床/文件床上传 API
// POST /api/upload/freserafim - 上传文件到 chat.freserafim.com（功能页外链图床）
//
// 鉴权：需 Bearer token（同 picgo/tmpfile 端点）
// 上传方式：multipart FormData（file 字段），服务端转发，浏览器不直连第三方
// 限制：最大 20MB（实测通过），屏蔽 SVG/HTML/可执行等危险类型（对齐 tmpfile.js）
//
// V10.8 背景：picgo.net（API 迁移 301）与 img.nickyam.com（连接失败）先后失效；
//   chocoChat 为站点「功能」页外链的免费图床（聊天附件存储），无官方 API，
//   本端点逆向其网页端上传链路实现服务端直传：
//     ① GET  /zh-CN/                       → 取 CSRF 令牌（meta）与会话 Cookie
//     ② POST /zh-CN/rooms                  → 建存储房 {room:{name,expires_at}}（+30天）
//     ③ POST /zh-CN/rooms/{id}/images      → multipart 字段 image → {url}
//   实测（2026-11-06）：20MB 二进制 5.6s 上传成功；直链 https://chat.freserafim.com/files/{uuid}.{ext}
//   免登录可公开热链、Content-Type 正确、字节一致；房间过期后文件短期仍可访问（长期未验证，
//   前端链保留 tmpfile.link 兜底）。会话与房间按 isolate 缓存复用（7 天），失效自动重建。

import { getAuthUserId } from '../_lib/jwt.js';

const CHOCO_BASE = 'https://chat.freserafim.com';
const MAX_SIZE = 20 * 1024 * 1024; // 20MB
const ROOM_REUSE_MS = 7 * 86400 * 1000; // 存储房复用窗口（远小于 30 天有效期）
const UPSTREAM_TIMEOUT = 60000; // 上游请求超时

// V7 同款危险类型屏蔽（SVG 为 XSS 载体，HTML/XML 可用于钓鱼存储）
const BLOCKED_TYPES = ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml'];
const BLOCKED_EXTS = ['svg', 'html', 'htm', 'xhtml', 'xml', 'js', 'exe', 'bat', 'cmd', 'sh', 'php', 'jsp', 'asp', 'aspx'];

// 无扩展名文件按 MIME 推断扩展名（chocoChat 直链后缀取自文件名，缺后缀影响渲染判定）
const EXT_BY_TYPE = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/webm': 'weba',
};

// V6c 同款：错误返回统一 JSON 风格
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

// ── 存储房会话（isolate 级缓存：一次建房多次复用，失效自动重建）──
let bedSession = null; // { cookie, csrf, roomId, createdAt }

// ① 取会话：首页 Cookie + CSRF 令牌
async function fetchChocoSession() {
  const res = await fetch(CHOCO_BASE + '/zh-CN/', {
    headers: { 'User-Agent': 'doubao-plaza-uploader' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('chocoChat 首页不可达（' + res.status + '）');
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('chocoChat 未返回会话 Cookie');
  const csrf = (await res.text()).match(/csrf-token" content="([^"]+)"/)?.[1];
  if (!csrf) throw new Error('chocoChat 未返回 CSRF 令牌');
  return { cookie, csrf };
}

// ② 建存储房：+30 天有效期，名字固定便于识别
async function createBedRoom(session) {
  const expiresAt = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
  const res = await fetch(CHOCO_BASE + '/zh-CN/rooms', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookie,
      'X-CSRF-Token': session.csrf,
      Origin: CHOCO_BASE,
    },
    body: JSON.stringify({ room: { name: 'doubao-plaza-bed', expires_at: expiresAt } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('chocoChat 建房失败（' + res.status + '）');
  const data = await res.json().catch(() => ({}));
  if (!data.room_id) throw new Error('chocoChat 建房响应无 room_id');
  return data.room_id;
}

async function getBedSession(force = false) {
  if (!force && bedSession && Date.now() - bedSession.createdAt < ROOM_REUSE_MS) {
    return bedSession;
  }
  const session = await fetchChocoSession();
  const roomId = await createBedRoom(session);
  bedSession = { ...session, roomId, createdAt: Date.now() };
  return bedSession;
}

// ③ 上传文件到存储房（房间失效时重建一次再试）
async function uploadToChocoRoom(buffer, contentType, safeName) {
  let session = await getBedSession();
  for (let attempt = 0; attempt < 2; attempt++) {
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: contentType }), safeName);
    const res = await fetch(CHOCO_BASE + '/zh-CN/rooms/' + session.roomId + '/images', {
      method: 'POST',
      headers: {
        Cookie: session.cookie,
        'X-CSRF-Token': session.csrf,
        Origin: CHOCO_BASE,
        Referer: CHOCO_BASE + '/zh-CN/',
      },
      body: form,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.url) return data.url;
      throw new Error('chocoChat 上传响应无 url 字段');
    }
    // 404/403/422 → 存储房已过期或失效：丢弃缓存强制重建，再试一次
    if (attempt === 0 && [403, 404, 422].includes(res.status)) {
      session = await getBedSession(true);
      continue;
    }
    const body = (await res.text()).substring(0, 200);
    throw new Error('chocoChat 上传失败（' + res.status + '）' + (body ? '：' + body : ''));
  }
  throw new Error('chocoChat 上传失败（重试耗尽）');
}

export async function onRequestPost(context) {
  const { env, request } = context;

  // Bearer 鉴权（对齐 picgo/tmpfile 端点）
  if (!env.DB) {
    return json({ success: false, error: '数据库未绑定' }, 500);
  }
  const authUserId = await getAuthUserId(env, request);
  if (!authUserId) {
    return json({ success: false, error: '请先登录' }, 401);
  }

  try {
    // 1. 解析表单
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file) {
      return json({ success: false, error: '请选择要上传的文件' }, 400);
    }

    // 2. 危险类型屏蔽（对齐 tmpfile.js）
    const contentType = (file.type || 'application/octet-stream').toLowerCase();
    const ext = (file.name || '').split('.').pop()?.toLowerCase();
    if (BLOCKED_TYPES.includes(contentType) || (ext && BLOCKED_EXTS.includes(ext))) {
      return json({ success: false, error: '不支持上传此类型文件（SVG/HTML/可执行文件等被禁止）' }, 400);
    }

    // 3. 大小校验
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength === 0) {
      return json({ success: false, error: '文件为空' }, 400);
    }
    if (buffer.byteLength > MAX_SIZE) {
      return json({ success: false, error: '文件大小超过 20MB 限制（freserafim 图床上限）' }, 413);
    }

    // 4. 文件名清洗：仅保留安全字符，无扩展名按 MIME 补全（直链后缀决定前端渲染判定）
    let safeName = (file.name || 'file').replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '').slice(-100) || 'file';
    if (!safeName.includes('.')) {
      safeName += '.' + (EXT_BY_TYPE[contentType] || 'bin');
    }

    // 5. 上传
    const url = await uploadToChocoRoom(buffer, contentType, safeName);
    return json({ success: true, url });
  } catch (e) {
    console.error('[freserafim.js]', e);
    return json({ success: false, error: 'freserafim 上传失败：' + (e.message || '服务器内部错误') }, 502);
  }
}
