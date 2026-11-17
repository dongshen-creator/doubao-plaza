# AGENTS.md

## 项目概述
逗包用户广场（Doubao Plaza）— 面向豆包智能体用户的社交平台：用户展示/搜索、实时聊天（私聊 + 频道群聊）、好友/黑名单、举报与自动惩罚、小肥羊讲堂（博客）、网站工具包、开发者后台等。

技术栈（无前端构建步骤）：
- 前端：原生 JS + Supabase JS SDK，单体 HTML（`public/index.html` 与 `public/tavern.html`，均为单文件应用）
- 后端：Cloudflare Pages Functions（`functions/**`，Edge Runtime，普通 JS + ESM `import`）
- 数据库：Cloudflare D1（账户/社交）+ Supabase PostgreSQL（聊天消息、Realtime 推送）
- 文件存储：picgo.net + tmpfile.link + Cloudflare R2 + Supabase Storage

## 项目计划与任务（动手前先读）
- `README.md` — 项目总览、架构、部署教程（用户侧）
- `CHANGELOG.md` — **版本化任务/变更日志**（最新 v13.1）。每条记录含「新增/修复/修改文件表/验证记录」，是当前进行中工作和历史决策的主要来源。**改完代码必须同步更新 CHANGELOG**（新版本号 + 修改文件表）
- `docs/TOOL_FRAMEWORK_GUIDE.md` — 网站工具框架扩展教程（改 `functions/api/tools/` 前必读）
- `sql/supabase-migration.sql` — **Supabase 唯一迁移脚本**（已整合原 `supabase-security-fix.sql` 与 `fix-chat-members-rls.sql` 的全部内容，幂等可重复执行）
- `sql/migrate-developers.sql` / `sql/d1-cleanup.sql` — D1 增量数据库脚本
- `sql/schema.sql` — D1 初始化脚本
- `sql/migrations/` — 版本化增量迁移（v8.x–v11.x，含回滚脚本；V11 已有生产库需执行 `v11.0-admin-risk.sql`）

## 目录结构
```
public/                      # 前端静态文件 + WorkBuddy 同源后台
  server.js                  # V12.2 Node 单端口 HTTP 服务（静态同源 + /api 等业务路径反代）
  dp-backend.js              # V12.2 部署形态探针占位（真后台动态覆盖为 true）
public/vendor/               # KaTeX / SunEditor / FingerprintJS 本地依赖（5.5MB，必须随发布包带上）
functions/api/               # 业务 API（每文件头部有注释列出端点与方法）
functions/api/_lib/          # 共享代码（jwt 等）
functions/api/tools/         # 工具注册表 registry.js（唯一真实来源）+ ai.js / proxy.js / fetch.js
functions/api/moss/          # MOSS AI TTS/STT/音色转接端点
functions/api/chat/          # 聊天频道管理
functions/cdn-assets/[[key]].js   # R2 文件代理
functions/pages/[[id]].js    # 自定义页面渲染（R2 优先，回退 D1）
sql/                         # 数据库脚本（schema.sql / supabase-migration.sql / migrate-developers.sql / d1-cleanup.sql）
sql/migrations/              # 版本化增量迁移（v8.x–v11.x）
workers/                     # Cloudflare Worker 源码（反代 cf.gallopingroad.top → Pages）
docs/                        # 开发文档（TOOL_FRAMEWORK_GUIDE.md）与素材（screenshots/）
```

## 关键规则与坑（务必注意）
1. **CSP 极严**：`public/_headers` 定义全局 `Content-Security-Policy`。前端新增任何外部域名（`connect-src`、`img-src`、`script-src`、`frame-src` 等）必须同步加入 _headers，否则会被拦截。
2. **不要用 Function 覆盖静态文件路径**：曾尝试 `functions/tavern.html.js` 放宽 tavern 的 CSP → 上线 404 并已回滚（`env.ASSETS.fetch()` 无法取回被路由接管的同名资源）。静态文件保持纯静态托管，CSP 只能全局处理。
3. **`public/_routes.json`**：只有 include 列表中的路径（`/api/*`、`/pages/*`、`/chat/*`、`/cdn-assets/*`）会走 Functions 路由；新增 Functions 目录须同步检查 include。
4. **前端是单体大文件**（index.html ~630KB、tavern.html ~1.1MB）：修改时搜索相关函数/区块就地编辑，保持现有风格（中文注释、内联 CSS/JS）。`style.css` 用 CSS 变量支撑亮/暗色模式，新颜色尽量走 `--acc`/`--acc2` 等变量。
5. **工具框架单一事实来源**：新增网站工具只改 `functions/api/tools/registry.js`（按 docs/TOOL_FRAMEWORK_GUIDE.md 的 api_type 模式），不要另起后端分散定义。
6. **数据库变更**：D1 改 `sql/schema.sql`；Supabase 只改 `sql/supabase-migration.sql` 且保持幂等（可重复执行）；非法协议校验（头像 URL 等）已有 `validateAvatarUrl` 类防护，新增用户输入 URL 必须做协议白名单校验。
7. **无 npm/构建工具链**：Cloudflare Pages 侧没有 package.json / wrangler.toml，无本地 build/test/lint 命令；Build command 留空、输出目录 `public`。**V12.2 起 `public/` 内不应存在 `package.json`**（会干扰 Pages 构建）；WorkBuddy 发布改用显式 `language=node` + `startCmd="node server.js"` + `installCmd=""` 指定启动入口。项目为 git 仓库（remote：github.com/dongshen-creator/doubao-plaza）。
8. **管理员与设备风控**：`/api/developer/*` 新端点统一走 `requireDeveloper(..., {stepup:true})` + `writeAdminAudit()`；批量处置必须预演、确认数、逐目标重查、角色层级保护、逐项结果；设备证据只存散列，客户端值不得作为唯一身份依据。新增 D1 表/列同时写 `sql/schema.sql` 与 `sql/migrations/` 的增量脚本。
9. **WorkBuddy 发布形态（V12.2 强制，V12.3 补充）**：发布域**必须跑真后台** `public/server.js`，不要用「前端 fetch patch 跨域改写到主站」当最终方案——跨域会让 `__Host-dp_device` 设备 Cookie 被第三方策略拦截、静态资源 404、CORS 预检失败，登录始终不稳。判定依据：`GET /__dp/health` 应返回 `mode: workbuddy-backend`。**形态常量必须由服务端在 HTML 里内联注入**（把 `<script src="/dp-backend.js">` 整行换成 `window.__DP_BACKEND__=true`），**禁止**让浏览器单独请求探针文件来做判定：平台门禁 `Server: CloudStudio Gateway` 会对无 `__wb_rsc` 会话的非首页请求返回 403 + HTML，浏览器把 HTML 当 JS 解析失败，常量缺失 ⇒ 前端误判为静态托管 ⇒ 跨域预检失败 ⇒ 用户只看到 `failed to fetch`（V12.3 已踩过这个坑）。三张页面（index / developer / tavern）都必须具备「真后台同源 / 静态托管跨域降级 + 失败回退同源」两条分支，缺一不可。
10. **`/.cloud/**` 是平台网关保留路径**：WorkBuddy 云数据面由边缘（`Server: tcbgw`）按路径接管，自建后台绝不能把它反代到业务主站；服务里需保留环回守卫。云服务精确 Origin 校验依赖发布时复用同一 appId / 保留域，不要换发布目录或 domainPrefix。
9. **纯前端特性（V11.1）**：凡标注「仅前端、不占用后端资源」的需求，只允许用 `localStorage` / DOM / CSS 实现，禁止新增 Functions 文件、`fetch` / `api()` 调用、数据库查询或服务端日志；首访类状态一律写本地标记并提供隐私模式内存兜底；覆盖层用 `pointer-events:none` 避免遮挡既有交互，目标元素用 `getBoundingClientRect()` 动态定位以适配导航重渲染与移动端隐藏；改动 `style.css` 后必须同步提升 `index.html` / `developer.html` 的 `?v=` 缓存版本号。
10. **云服务与共享架构（V12.1）**：目标是「自建应用与 doubao-plaza.pages.dev 共享同一套服务」，**禁止把云库做成另一套业务数据库**。D1 + Supabase 是唯一事实来源。云 SDK 只在本项目用 `@dev` CDN 形式初始化一个 `createWorkBuddyCloud` 实例，`endpoint` / `oauthRelayBaseUrl` / `publishableKey` 只能来自 `workbuddy_cloud_service` 的 `publicConfig`；不得硬编码其他域的 endpoint。云表必须 RLS + 两道门（GRANT + POLICY）；导出端点只做白名单公开投影，绝不导出密码/令牌/密保/IP/设备指纹/私信。回写令牌 `SYNC_BRIDGE_TOKEN` 未配置时 503 失败关闭，令牌仅存内存。新增 D1 表同时写 `sql/schema.sql` 与 `sql/migrations/`。
    - **WorkBuddy 发布域是纯静态托管，没有 Functions**：`public/index.html` 必须把该域的 `/api/*` 改写为主站绝对地址并注入 `X-DP-Client: plaza-v1`，`/vendor/*` 经 `__dpAsset` 改写到主站，manifest 在该域移除。主站与 `cf.gallopingroad.top` 保持同源相对路径。登录态是 `localStorage.dp_token` + Bearer 头，不依赖 Cookie。
    - **`functions/_middleware.js` 全局门禁先于所有端点执行**：V12.1 起白名单为**自有前端域名的全业务 API**（`isSharedAppOrigin()`：精确发布域 + `*.app.workbuddy.host` + 官方反代域），中间件统一应答 CORS 预检并给实际响应补 CORS 头。实际请求仍必须带 `X-DP-Client: plaza-v1`；蜜罐、限流、封禁检查不得放宽。新增前端域名必须同步维护此白名单与 `public/index.html` 的 `LOCAL_HOSTS`。
    - **副本同步必须无人值守**：云数据库 `dp_replica` 是公开脱敏投影副本，对 `anon` 开放读写（RLS `WITH CHECK` 限定 `d1|supabase` 来源、白名单表、`record_key ≤ 128`，不开放 DELETE）。`public/cloud-service.js` 的自动同步**不得依赖 `refreshSession()` / `gate()` / 面板按钮** —— SDK 无匿名登录，一旦要求登录就会静默跳过。水位存 `localStorage`，只在 `originOk()`（发布域）执行，页面隐藏暂停、异常静默重试。SDK 未加载时降级同源 REST 仅带 publishableKey。V12.0 的 owner-scoped 四表保持原样。
11. **V13 云服务账号迁移边界（V13.1）**：账号认证在 WorkBuddy 云服务，但业务 `/api/*` 仍由常驻主站承载。云令牌**必须先经** `POST /api/users/cloud-bridge` 用 `dp_auth_session` RPC 二次校验并换取 D1 会话令牌，前端 `dp_token` 只能存主站令牌；禁止把云 token 直接写进 `dp_token`。`cloud-backend.js` 里迁移历史账号必须调用 `origFetch`，不能再调用被包装的 `window.fetch`。`/api/users/auto-login` 不拦截，继续走主站。

## 编码约定
- Functions：ESM `import`，文件顶部注释列出支持的端点与参数，错误返回统一 JSON `{ error: '...' }` 风格。
- 注释使用中文；修复类变更在代码中标注「V12 修复：…」之类的版本说明。
- 身份凭证走 `Bearer dp_token`（`functions/api/_lib/jwt.js` 签发），勿硬编码密钥。