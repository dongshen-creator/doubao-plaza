// Cloudflare Pages Function - Pages File Upload API
// GET    /api/pages/upload?id=xxx        - 列出页面的所有文件
// POST   /api/pages/upload?id=xxx        - 上传文件
// DELETE /api/pages/upload?id=xxx&path=yyy - 删除文件

const DEV_IDS = ['470208447', 'East_pairs'];
async function isDeveloper(env, userId) {
  if (!userId) return false;
  const user = await env.DB.prepare(`SELECT doubao_id FROM users WHERE id = ?`).bind(userId).first();
  return user && DEV_IDS.includes(user.doubao_id);
}

function getContentType(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  const map = {
    'html':'text/html','css':'text/css','js':'application/javascript',
    'json':'application/json','png':'image/png','jpg':'image/jpeg',
    'jpeg':'image/jpeg','gif':'image/gif','webp':'image/webp',
    'svg':'image/svg+xml','ico':'image/x-icon','mp4':'video/mp4',
    'webm':'video/webm','mp3':'audio/mpeg','wav':'audio/wav',
    'pdf':'application/pdf','txt':'text/plain','woff':'font/woff',
    'woff2':'font/woff2','ttf':'font/ttf',
  };
  return map[ext] || 'application/octet-stream';
}

export async function onRequestGet(context) {
  if (!context.env.DB) {
    return Response.json({ success: false, error: '数据库未绑定' });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const pageId = url.searchParams.get('id');
    if (!pageId) return Response.json({ success: false, error: '缺少页面ID' });

    if (!env.PAGES_BUCKET) {
      return Response.json({ success: true, data: [], r2: false });
    }

    const prefix = `pages/${pageId}/`;
    const listed = await env.PAGES_BUCKET.list({ prefix });
    const files = listed.objects.map(o => ({
      path: o.key.replace(prefix, ''),
      size: o.size,
      uploaded: o.uploaded,
    }));

    return Response.json({ success: true, data: files, r2: true });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}

export async function onRequestPost(context) {
  if (!context.env.DB) {
    return Response.json({ success: false, error: '数据库未绑定' });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const pageId = url.searchParams.get('id');
    if (!pageId) return Response.json({ success: false, error: '缺少页面ID' });

    const formData = await context.request.formData();
    const file = formData.get('file');
    const filePath = formData.get('path') || file?.name || 'index.html';
    const userId = formData.get('user_id');

    if (!file) return Response.json({ success: false, error: '请选择文件' });
    if (!await isDeveloper(env, userId)) {
      return Response.json({ success: false, error: '只有开发者才能上传文件' });
    }

    if (!env.PAGES_BUCKET) {
      return Response.json({ success: false, error: 'R2 存储桶未绑定' });
    }

    const buffer = await file.arrayBuffer();
    const key = `pages/${pageId}/${filePath}`;
    await env.PAGES_BUCKET.put(key, buffer, {
      httpMetadata: { contentType: file.type || getContentType(filePath) },
    });

    return Response.json({ success: true, data: { path: filePath, size: buffer.byteLength } });
  } catch (e) {
    return Response.json({ success: false, error: '上传失败：' + e.message });
  }
}

export async function onRequestDelete(context) {
  if (!context.env.DB) {
    return Response.json({ success: false, error: '数据库未绑定' });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const pageId = url.searchParams.get('id');
    const filePath = url.searchParams.get('path');
    const userId = url.searchParams.get('user_id');

    if (!pageId || !filePath) return Response.json({ success: false, error: '缺少页面ID或文件路径' });
    if (!await isDeveloper(env, userId)) {
      return Response.json({ success: false, error: '只有开发者才能删除文件' });
    }

    if (!env.PAGES_BUCKET) {
      return Response.json({ success: false, error: 'R2 存储桶未绑定' });
    }

    await env.PAGES_BUCKET.delete(`pages/${pageId}/${filePath}`);
    return Response.json({ success: true });
  } catch (e) {
    return Response.json({ success: false, error: '删除失败：' + e.message });
  }
}
