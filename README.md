# 逗包用户广场

豆包智能体用户的展示、搜索、注册登录及社交互动平台。

## 功能

- 用户注册/登录/自动登录
- 豆包广场（用户搜索、好友、黑名单）
- 实时聊天（频道群聊 + 私聊）
  - 文字/图片/文件消息
  - 表情反应、引用回复、撤回编辑
  - @提及、桌面通知
  - 频道公告、频道工具
  - 频道准入机制（公开/邀请/审核/密码/问卷/自定义页面）
  - 权限层级（开发者 > 创建者 > 管理员 > 普通用户）
- 开发者模式（公告管理、功能图标、自定义页面）
- 暗色模式
- 隐身模式/白名单模式

## 技术栈

- 前端：纯 HTML + CSS + JavaScript
- 实时通信：Supabase Realtime (WebSocket)
- 数据库：Supabase (PostgreSQL) + Cloudflare D1 (SQLite)
- 后端：Cloudflare Pages Functions

## 项目结构

├── public/
│   ├── index.html          # 主页面 (全部前端代码)
│   ├── style.css           # 样式表
│   └── supabase-sdk.js     # Supabase JS SDK
├── functions/
│   └── api/
│       ├── chat/index.js   # 聊天 API (Matrix 桥接 + 频道操作)
│       ├── users.js        # 用户列表/搜索
│       ├── users/login.js  # 登录
│       ├── users/auto-login.js # 自动登录
│       ├── users/[id].js   # 单个用户信息
│       ├── users/[id]/settings.js # 用户设置
│       ├── friends.js      # 好友系统
│       ├── blocked.js      # 黑名单
│       ├── reports.js      # 举报系统
│       ├── announcements.js # 公告 API
│       ├── features.js     # 功能图标
│       └── custom-pages.js # 自定义页面
├── schema.sql              # D1 数据库 Schema
├── supabase-schema.sql     # Supabase 数据库 Schema
├── supabase-trigger.sql    # Supabase 触发器 (未读计数)
├── supabase-features.sql   # Supabase 频道功能表
├── supabase-admission.sql  # Supabase 准入机制表
├── supabase-fk.sql         # Supabase 外键约束
└── README.md

## 部署步骤

### 1. 创建 Supabase 项目
- 注册 [supabase.com](https://supabase.com)
- 创建项目，记录 Project URL 和 anon key

### 2. 运行 SQL Schema
在 Supabase SQL Editor 中依次运行：
1. `supabase-schema.sql` — 基础表
2. `supabase-fk.sql` — 外键约束
3. `supabase-trigger.sql` — 未读触发器
4. `supabase-features.sql` — 频道功能表
5. `supabase-admission.sql` — 准入机制表

### 3. 部署 Cloudflare Pages
- 在 Cloudflare Pages 中创建新项目
- 绑定 D1 数据库 (命名为 `DB`)
- 设置环境变量（Matrix 相关，可选）
- 部署 `public/` 目录为静态资源
- `functions/` 目录自动作为 Pages Functions

### 4. 配置 Supabase Realtime
- Database → Replication → 开启 `chat_messages` 和 `chat_reactions`

### 5. 配置开发者
- 在 D1 数据库中设置 `users` 表的 `is_developer = 1`
- 或在代码中修改 `isDeveloper()` 的硬编码 ID 列表

## 环境变量 (Cloudflare)

| 变量名 | 必需 | 说明 |
|--------|------|------|
| `DB` | 是 | D1 数据库绑定 |
| `MATRIX_HOMESERVER` | 否 | Matrix 服务器地址 |
| `MATRIX_BOT_TOKEN` | 否 | Matrix 机器人 Token |
| `PAGES_BUCKET` | 否 | R2 存储桶 (自定义页面文件) |

## 许可证

MIT
