# 逗包用户广场 (Doubao Plaza)

一个面向豆包智能体用户的社交平台，集成了用户展示/搜索、实时聊天（私聊+频道群聊）、好友/黑名单系统、举报与自动惩罚、开发者后台等功能。

## 技术架构

| 层级 | 技术 | 用途 |
|------|------|------|
| 前端 | 原生 JavaScript + Supabase JS SDK | 单体 HTML 应用，直连 Supabase |
| 后端 API | Cloudflare Pages Functions | 用户管理、频道管理、自定义页面 |
| 数据库（账户/社交） | Cloudflare D1 (SQLite) | 用户、好友、举报、公告、频道元数据 |
| 数据库（聊天消息） | Supabase (PostgreSQL) | 消息存储、表情反应、实时推送 |
| 实时通信 | Supabase Realtime | WebSocket 消息推送 + 前端轮询兜底 |
| 文件存储 | Cloudflare R2 + 第三方图床 | 聊天图片/文件上传（R2 优先）+ 开发者文件托管（Supabase Storage） |
| 部署 | Cloudflare Pages | 边缘网络部署，全球加速 |

## 项目结构

```
doubao-plaza/
├── public/                        # 前端静态文件
│   ├── index.html                 # 主应用（HTML + 内嵌 JavaScript）
│   ├── style.css                  # 全局样式表（CSS 变量 + 亮/暗色模式）
│   └── supabase-sdk.js            # Supabase JS SDK v2.108.0
├── functions/                     # Cloudflare Pages Functions
│   ├── api/
│   │   ├── chat/index.js          # 聊天频道管理 API
│   │   ├── proxy.js               # CORS 代理（转发 AI API 请求，支持 Coze Cookie 认证）
│   │   ├── users.js               # 用户注册/搜索
│   │   ├── users/login.js         # 登录
│   │   ├── users/auto-login.js    # 自动登录
│   │   ├── users/[id].js          # 用户资料/注销
│   │   ├── users/[id]/settings.js # 用户设置
│   │   ├── friends.js             # 好友关系
│   │   ├── blocked.js             # 黑名单
│   │   ├── reports.js             # 举报
│   │   ├── announcements.js       # 公告
│   │   ├── features.js            # 功能图标
│   │   ├── custom-pages.js        # 自定义页面 CRUD
│   │   ├── pages/upload.js        # 文件上传 API（R2 兼容，前端已改用 Supabase Storage）
│   │   ├── upload/image.js        # 聊天文件/图片上传 API（R2 存储）
│   │   └── presence.js            # 在线状态心跳 API
│   ├── cdn-assets/
│   │   └── [[key]].js             # R2 文件代理（通过 /cdn-assets/ 路径访问 R2 对象）
│   └── pages/
│       └── [[id]].js              # 自定义页面渲染路由（R2 优先，回退 D1）
├── schema.sql                     # D1 数据库初始化脚本
├── supabase-migration.sql         # Supabase 数据库迁移脚本（唯一文件，幂等可重复执行）
├── d1-cleanup.sql                 # D1 过期记录清理脚本
├── README.md                      # 本文件
└── CHANGELOG.md                   # 更新说明

# 独立工具（与主站分离，可单独部署）
pages（与网站项目无关）/
├── tavern/
│   └── tavern.html                # Tavern 角色扮演聊天工具（单体 HTML 应用）
└── tavern-standalone/
    └── index.html                 # Tavern 精简版
```

## 部署教程

本教程从零开始，每一步都写明了具体操作位置和验证方法。照着做即可完成部署。

### 前置条件

- GitHub 账号
- Cloudflare 账号
- Supabase 账号

---

### 第一步：创建 GitHub 仓库

1. 在 GitHub 上创建一个新仓库（如 `doubao-plaza`），设为 Public 或 Private 均可
2. 将项目所有文件上传到该仓库

**验证**：仓库根目录下能看到 `public/`、`functions/`、`schema.sql`、`supabase-migration.sql` 等文件。

---

### 第二步：创建 Supabase 项目并初始化数据库

1. 访问 [supabase.com](https://supabase.com) 注册/登录
2. 点击 **New Project**，填写项目名称和数据库密码，选择区域（推荐 Southeast Asia）
3. 等待项目创建完成（约 2 分钟）
4. 记录以下信息（稍后要用）：
   - 进入 **Project Settings** → **API**
   - 复制 **Project URL**（形如 `https://xxxxx.supabase.co`）
   - 复制 **anon public key**（一长串 `eyJ...` 开头的字符串）

5. 初始化数据库表结构：
   - 进入左侧 **SQL Editor** → **New query**
   - 打开项目根目录的 `supabase-migration.sql` 文件
   - 全选复制，粘贴到 SQL Editor 中
   - 点击 **Run**（或按 Ctrl+Enter）执行
   - 等待执行完成，应显示 `Success`，无报错

   > **注意**：这个文件包含建表、索引、外键约束、触发器、Realtime、消息自动清理、Storage 权限策略，**一次性全部搞定**。可以重复执行，不会丢数据（除问卷表外），不会报错。

6. 创建 Storage 存储桶：
   - 进入左侧 **Storage** 页面
   - 点击 **New bucket**
   - 名称填 `pages`，勾选 **Public bucket**（公开访问）
   - 点击 **Create bucket**

   > 只需要创建 `pages` 一个桶。聊天图片/文件上传走的是第三方图床服务，不需要额外存储桶。

**验证**：
- SQL Editor 中执行 `SELECT tablename FROM pg_tables WHERE schemaname = 'public';`，应看到 `chat_rooms`、`chat_messages` 等约 14 张表
- Storage 页面应看到 `pages` 桶

---

### 第三步：配置前端 Supabase 连接信息

1. 打开 `public/index.html`
2. 找到第 16-17 行（文件最上方 `<script>` 标签内）：

```javascript
var SUPABASE_URL = 'https://你的项目.supabase.co';
var SUPABASE_ANON_KEY = '你的anon_key';
```

3. 将 `SUPABASE_URL` 替换为第二步记录的 Project URL
4. 将 `SUPABASE_ANON_KEY` 替换为第二步记录的 anon key

替换后应类似：
```javascript
var SUPABASE_URL = 'https://blabla.supabase.co';
var SUPABASE_ANON_KEY = 'eyblabla...';
```

5. 将修改后的文件提交到 GitHub

**验证**：在 GitHub 仓库中打开 `public/index.html`，确认第 16-17 行已是你的 Supabase 信息。

---

### 第四步：创建 Cloudflare D1 数据库

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 左侧菜单 → **Workers & Pages** → **D1**
3. 点击 **Create database**
4. 数据库名称填 `doubao-plaza`，点击创建
5. 创建后，进入数据库详情页 → **Console** 标签
6. 打开项目根目录的 `schema.sql` 文件，全选复制
7. 粘贴到 D1 Console 的输入框中，点击 **Execute**

   > **注意**：D1 Web Console 一次只能执行一条语句，如果报 `malformed request` 错误，请逐条粘贴执行（每条 `CREATE TABLE` / `CREATE INDEX` 是一条语句，以分号结尾）。

8. 打开 `d1-cleanup.sql`，同样在 D1 Console 中逐条执行

9. 记录 **Database ID**（在数据库详情页的 Overview 中可以看到），稍后要用

**验证**：在 D1 Console 中执行 `SELECT name FROM sqlite_master WHERE type='table';`，应看到 `users`、`friendships`、`sessions` 等约 15 张表。

---

### 第五步：部署到 Cloudflare Pages

1. 在 Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. 选择你在第一步创建的 GitHub 仓库
3. 配置构建设置：
   - **Framework preset**: `None`
   - **Build command**: 留空
   - **Build output directory**: `public`
4. 点击 **Save and Deploy**
5. 等待首次部署完成（此时因为还没绑定 D1 数据库，页面会报错，这是正常的）

---

### 第六步：绑定 D1 数据库

1. 进入 Cloudflare Pages 项目详情页 → **Settings** → **Functions**
2. 找到 **D1 database bindings**，点击 **Add binding**：
   - **Variable name**: `DB`
   - **D1 database**: 选择第四步创建的 `doubao-plaza`
3. 点击 **Save**

---

### 第六步半：绑定 R2 存储桶

聊天图片/文件上传功能使用 Cloudflare R2 存储，需要绑定 R2 存储桶：

1. 在 Cloudflare Dashboard → **R2** → **Create bucket**
2. 存储桶名称填 `doubao-plaza-assets`，点击创建
3. 回到 Cloudflare Pages 项目详情页 → **Settings** → **Functions**
4. 找到 **R2 bucket bindings**，点击 **Add binding**：
   - **Variable name**: `PAGES_BUCKET`
   - **R2 bucket**: 选择刚创建的 `doubao-plaza-assets`
5. 点击 **Save**

> R2 绑定后，聊天上传的文件存储在 `chat-assets/{userId}/{timestamp}-{filename}` 路径下，通过 `/cdn-assets/` 路径访问。

---

### 第七步：重新部署

1. 进入 **Deployments** 标签，找到最新的部署，点击 **Retry deployment**（或推送任意 commit 到 GitHub 触发重新部署）

**验证**：部署完成后，访问 Cloudflare Pages 分配的域名（如 `doubao-plaza.pages.dev`），应看到登录/注册页面正常加载。

---

### 第八步：配置开发者权限

1. 在网站上注册第一个账号
2. 回到 Cloudflare Dashboard → D1 → `doubao-plaza` → Console
3. 查询你的用户 ID：
   ```sql
   SELECT id, name, doubao_id FROM users;
   ```
4. 将你的账号设为开发者：
   ```sql
   UPDATE users SET is_developer = 1 WHERE doubao_id = '你的豆包号';
   ```
   或者直接用 ID：
   ```sql
   UPDATE users SET is_developer = 1 WHERE id = '你的用户ID';
   ```

5. 重新登录网站，左侧导航栏应出现「开发者」入口

> **备选方式**：也可以在 `functions/api/custom-pages.js`、`functions/api/announcements.js` 等文件顶部的 `DEV_IDS` 数组中添加你的 `doubao_id`，然后重新部署。

**验证**：登录后能看到开发者面板，可以管理公告、创建自定义页面。

---

### 第九步：验证部署

逐项测试以下功能：

| 功能 | 操作方式 | 预期结果 |
|------|----------|----------|
| 注册 | 填写信息点击注册 | 注册成功，自动登录 |
| 登录 | 输入豆包号+密码 | 登录成功 |
| 搜索用户 | 在搜索框输入关键词 | 显示匹配的用户卡片 |
| 发起私聊 | 点击用户卡片的「发消息」 | 创建私聊房间，可收发消息 |
| 创建频道 | 聊天界面点击创建频道 | 频道创建成功，可设置准入模式 |
| HTML 消息 | 聊天中发送 `<a href="...">链接</a>` | 消息渲染为可点击链接 |
| 图片上传 | 聊天中上传图片 | 图片上传成功并显示 |
| 在线人数 | 查看聊天界面在线状态 | 显示在线用户数 |
| 频道公告 | 频道设置中发布公告 | 公告在右侧面板和设置中显示 |
| 频道分组 | 频道设置中管理分组 | 侧边栏显示分组筛选标签 |
| 暗色模式 | 点击右上角主题切换按钮 | 全站切换为暗色，包括聊天界面 |
| 开发者-公告 | 开发者面板→公告管理 | 可创建/编辑/删除公告 |
| 开发者-自定义页面 | 开发者面板→页面管理 | 可创建 HTML 页面并上传文件 |
| 自定义页面访问 | 访问 `/pages/{页面ID}` | 页面正常渲染，带登录墙 |

---

## 环境变量速查表

| 变量 | 位置 | 用途 |
|------|------|------|
| `SUPABASE_URL` | `public/index.html` 第 16 行 | Supabase 连接地址 |
| `SUPABASE_ANON_KEY` | `public/index.html` 第 17 行 | Supabase 公开密钥 |
| `DB` | Cloudflare Pages → D1 binding | D1 数据库绑定变量名 |
| `PAGES_BUCKET` | Cloudflare Pages → R2 binding | R2 存储桶绑定变量名（聊天文件上传） |
| Storage 桶 `pages` | Supabase Storage | 开发者文件托管（公开桶） |

> **R2 配置说明**：聊天图片/文件上传使用 Cloudflare R2（`PAGES_BUCKET` 绑定），需在 Pages 设置中配置 R2 绑定（见第六步半）。开发者文件托管仍使用 Supabase Storage 的 `pages` 桶。

---

## 功能清单

### 用户系统
- 注册（豆包号 + 智能体链接验证 + 头像 + 简介）
- 登录（密码 + 设备指纹 + 7天自动登录）
- 用户资料编辑（头像、密码、简介、拍一拍后缀）
- 隐私三档（正常 / 白名单+邀请码 / 全网隐身）
- 账号注销

### 社交功能
- 用户搜索（姓名/简介/豆包号/邀请码）
- 好友申请/接受/拒绝/删除
- 好友分组管理
- 黑名单
- 拍一拍
- 举报（30天/6月分级自动惩罚）

### 聊天系统
- 私聊 + 频道群聊
- 实时消息推送（Supabase Realtime + 轮询兜底）
- HTML 消息渲染（白名单净化器，支持 `<a>`、`<img>`、`<b>`、`<table>` 等 30+ 标签）
- 图片/文件上传（Cloudflare R2 优先 + 第三方图床兜底）
- 在线人数检测（Supabase user_presence 心跳，5 分钟超时）
- 消息撤回/表情反应
- @提及 / 回复引用
- 已读/未读计数
- 频道管理（创建/加入/退出/删除）
- 5种准入模式（开放/密码/邀请码/问卷/自定义页面）
- 成员角色（创建者 > 管理员 > 普通）
- 踢人/禁言/转让所有权
- 频道分组/置顶/隐藏（localStorage 存储）
- 频道公告（富文本 HTML + 置顶 + 可见性控制）
- 频道工具（快捷链接管理）
- 入群申请审核（频道顶部横幅 + 实时推送通知）
- 消息自动清理（7天保留策略，pg_cron 定时执行）

### 开发者后台
- 公告管理（CRUD + 富媒体插入）
- 功能图标管理
- 自定义页面（HTML 托管 + Supabase Storage 文件上传）
- 文件管理（Supabase Storage `pages` 桶）

### 主题
- 亮色/暗色模式无缝切换
- CSS 变量驱动，全局一致
- 系统偏好自动检测

---

## Tavern 角色扮演聊天工具

一个独立的单体 HTML 应用（`pages（与网站项目无关）/tavern/tavern.html`），灵感来自 SillyTavern，提供 AI 角色扮演对话体验。无需后端，浏览器直接运行，数据存储在 `localStorage`。v3.5 大规模复刻了 SillyTavern 核心功能（用户人格、宏系统、滑动分支、世界书、作者注释、快捷回复等），并深度集成逗包广场 Coze 站点（智能体画廊、交互式选项链接、建议回复）。

### 核心功能

- **角色管理**：创建/编辑/删除角色卡，支持 SillyTavern Character Card V2 格式导入导出（含世界书、作者注释、快捷回复、替代开场白、Coze 智能体 ID）
- **批量导入导出**：多选角色批量导出为独立 JSON 文件，支持合并导入（自动处理重名）
- **多 AI 提供商**：内置 5 类 API 提供商，前缀路由自动切换
  - `NVIDIA NIM` — 预置密钥，11 个模型，需 CORS 代理
  - `OpenCode AI` (`oc:` 前缀) — 预置密钥，6 个免费模型，需 CORS 代理
  - `SiliconFlow` (`sf:` 前缀) — 支持 CORS 直连，5 个免费模型
  - `OpenRouter` (`or:` 前缀) — 支持 CORS 直连，4 个免费模型
  - **逗包广场 Coze 站点** (`cz:` 前缀) — 通过账号登录使用站点智能体，支持豆包/DeepSeek/Doubao/Qwen 等
  - `自定义` — 任意 OpenAI 兼容 API
- **SSE 流式输出**：实时逐字显示 AI 回复，支持停止生成
- **上下文管理**：Token 预算控制、对话裁剪、上下文进度条
- **继续生成**：在最后一条 AI 回复后追加续写
- **内联编辑**：双击消息直接编辑，支持 Markdown 渲染
- **语音功能**：
  - TTS 语音朗读（Web Speech API，免费，可选语音/语速/音调/自动播放）
  - STT 语音输入（Web Speech API，支持中英文识别）
- **背景设置**：4 种模式（默认/纯黑/纯白/自定义图片），支持角色级背景覆盖，集成第三方图床上传
- **本地模型**：支持 Transformers.js v3 本地推理（浏览器内运行，无需 API）
- **CORS 代理**：通过 Cloudflare Pages Function (`/api/proxy`) 转发不支持跨域的 API 请求

### SillyTavern 风格功能

- **用户人格系统（Persona）**：多用户人格管理，每个含名称/头像/描述，`{{user}}` 宏自动替换为当前人格名，聊天头部显示当前人格
- **宏系统（Macro Engine）**：完整宏引擎，应用于所有文本字段（开场白/系统提示词/描述/性格/场景/示例对话/用户输入/作者注释/世界书）：
  - `{{user}}` / `{{char}}` — 用户名 / 角色名替换
  - `{{time}}` / `{{date}}` — 当前时间 / 日期
  - `{{random::a::b::c}}` — 随机选择
  - `{{roll NdM}}` — 骰子掷点
  - `{{getvar}}` / `{{setvar}}` / `{{incvar}}` / `{{decvar}}` — 变量读写与自增自减
  - `{{if}}...{{else}}...{{/if}}` — 条件分支（支持嵌套）
  - `{{// comment}}` — 注释 / `{{newline}}` — 插入换行
- **滑动/分支（Swipe）**：重新生成 AI 回复时创建新版本并保留旧版本，通过箭头按钮在多个版本间导航，计数器显示"1/N"
- **消息可见性切换**：通过眼睛图标将任意消息从 AI 上下文中包含/排除，被排除的消息以降低透明度+橙色边框显示
- **世界书 / 设定集（World Info）**：按角色配置世界书条目，支持常驻（always active）与关键词匹配触发两种模式，匹配的条目作为系统消息注入到聊天历史之前
- **作者注释（Author's Notes）**：按角色配置作者注释，可设置插入频率（每 N 条用户消息注入一次），作为系统消息注入，支持宏替换
- **快捷回复（Quick Replies）**：按角色配置自定义快捷回复按钮（`label|content` 格式，支持宏），以紫色标签形式渲染在快捷栏中
- **替代开场白（Alternate Greetings）**：每个角色支持多条开场白，清空聊天时随机选择一条

### Coze 站点集成

- **智能体画廊（Agent Gallery）**：浏览/搜索 Coze 站点智能体（按名称和分类），查看智能体卡片（头像/名称/描述/标签/统计），可将任意智能体一键导入为角色（完整元数据映射：system_prompt / opening_line / suggested_replies 转为快捷回复）
- **交互式选项链接**：AI 消息中的 `coco://sendMessage?msg=xxx` 链接自动渲染为蓝色可点击按钮，点击后自动发送关联消息
- **建议回复**：导入 Coze 智能体时，其 `suggested_replies` 数组自动转换为自定义快捷回复按钮

### CORS 代理

Tavern 依赖 `functions/api/proxy.js` 作为 CORS 代理，用于转发不支持浏览器跨域的 API 请求（NVIDIA NIM、OpenCode、Coze 站点）。代理支持：

- **标准 API 转发**：通过 `X-Target-URL` 请求头指定目标地址，转发 `Authorization` 头
- **Coze Cookie 认证**：通过 `X-Coze-Session` 请求头传入 session token，代理自动转为 `Cookie: db_session=<token>` 转发；登录响应中的 `Set-Cookie` 自动提取为 `X-Set-Session` 响应头返回
- **SSE 流式透传**：保持 `text/event-stream` 的流式特性

### 部署方式

1. 将 `tavern.html` 放在任意静态文件服务器上（或直接在浏览器打开）
2. 如需使用 NVIDIA NIM / OpenCode / Coze 提供商，将 `functions/api/proxy.js` 部署到同域的 Cloudflare Pages
3. SiliconFlow 和 OpenRouter 支持 CORS 直连，无需代理

---

## 技术说明

### 数据库分工
- **D1 (SQLite)**：账户体系、好友关系、黑名单、举报、公告、频道元数据
- **Supabase (PostgreSQL)**：聊天消息、表情反应、未读计数、实时推送、在线状态（user_presence）、频道公告
- **Cloudflare R2**：聊天图片/文件上传存储（通过 `/cdn-assets/` 路径访问）
- **Supabase Storage**：开发者文件托管（`pages` 桶）

### 消息清理
- Supabase 端通过 `pg_cron` 每天凌晨 3 点自动清理 7 天前的消息（已包含在 `supabase-migration.sql` 中）
- D1 端通过 `d1-cleanup.sql` 手动清理过期禁言/封禁记录和孤立数据

### 亮/暗色模式
- 使用 CSS 变量 (`:root` 和 `.dark`) 驱动
- 所有颜色/背景/边框均通过变量定义（129 处内联颜色已替换为 CSS 变量）
- `localStorage` 保存用户偏好，首次访问跟随系统设置

### SQL 文件说明
- `schema.sql` — D1 数据库初始化，在 Cloudflare D1 Console 中执行
- `supabase-migration.sql` — Supabase 数据库迁移，在 Supabase SQL Editor 中执行，**幂等可重复执行**
- `d1-cleanup.sql` — D1 过期记录清理，可定期在 D1 Console 中手动执行

> 项目曾使用 8 个分散的 SQL 文件，现已合并为上述 3 个文件。旧文件已删除。

---

## 常见问题

**Q: 部署后页面空白？**
A: 检查 `public/index.html` 第 16-17 行的 Supabase URL 和 anon key 是否已替换为你的项目信息。

**Q: 聊天消息发不出去？**
A: 检查 Supabase 的 `chat_messages` 表是否已创建（执行了 `supabase-migration.sql`），检查浏览器控制台是否有 RLS 权限错误。

**Q: 控制台报 `user_presence` 表 404 或 `PGRST205` 错误？**
A: 说明 `user_presence` 表尚未创建。请在 Supabase SQL Editor 中执行 `supabase-migration.sql`（包含 `user_presence` 表创建语句），执行后刷新页面即可。

**Q: 聊天上传图片/文件后无法显示（404）？**
A: 检查 Cloudflare Pages 设置中是否已绑定 R2 存储桶（变量名 `PAGES_BUCKET`），并确认 `_routes.json` 中 `include` 数组包含 `/cdn-assets/*`。

**Q: D1 Console 执行 SQL 报 `malformed request`？**
A: D1 Web Console 不支持多语句一次性执行。请逐条粘贴执行（每条语句以分号结尾）。

**Q: 外键约束创建失败（`violates foreign key constraint`）？**
A: 说明数据库中存在引用了已删除房间的孤立数据。`supabase-migration.sql` 中已包含孤立数据清理语句，确保在创建外键之前执行。

**Q: 开发者模式看不到？**
A: 需要在 D1 数据库中将你的 `is_developer` 设为 1（见第七步），或在 `DEV_IDS` 数组中添加你的 `doubao_id`。

**Q: 开发者文件上传失败？**
A: 检查 Supabase Storage 中是否已创建名为 `pages` 的**公开**存储桶。Storage 权限策略已包含在 `supabase-migration.sql` 中。

**Q: 暗色模式样式不生效？**
A: 强制刷新浏览器缓存（Ctrl+Shift+R）。`style.css` 版本号已更新为 `?v=3`。

**Q: Supabase SQL 执行报错 `relation already exists`？**
A: 这是正常的——`supabase-migration.sql` 使用了 `CREATE TABLE IF NOT EXISTS`，重复执行不会报错。如果看到这个提示说明表已经存在了。

**Q: Tavern 报 API 524 错误？**
A: 说明 CORS 代理不可用。确保 `functions/api/proxy.js` 已部署到 Cloudflare Pages，且 Tavern 设置中的 CORS 代理地址为 `/api/proxy`。SiliconFlow 和 OpenRouter 支持 CORS 直连，可清空代理地址。

**Q: Tavern Coze 模型提示登录失败？**
A: 在设置面板的"逗包广场账号登录"区域填写正确的站点地址、用户名和密码，点击"登录"按钮。Session 仅存储在内存中，刷新页面后需重新登录。

**Q: Tavern 宏系统怎么用？**
A: 在任何文本字段（系统提示词、开场白、描述、用户输入等）中输入 `{{user}}`（替换为当前人格名）、`{{char}}`（替换为角色名）、`{{random::a::b::c}}`（随机选一个）、`{{roll 2d6}}`（掷骰）、`{{setvar::count::1}}`/`{{incvar::count}}`（变量操作）、`{{if x>0}}正{{else}}负{{/if}}`（条件分支）等。宏在发送时自动解析。

**Q: Tavern 滑动（Swipe）功能怎么用？**
A: 重新生成 AI 回复时不会覆盖旧版本，而是创建新版本。在消息底部用左右箭头按钮在版本间切换，计数器显示当前是第几个版本（如 1/3）。

**Q: Tavern 如何从 Coze 站点导入智能体？**
A: 先在设置面板登录逗包广场账号，然后在角色列表界面打开智能体画廊，浏览/搜索站点智能体，点击导入即可将智能体转为角色卡（系统提示词、开场白、建议回复会自动映射）。

---

## License

MIT
