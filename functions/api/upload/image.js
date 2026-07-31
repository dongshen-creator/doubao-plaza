// Cloudflare Pages Function - 聊天文件/图片上传 API
// POST /api/upload/image - 上传文件到 R2，供聊天/频道等场景使用
//
// 鉴权：需 Bearer token（V7 修复），user_id 从 token 中提取而非客户端自填
// 存储：R2 (env.PAGES_BUCKET)，路径 chat-assets/{userId}/{timestamp}-{filename}
// 限制：单文件 20MB，屏蔽危险类型（SVG/HTML/可执行文件等）

import { getAuthUserId } from '../_lib/jwt.js';

const MAX_SIZE = 20 * 1024 * 1024; // 20MB
// 图片类型用于推断 contentType
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon'];
// V7 修复：屏蔽危险文件类型（可导致 XSS 或恶意执行）
const BLOCKED_TYPES = ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml'];
const BLOCKED_EXTS = ['svg', 'html', 'htm', 'xhtml', 'xml', 'js', 'exe', 'bat', 'cmd', 'sh', 'php', 'jsp', 'asp', 'aspx'];
// 常见文件类型扩展名映射
const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon',
  pdf: 'application/pdf', zip: 'application/zip', rar: 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed', tar: 'application/x-tar', gz: 'application/gzip',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  apk: 'application/vnd.android.package-archive',
  dmg: 'application/x-apple-diskimage', deb: 'application/x-debian-package',
};

// V6c 修复：收紧 CORS（仅同源请求，不返回 Access-Control-Allow-Origin: *）
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// 解析并推断文件类型
function resolveContentType(file) {
  const ct = (file.type || '').toLowerCase();
  if (ct) return ct;
  // MIME 缺失时按扩展名推断
  const ext = (file.name || '').split('.').pop()?.toLowerCase();
  if (ext && EXT_MIME[ext]) return EXT_MIME[ext];
  return 'application/octet-stream'; // 默认类型
}

// V7 修复：检查文件类型是否危险
function isBlockedFile(file) {
  const ct = (file.type || '').toLowerCase();
  const ext = (file.name || '').split('.').pop()?.toLowerCase();
  if (BLOCKED_TYPES.includes(ct)) return true;
  if (ext && BLOCKED_EXTS.includes(ext)) return true;
  return false;
}

// 从文件名中提取安全文件名（去除目录部分，防止路径穿越）
function safeFilename(name) {
  if (!name) return 'file';
  const base = String(name).split(/[/\\]/).pop() || 'file';
  // 仅保留字母、数字、点、下划线、连字符及中文等常见字符
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 100);
  return cleaned || 'file';
}

// OPTIONS 预检（同源请求不需要 CORS 头）
export async function onRequestOptions(context) {
  return new Response(null, { status: 204 });
}

// POST 上传图片
export async function onRequestPost(context) {
  const { env, request } = context;

  // 1. 校验数据库绑定
  if (!env.DB) {
    return json({ success: false, error: '数据库未绑定' }, 500);
  }

  // 2. 校验 R2 绑定
  if (!env.PAGES_BUCKET) {
    return json({ success: false, error: 'R2 存储桶未绑定（PAGES_BUCKET 缺失），请联系管理员在 Pages 设置中配置 R2 绑定' }, 500);
  }

  try {
    // V7 修复：Token 鉴权 - 从 Authorization 头获取用户身份，而非客户端自填 user_id
    const authUserId = await getAuthUserId(env, request);
    if (!authUserId) {
      return json({ success: false, error: '请先登录' }, 401);
    }

    // 3. 解析表单
    const url = new URL(request.url);
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file) {
      return json({ success: false, error: '请选择要上传的图片' }, 400);
    }

    // 4. V7 修复：屏蔽危险文件类型
    if (isBlockedFile(file)) {
      return json({ success: false, error: '不支持上传此类型文件（SVG/HTML/可执行文件等被禁止）' }, 400);
    }

    // 5. 推断文件类型
    const contentType = resolveContentType(file);

    // 6. 读取并校验文件大小
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength === 0) {
      return json({ success: false, error: '文件为空' }, 400);
    }
    if (buffer.byteLength > MAX_SIZE) {
      return json({ success: false, error: '文件大小超过 20MB 限制' }, 413);
    }

    // 7. 生成 R2 存储键：chat-assets/{userId}/{timestamp}-{filename}
    const timestamp = Date.now();
    const filename = safeFilename(file.name);
    const ext = (file.name || '').split('.').pop()?.toLowerCase();
    const finalName = ext && filename.includes('.')
      ? filename
      : `${filename}.bin`;
    const key = `chat-assets/${authUserId}/${timestamp}-${finalName}`;

    // 8. 上传到 R2
    await env.PAGES_BUCKET.put(key, buffer, {
      httpMetadata: { contentType },
    });

    // 9. 构造访问 URL（域名取自请求 Host，兼容 pages.dev 与自定义域名）
    const domain = url.host;
    const accessUrl = `https://${domain}/cdn-assets/${key}`;

    return json({ success: true, url: accessUrl });
  } catch (e) {
    return json({ success: false, error: '上传失败：' + (e.message || '未知错误') }, 500);
  }
}
