// Cloudflare Pages Function - /api/* 兜底路由（AUDIT FIX [7.1] / [6.8]）
// 修复前：未知 /api 路径无匹配函数 → Pages 回退静态资源 → SPA 返回 index.html 200 HTML
//         （实测 /api/nope-xyz → 200 text/html 717457B），API 消费方拿到 HTML 难以排查。
// 修复后：所有未被 functions/api/ 下具体文件匹配的路径落入本 splat，
//         统一返回 404 JSON，与全站 { success, error } 口径一致。
// 路由优先级：Pages 先匹配具体文件（users.js、blog/index.js 等），无命中才落 splat，
//         因此不会遮蔽任何既有端点（部署后以 /api/features、/api/users/login 复核）。
export async function onRequest(context) {
  const { request } = context;
  return new Response(JSON.stringify({ success: false, error: '接口不存在' }), {
    status: 404,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
