/* V12.2 · WorkBuddy 同源后台探针（静态占位）
 * ---------------------------------------------------------------
 * Cloudflare Pages / cf.gallopingroad.top / WorkBuddy 纯静态托管：
 *   本文件按静态资源原样下发，__DP_BACKEND__ = false
 *   → 前端沿用 V12.1 的跨域改写逻辑（把 /api/* 指向共享主站）
 * WorkBuddy HTTP 服务形态（public/server.js）：
 *   该路径由服务端动态覆盖为 __DP_BACKEND__ = true
 *   → 前端切回同源：网页、静态资源、业务接口全部在本域完成
 *
 * 这样同一份 index.html 可以同时在三种部署形态下正确工作，
 * 发布形态回退时也不会把站点打挂。
 */
window.__DP_BACKEND__ = false;
