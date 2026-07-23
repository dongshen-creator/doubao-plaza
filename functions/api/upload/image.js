// Cloudflare Pages Function - 聊天文件/图片上传 API
// POST /api/upload/image - 上传文件到 R2，供聊天/频道等场景使用
//
// 鉴权：任意已登录用户（需 user_id 参数，会校验用户是否存在）
// 存储：R2 (env.PAGES_BUCKET)，路径 chat-assets/{userId}/{timestamp}-{filename}
// 限制：单文件 20MB，支持所有文件类型

const MAX_SIZE = 20 * 1024 * 1024; // 20MB
// 图片类型用于推断 contentType
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/x-icon'];
// 常见文件类型扩展名映射
const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  pdf: 'application/pdf', zip: 'application/zip', rar: 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed', tar: 'application/x-tar', gz: 'application/gzip',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', xml: 'application/xml',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  js: 'text/javascript', ts: 'text/typescript', py: 'text/x-python', java: 'text/x-java',
  c: 'text/x-c', cpp: 'text/x-c++', h: 'text/x-c', hpp: 'text/x-c++',
  cs: 'text/x-csharp', go: 'text/x-go', rs: 'text/x-rust', rb: 'text/x-ruby',
  html: 'text/html', css: 'text/css', sql: 'application/sql',
  apk: 'application/vnd.android.package-archive', exe: 'application/x-msdownload',
  dmg: 'application/x-apple-diskimage', deb: 'application/x-debian-package',
};

// 统一的 CORS 响应头
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// 带 CORS 头的 JSON 响应
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
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

// 从文件名中提取安全文件名（去除目录部分，防止路径穿越）
function safeFilename(name) {
  if (!name) return 'file';
  const base = String(name).split(/[/\\]/).pop() || 'file';
  // 仅保留字母、数字、点、下划线、连字符及中文等常见字符
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 100);
  return cleaned || 'file';
}

// 校验用户是否存在（已登录）
async function isValidUser(env, userId) {
  if (!userId) return false;
  try {
    const user = await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(userId).first();
    return !!user;
  } catch (e) {
    return false;
  }
}

// OPTIONS 预检
export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders() });
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
    // 3. 解析表单与参数（user_id 兼容 form 字段与 query 参数）
    const url = new URL(request.url);
    const formData = await request.formData();
    const file = formData.get('file');
    const userId = formData.get('user_id') || url.searchParams.get('user_id');

    if (!userId) {
      return json({ success: false, error: '缺少 user_id 参数' }, 400);
    }
    if (!file) {
      return json({ success: false, error: '请选择要上传的图片' }, 400);
    }

    // 4. 校验用户登录状态
    if (!(await isValidUser(env, userId))) {
      return json({ success: false, error: '用户不存在或未登录，请先登录' }, 401);
    }

    // 5. 推断文件类型（不再限制类型）
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
    const key = `chat-assets/${userId}/${timestamp}-${finalName}`;

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
