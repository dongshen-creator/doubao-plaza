// Cloudflare Pages Function - Render Custom Page
// GET /pages/[id] - 渲染自定义页面（纯HTML输出，无容器）

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

    // 直接输出开发者提交的HTML内容，不添加任何容器框架
    return new Response(page.html_content, {
      headers: { 'Content-Type': 'text/html' }
    });
  } catch (e) {
    return new Response('服务器错误：' + e.message, { status: 500 });
  }
}
