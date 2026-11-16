/* V12.3 · WorkBuddy 同源后台探针（静态占位）
 * ---------------------------------------------------------------
 * Cloudflare Pages / cf.gallopingroad.top / WorkBuddy 纯静态托管：
 *   本文件按静态资源原样下发，__DP_BACKEND__ = false
 *   → 前端沿用 V12.1 的跨域改写逻辑（把 /api/* 指向共享主站）
 * WorkBuddy HTTP 服务形态（public/server.js）：
 *   ① 出 HTML 时直接把这个 <script src> 整行替换成内联脚本
 *      window.__DP_BACKEND__ = true，形态判定不再依赖本文件；
 *   ② 本路径仍由服务端动态返回 true，作为直接访问时的兜底。
 *
 * V12.2 教训：只靠 ① 之外的这条路不可靠 —— 平台门禁
 * （Server: CloudStudio Gateway）对无 __wb_rsc 会话的非首页请求会 403 并返回 HTML，
 * 浏览器把 HTML 当 JS 解析失败，__DP_BACKEND__ 保持 undefined，
 * 前端于是误判成「静态托管」并跨域改写 /api，最终表现为 failed to fetch。
 */
window.__DP_BACKEND__ = false;
