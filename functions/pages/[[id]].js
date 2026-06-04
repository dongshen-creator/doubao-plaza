// Cloudflare Pages Function - Render Custom Pages
// [[id]].js 捕获 /pages/{id} 以及 /pages/{id}/子路径
// 优先从 R2 读取文件，无 R2 或无文件时回退到 D1 的 html_content

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
  const { env, params } = context;
  const fullPath = params.id || '';
  const parts = fullPath.split('/');
  const pageId = parts[0];
  const filePath = parts.slice(1).join('/') || 'index.html';

  // 1) 尝试从 R2 读取
  if (env.PAGES_BUCKET) {
    try {
      const r2Key = `pages/${pageId}/${filePath}`;
      const obj = await env.PAGES_BUCKET.get(r2Key);
      if (obj) {
        return new Response(obj.body, {
          headers: {
            'Content-Type': obj.httpMetadata?.contentType || getContentType(filePath),
            'Cache-Control': 'public, max-age=86400',
          },
        });
      }
    } catch (_) { /* R2 not available or error */ }
  }

  // 2) 如果是 index.html，回退到 D1
  if (filePath === 'index.html' && env.DB) {
    try {
      const page = await env.DB.prepare(
        `SELECT title, html_content FROM custom_pages WHERE id = ?`
      ).bind(pageId).first();

      if (page) {
        return new Response(page.html_content, {
          headers: { 'Content-Type': 'text/html' },
        });
      }
    } catch (_) { /* DB error */ }
  }

  // 3) 404
  return new Response('<!DOCTYPE html><html><head><title>404</title><meta charset="utf-8"></head><body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif"><div style="text-align:center"><h1>404</h1><p>文件不存在</p><a href="/" style="color:#FF6B35">返回首页</a></div></body></html>', {
    status: 404,
    headers: { 'Content-Type': 'text/html' },
  });
}
