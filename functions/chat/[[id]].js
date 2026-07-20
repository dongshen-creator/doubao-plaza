// Cloudflare Pages Function - 聊天子页面重定向
// /chat/{roomId} → 302 重定向到 /?chat={roomId}
// 前端 init() 检测 URL 参数，进入独立聊天模式
// [[id]] 捕获 /chat/{id} 以及 /chat/{id}/子路径

export async function onRequestGet(context) {
  // [[id]] catch-all 参数是数组形式，需正确处理
  let fullPath = context.params.id || '';
  if (Array.isArray(fullPath)) {
    fullPath = fullPath.join('/');
  }
  fullPath = String(fullPath);
  const roomId = fullPath.split('/').filter(Boolean)[0] || ''; // 取第一段作为 roomId

  if (!roomId) {
    return Response.redirect(
      new URL('/', context.request.url).toString(),
      302
    );
  }

  const targetUrl = new URL('/', context.request.url);
  targetUrl.searchParams.set('chat', roomId);
  return Response.redirect(targetUrl.toString(), 302);
}
