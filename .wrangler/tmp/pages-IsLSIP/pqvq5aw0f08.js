// <define:__ROUTES__>
var define_ROUTES_default = {
  version: 1,
  include: ["/api/*", "/pages/*", "/chat/*"],
  exclude: [
    "/style.css",
    "/supabase-sdk.js",
    "/index.html",
    "/"
  ]
};

// ../../../../../../opencode/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/pages-dev-pipeline.ts
import worker from "D:\\\u4ED8\u8BF8\u7684\u6587\u4EF6\\\u91CD\u8981\u6587\u4EF6\\python\u6587\u4EF6\u5939\\\u9017\u5305\u7528\u6237\u5E7F\u573A\\project3.0\\doubao-plaza(5)\\.wrangler\\tmp\\pages-IsLSIP\\functionsWorker-0.9798177705280926.mjs";
import { isRoutingRuleMatch } from "D:\\opencode\\npm-cache\\_npx\\32026684e21afda6\\node_modules\\wrangler\\templates\\pages-dev-util.ts";
export * from "D:\\\u4ED8\u8BF8\u7684\u6587\u4EF6\\\u91CD\u8981\u6587\u4EF6\\python\u6587\u4EF6\u5939\\\u9017\u5305\u7528\u6237\u5E7F\u573A\\project3.0\\doubao-plaza(5)\\.wrangler\\tmp\\pages-IsLSIP\\functionsWorker-0.9798177705280926.mjs";
var routes = define_ROUTES_default;
var pages_dev_pipeline_default = {
  fetch(request, env, context) {
    const { pathname } = new URL(request.url);
    for (const exclude of routes.exclude) {
      if (isRoutingRuleMatch(pathname, exclude)) {
        return env.ASSETS.fetch(request);
      }
    }
    for (const include of routes.include) {
      if (isRoutingRuleMatch(pathname, include)) {
        const workerAsHandler = worker;
        if (workerAsHandler.fetch === void 0) {
          throw new TypeError("Entry point missing `fetch` handler");
        }
        return workerAsHandler.fetch(request, env, context);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
export {
  pages_dev_pipeline_default as default
};
//# sourceMappingURL=pqvq5aw0f08.js.map
