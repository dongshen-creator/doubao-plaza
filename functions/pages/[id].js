// Cloudflare Pages Function - Render Custom Page
// GET /pages/[id] - 渲染自定义页面

export async function onRequestGet(context) {
  if (!context.env.DB) {
    return new Response('数据库未绑定', { status: 500 });
  }

  try {
    const { env } = context;
    const pageId = context.params.id;

    const page = await env.DB.prepare(
      `SELECT title, html_content FROM custom_pages WHERE id = ?`
    ).bind(pageId).first();

    if (!page) {
      return new Response(`
<!DOCTYPE html>
<html>
<head><title>页面不存在</title></head>
<body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif">
  <div style="text-align:center">
    <h1>404</h1>
    <p>页面不存在或已被删除</p>
    <a href="/" style="color:#FF6B35">返回首页</a>
  </div>
</body>
</html>
      `, { status: 404, headers: { 'Content-Type': 'text/html' } });
    }

    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(page.title)} - 逗包用户广场</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
      background: #f5f5f5;
      min-height: 100vh;
    }
    .page-container {
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
    }
    .page-header {
      background: linear-gradient(135deg, #FF6B35, #FF8F5E);
      color: white;
      padding: 20px;
      border-radius: 16px;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .page-header h1 {
      font-size: 18px;
      font-weight: 600;
    }
    .page-header a {
      color: white;
      text-decoration: none;
      font-size: 14px;
      opacity: 0.9;
    }
    .page-content {
      background: white;
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08);
    }
  </style>
</head>
<body>
  <div class="page-container">
    <div class="page-header">
      <h1>${escapeHtml(page.title)}</h1>
      <a href="/">← 返回广场</a>
    </div>
    <div class="page-content">
      ${page.html_content}
    </div>
  </div>
</body>
</html>
    `;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html' }
    });
  } catch (e) {
    return new Response('服务器错误：' + e.message, { status: 500 });
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
