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
- `CHANGELOG.md` — **版本化任务/变更日志**（最新 v12.0.2）。每条记录含「新增/修复/修改文件表/验证记录」，是当前进行中工作和历史决策的主要来源。**改完代码必须同步更新 CHANGELOG**（新版本号 + 修改文件表）
- `docs/TOOL_FRAMEWORK_GUIDE.md` — 网站工具框架扩展教程（改 `functions/api/tools/` 前必读）
- `sql/supabase-migration.sql` — **Supabase 唯一迁移脚本**（已整合原 `supabase-security-fix.sql` 与 `fix-chat-members-rls.sql` 的全部内容，幂等可重复执行）
- `sql/migrate-developers.sql` / `sql/d1-cleanup.sql` — D1 增量数据库脚本
- `sql/schema.sql` — D1 初始化脚本
- `sql/migrations/` — 版本化增量迁移（v8.x–v11.x，含回滚脚本；V11 已有生产库需执行 `v11.0-admin-risk.sql`）

## 目录结构
```
public/                      # 前端静态文件（index.html 主应用 / tavern.html 独立工具 / style.css / supabase-sdk.js）
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
7. **无 npm/构建工具链**：没有 package.json / wrangler.toml，无本地 build/test/lint 命令。验证靠部署后手动/浏览器实测（可参考 CHANGELOG 各版本的「验证记录」）。项目为 git 仓库（remote：github.com/dongshen-creator/doubao-plaza）。
8. **管理员与设备风控**：`/api/developer/*` 新端点统一走 `requireDeveloper(..., {stepup:true})` + `writeAdminAudit()`；批量处置必须预演、确认数、逐目标重查、角色层级保护、逐项结果；设备证据只存散列，客户端值不得作为唯一身份依据。新增 D1 表/列同时写 `sql/schema.sql` 与 `sql/migrations/` 的增量脚本。
9. **纯前端特性（V11.1）**：凡标注「仅前端、不占用后端资源」的需求，只允许用 `localStorage` / DOM / CSS 实现，禁止新增 Functions 文件、`fetch` / `api()` 调用、数据库查询或服务端日志；首访类状态一律写本地标记并提供隐私模式内存兜底；覆盖层用 `pointer-events:none` 避免遮挡既有交互，目标元素用 `getBoundingClientRect()` 动态定位以适配导航重渲染与移动端隐藏；改动 `style.css` 后必须同步提升 `index.html` / `developer.html` 的 `?v=` 缓存版本号。
10. **云服务与共享架构（V12.0）**：目标是「自建应用与 doubao-plaza.pages.dev 共享同一套服务」，**禁止把云库做成另一套业务数据库**。D1 + Supabase 是唯一事实来源；两个前端域名统一经 `/api/sync/*` 网关访问它。云 SDK 只在本项目用 `@dev` CDN 形式初始化一个 `createWorkBuddyCloud` 实例，`endpoint` / `oauthRelayBaseUrl` / `publishableKey` 只能来自 `workbuddy_cloud_service` 的 `publicConfig`；不得手写 `/.cloud/**` 请求、不得硬编码其他域的 endpoint。云表必须 RLS + 两道门（GRANT + POLICY）；共享镜像用全局唯一键而非 owner 维度，保证两域名读同一行；导出端点只做白名单公开投影，绝不导出密码/令牌/密保/IP/设备指纹/私信。回写令牌 `SYNC_BRIDGE_TOKEN` 未配置时 503 失败关闭，令牌仅存内存。新增 D1 表同时写 `sql/schema.sql` 与 `sql/migrations/`。**注意 `functions/_middleware.js` 全局门禁先于所有端点执行**：`/api/sync/*` 是唯一例外，且只豁免 CORS 预检与白名单来源，实际请求仍必须带 `X-DP-Client: plaza-v1`；新增同步端点必须同步维护 `isSharedSyncOrigin()` 白名单与两端点的 `Access-Control-Allow-Headers`，否则会重现跨域 403。其余 `/api/*` 同源门禁不得放宽。

## 编码约定
- Functions：ESM `import`，文件顶部注释列出支持的端点与参数，错误返回统一 JSON `{ error: '...' }` 风格。
- 注释使用中文；修复类变更在代码中标注「V12 修复：…」之类的版本说明。
- 身份凭证走 `Bearer dp_token`（`functions/api/_lib/jwt.js` 签发），勿硬编码密钥。