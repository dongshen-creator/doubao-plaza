# 更新说明 (CHANGELOG)

记录每次更新的内容、遇到的技术故障及解决方案、技术突破。

---

## v3.9 — 2026-07-23

### 频道管理界面 + 图床迁移 + HTML 渲染修复 + 禁言/刷新 Bug 修复

#### 新增功能

##### 个人设置新增「频道」管理界面

- 在个人设置模态框中新增「💬 频道」标签页，与「👥 好友」标签页并列
- 支持频道分组管理（创建/编辑/删除分组），数据存储在 `localStorage`（`chat_channel_groups`）
- 参照好友分组界面的交互模式，用户可在设置中查看和管理所有已加入频道的分组归属

---

#### 故障修复

##### 1. 聊天气泡 HTML 渲染失效

**现象**：聊天中发送包含 HTML 标签的消息（如 `<a href="...">测试</a>`），消息内容显示为纯文本或标签被破坏。

**根因**：`renderMsgHTML()` 函数在 `renderRichText()` 输出的 HTML 上执行 `@mention` 正则替换，正则会匹配到 HTML 标签属性中的 `@` 字符，在属性值内插入 `<span>` 元素，导致 HTML 结构被破坏。

**修复**：
1. 新增 `applyMentionHighlight()` 函数，在文本节点层面处理 `@提及`，而非在已渲染的 HTML 字符串上操作
2. `renderMsgHTML()` 移除原有的全局正则替换，改为调用 `applyMentionHighlight()`
3. 确保 HTML 标签属性值不受 `@mention` 处理影响

**经验教训**：文本处理（正则替换）必须在 HTML 渲染之前完成，或在文本节点层面进行，绝不能在已渲染的 HTML 字符串上执行正则替换——这会破坏标签结构。

---

##### 2. 图床上传失败（img.remit.ee 不支持 API 上传）

**现象**：聊天中上传图片持续失败，用户反馈已无法使用。

**根因**：
1. 原图床 `img.remit.ee` 的上传 API 返回相对路径（如 `/api/file/xxx.png`），旧代码直接拼接后域名不匹配导致 404
2. 进一步调查发现 `img.remit.ee` 并未官方提供 API 上传接口，响应内容为 HTML 页面而非 JSON，`response.json()` 解析静默失败
3. 代码缺少对非 JSON 响应的容错处理

**修复**：
1. 根据用户要求，将 `img.api.aa1.cn` 设为首选图床（免费、无需 API Key）
2. Cloudflare R2 保留为第二优先级上传方式
3. 新增 `safeJsonParse()` 函数处理非 JSON 响应，避免静默失败
4. 支持多种响应格式解析（`code+data.url`、`initialPreview` 中的 `<img src>` 等）
5. 相对路径自动拼接完整域名（`https://img.api.aa1.cn`）

**经验教训**：第三方 API 集成必须处理非预期响应格式；`.json()` 调用应有 try-catch 保护；上传失败时应返回具体错误信息而非静默失败。

---

##### 3. 频道头像更新后不刷新

**现象**：在频道设置中修改头像后，侧边栏和聊天头部的频道图标仍然显示旧头像。

**根因**：
1. 上下文面板和设置弹窗中存在重复的 `id="editRoomAvatar"`，导致 `getElementById` 只能获取到第一个元素
2. `channelAvatarHTML()` 的 `onerror` 回调使用 `this.parentElement.textContent = '💬'`，会清空整个父元素的子节点（包括其他头像图片）
3. `updateRoomAvatar()` 更新数据库后未立即更新本地 `chatState.rooms` 状态

**修复**：
1. 上下文面板的输入框 ID 改为 `editRoomAvatarCtx`，消除重复
2. `channelAvatarHTML()` 改用包装 div + 备用 div 结构，`onerror` 仅隐藏 `<img>` 并显示备用 `💬` 图标，不破坏父元素
3. `updateRoomAvatar()` 在数据库更新成功后立即更新 `chatState.rooms` 中对应频道的 `avatar_url`，再调用 `renderRoomList()` + `switchRoom(currentRoomId)` 全量刷新

---

##### 4. 其他界面收到频道新消息后无法切换到频道

**现象**：用户在好友/公告/功能等界面时，频道收到新消息后，点击底部导航的「频道」按钮无反应，无法进入聊天界面。

**根因**：
1. `switchView()` 离开聊天视图时未将 `chatState.chatOpen` 设为 `false`，导致 `handleRealtimeMessage()` 误判当前仍在聊天视图中，不正确地调用了不存在的 DOM 元素方法
2. `handleKickedFromRoom()` 在非聊天视图下直接访问 `document.getElementById('chatEmpty')` 等 DOM 元素，返回 null 后调用 `.classList` 导致异常
3. `handleRealtimeMessage()` 和 `switchView()` 缺少 try-catch，异常导致后续代码不执行

**修复**：
1. `switchView()` 离开聊天视图时显式设置 `chatState.chatOpen = false` 并调用 `stopMessagePolling()`
2. `handleKickedFromRoom()` 对所有 DOM 元素访问添加空指针检查
3. `handleRealtimeMessage()` 整体包裹 try-catch，异常时仅记录日志不中断
4. `switchView()` 视图渲染添加 try-catch，渲染失败时显示错误提示并提供刷新按钮

---

##### 5. 频道禁言失败：null value in column "id"

**现象**：管理员在频道中对用户执行禁言操作时报错 `null value in column "id" of relation "chat_muted" violates not-null constraint`。

**根因**：`executeMute()` 调用 `__SB.from('chat_muted').upsert()` 时未提供 `id` 字段，而 `chat_muted` 表的 `id` 列定义为 `NOT NULL`，Supabase 不会自动生成 UUID（需客户端提供或数据库层有默认值）。

**修复**：在 `upsert` 操作中添加 `id` 字段，使用 `'mute_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)` 生成唯一 ID。

**经验教训**：Supabase 的 `upsert` 操作不会自动填充主键字段——除非表中定义了 `DEFAULT gen_random_uuid()`。调用方必须显式提供所有 NOT NULL 字段的值。

---

##### 6. 频道和私聊消息无法自动刷新

**现象**：切换到某个频道/私聊后，对方发送的新消息不会自动出现在聊天界面，需要手动切换房间才能看到。

**根因**：`switchRoom()` 中，当 `chatState.messages[roomId]` 已有缓存消息时，代码渲染消息并订阅 Realtime，但未调用 `startMessagePolling()` 启动轮询兜底。当 Realtime 连接不稳定或断开时，没有轮询机制补充，导致新消息无法显示。

**修复**：在 `switchRoom()` 的两个分支（有缓存 / 无缓存）中均添加 `startMessagePolling()` 调用：
- 有缓存分支：`renderMessages()` + `subscribeToRoom()` + `startMessagePolling()`
- 无缓存分支：`stopMessagePolling()` → `loadMessages()` → `subscribeToRoom()` → `startMessagePolling()`

`pollNewMessages()` 函数末尾已正确通过 `setTimeout(pollNewMessages, 5000)` 自动重启轮询，确保持续运行。

---

#### 修改文件

- `public/index.html` — 频道管理界面、图床迁移至 img.api.aa1.cn、HTML 渲染修复（@mention 处理层移至文本节点）、频道头像刷新、视图切换状态管理、禁言 ID 生成、消息轮询启动
- `CHANGELOG.md` — 本条目
- `README.md` — 更新功能清单和 FAQ

---

## v3.6 — 2026-07-23

### 移动端 UI 重构 + 频道申请加入修复 + 聊天 HTML 渲染 + Supabase 安全加固

#### 重大故障记录：Supabase 数据险些全量丢失

**时间**：2026-07-22

**事件经过**：

在排查频道申请加入功能无反应的问题时，执行了 `supabase-migration.sql` 迁移脚本。该脚本第 17 节"外键约束"中包含 8 条 `DELETE FROM ... WHERE room_id NOT IN (SELECT id FROM chat_rooms)` 语句，用于清理引用了已删除房间的孤立记录。

**根因**：`NOT IN` 语句在子查询返回空结果集时行为危险。如果 `SELECT id FROM chat_rooms` 因 RLS 策略或权限问题返回空集，`NOT IN (空集)` 对所有行都为 true，导致 **全表 DELETE**——即删除所有 `chat_unread`、`chat_room_members`、`chat_messages`、`chat_reactions`、`chat_admins`、`chat_muted`、`chat_banned`、`chat_channel_settings` 表中的全部数据。

**实际影响**：由于 Supabase SQL Editor 以 `postgres` 超级用户身份执行（绕过 RLS），`SELECT id FROM chat_rooms` 返回了完整数据，因此 DELETE 语句未误删有效数据。但如果在客户端代码中执行同样的查询（anon key 受 RLS 限制返回空集），后果将是灾难性的。

**修复措施**：

1. **`NOT IN` 改为 `NOT EXISTS`**：`DELETE FROM ... WHERE NOT EXISTS (SELECT 1 FROM chat_rooms WHERE chat_rooms.id = t.room_id)`，即使子查询返回空集也不会删除任何数据（`NOT EXISTS` 对空集返回 false）
2. **所有聊天表添加 RLS 策略**：为 13 张表添加完整的 SELECT/INSERT/UPDATE/DELETE POLICY，确保 anon key 能正常读写
3. **`DROP POLICY IF EXISTS` 幂等化**：所有 `CREATE POLICY` 前加 `DROP POLICY IF EXISTS`，防止重复执行报错
4. **`admission_mode` 数据同步**：`UPDATE chat_channel_settings SET admission_mode = admission WHERE admission_mode = 'open' AND admission IS NOT NULL AND admission != 'open'`，修复 `DEFAULT 'open'` 覆盖旧字段值的问题

**经验教训**：

- **永远不要在迁移脚本中使用 `NOT IN` + DELETE**，改用 `NOT EXISTS` 或 `LEFT JOIN ... WHERE t.id IS NULL`
- **迁移脚本必须幂等**：所有 DDL 和 DML 语句都应能安全重复执行
- **Supabase RLS 策略必须显式声明**：即使表没有开启 RLS，也应添加策略，防止未来开启 RLS 后前端突然无法读写
- **执行迁移前先备份数据**：或至少先执行 `SELECT count(*)` 确认数据量，执行后再验证
- **测试迁移脚本时用低权限用户**：模拟前端实际权限，确保 RLS 策略正确

---

## v3.7 — 2026-07-23

### 聊天气泡 HTML 溢出修复 + 公告渲染统一 + 在线人数检测 + 图床 R2 优先

#### 故障记录：聊天气泡 HTML 内容溢出

**现象**：用户在聊天中发送包含 HTML 标签的消息（如 `<a href="...">测试</a>`）时，气泡内容溢出到气泡外部，显示为长串字符。

**根因**：
1. `.chat-msg-bubble` 和 `.chat-msg` 缺少 `overflow-wrap: anywhere`，长 URL 和 HTML 块级元素无法正确换行
2. `renderRichContent`（公告渲染用）使用简易正则过滤，不移除 `on*` 事件属性和 `javascript:` 协议，存在安全风险
3. 公告内容同样缺少 `overflow-wrap` 限制

**修复**：
1. 为 `.chat-msg-bubble`、`.chat-msg-content` 添加 `overflow-wrap: anywhere; word-break: break-word; max-width: 100%`
2. 为 HTML 内容中的 `img`、`video`、`pre`、`table` 等元素添加 `max-width: 100%` 和滚动容器
3. 统一 `renderRichContent` 使用 `sanitizeHtml()` 净化器（与聊天渲染一致），移除 `on*` 事件、`javascript:` 协议等危险内容
4. 参考：飞书云文档的消息渲染也使用 `overflow-wrap: anywhere` + 白名单净化器，确保 HTML 内容严格限制在气泡内

**经验教训**：
- HTML 渲染必须同时做内容净化（XSS 防护）和布局限制（CSS overflow）
- 公告和聊天应使用统一的净化器，避免两套逻辑不一致
- 测试 HTML 渲染时，必须测试长 URL、嵌套标签、块级元素（table/pre）等边界情况

---

### Tavern 大规模 SillyTavern 功能复刻 + Coze 站点深度集成

在 `pages（与网站项目无关）/tavern/tavern.html` 中大规模复刻 SillyTavern 核心功能，并深度集成逗包广场 Coze 站点能力。本次更新新增 9 项 SillyTavern 风格功能与 3 项 Coze 站点功能。

#### 新增功能

**SillyTavern 功能复刻（9 项）：**

- **用户人格系统（Persona）**：支持多用户人格，每个含名称/头像/描述，`{{user}}` 宏替换为当前人格名，人格管理弹窗支持增删改查，聊天头部显示当前人格名
- **宏系统（Macro Engine）**：完整宏引擎，支持以下宏并应用于所有文本字段（开场白/系统提示词/描述/性格/场景/示例对话/用户输入/作者注释/世界书条目）：
  - `{{user}}` / `{{char}}` — 用户名 / 角色名替换
  - `{{time}}` / `{{date}}` — 当前时间 / 日期
  - `{{random::a::b::c}}` — 随机选择一个值
  - `{{roll NdM}}` — 骰子掷点（如 `{{roll 2d6}}`）
  - `{{getvar::name}}` / `{{setvar::name::value}}` / `{{incvar::name}}` / `{{decvar::name}}` — 变量读写与自增自减
  - `{{if condition}}...{{else}}...{{/if}}` — 条件分支
  - `{{// comment}}` — 注释（渲染时移除）
  - `{{newline}}` — 插入换行
- **滑动/分支（Swipe / Branching）**：生成替代 AI 回复时创建新版本（保留旧版本），通过左右箭头按钮在各版本间导航，滑动计数器显示"1/N"，`regenerateSwipe()` 函数在不删除旧版本的前提下创建新版本
- **消息可见性切换**：通过眼睛图标（eye / eye-slash）将任意消息从 AI 上下文中包含/排除，被排除的消息以降低透明度+橙色边框显示，`buildRequestMessages()` 自动跳过被排除的消息
- **世界书 / 设定集（World Info / Lorebook）**：按角色配置世界书条目，支持关键词匹配触发与常驻（always active）两种模式，编辑弹窗支持增删改查，`getActiveWIEntries()` 扫描聊天文本进行关键词匹配，匹配的条目作为系统消息注入到聊天历史之前
- **作者注释（Author's Notes）**：按角色配置作者注释，可设置插入频率（每 N 条用户消息注入一次），作为系统消息注入，支持宏替换
- **快捷回复（Quick Replies）**：按角色配置自定义快捷回复按钮，格式为 `label|content`（支持宏），以紫色标签形式渲染在快捷栏中，与内置提示词按钮并列
- **替代开场白（Alternate Greetings）**：每个角色支持多条开场白，清空聊天时随机选择一条，可在角色编辑器中编辑，导出时包含在 V2 角色卡中
- **增强角色卡 V2（Enhanced Character Card V2）**：导入导出新增字段：`worldInfo`（作为 `character_book` 条目）、`authorNote`、`quickReplies`、`alternateGreetings`、`cozeAgentId`

**Coze 站点功能集成（3 项）：**

- **智能体画廊（Agent Gallery）**：浏览/搜索 Coze 站点智能体（按名称和分类），查看智能体卡片（头像/名称/描述/标签/统计），可将任意智能体导入为角色（完整元数据：system_prompt、opening_line、suggested_replies 转为快捷回复）
- **交互式选项链接（Interactive Choice Links）**：AI 消息中的 `coco://sendMessage?msg=xxx` 链接渲染为蓝色可点击按钮，点击后自动发送关联消息，在 `appendMsgDOM` 和 `finalizeStreamMsg` 中均进行解析
- **建议回复（Suggested Replies）**：导入 Coze 智能体时，其 `suggested_replies` 数组自动转换为自定义快捷回复按钮

#### 修改文件

- `pages（与网站项目无关）/tavern/tavern.html` — 全部新增功能（约新增 1500+ 行，单体 HTML 总计约 5200+ 行）

#### 遇到的技术故障

##### 故障 1：宏系统条件分支解析嵌套问题

- **现象**：`{{if}}...{{else}}...{{/if}}` 条件宏在嵌套使用时，正则匹配可能错误截断内容
- **原因**：简单的非贪婪正则无法正确处理嵌套的 `{{if}}` 块，内层 `{{/if}}` 会被外层匹配提前消费
- **解决方案**：对条件宏采用分层匹配策略，先处理最内层无嵌套的条件块，再逐层向外解析，确保嵌套结构正确处理

##### 故障 2：滑动版本状态与 DOM 不同步

- **现象**：重新生成消息后切换滑动版本，显示内容与数据不匹配
- **原因**：`regenerateSwipe()` 创建新版本后未正确更新当前滑动索引，且 DOM 渲染未同步刷新滑动计数器
- **解决方案**：在 `finalizeStreamMsg()` 中同步更新 `swipes` 数组与 `swipeIndex`，并在 `addMsgActions()` 中重新渲染滑动导航控件和计数器

##### 故障 3：世界书关键词匹配注入重复

- **现象**：同一条世界书条目在连续多轮对话中被重复注入，导致上下文膨胀
- **原因**：`getActiveWIEntries()` 每次构建请求时都全量扫描聊天文本，未对已注入条目去重
- **解决方案**：按条目 key 去重，同一激活周期内每条世界书条目仅注入一次；常驻条目与关键词匹配条目合并后统一去重

#### 技术突破

##### 突破 1：完整宏引擎的纯前端实现

- **挑战**：SillyTavern 的宏系统支持变量、条件分支、随机、骰子等多种语法，需在纯前端单文件中实现且应用于所有文本字段
- **方案**：
  - 使用正则 + 字符串替换实现宏解析，按依赖顺序分层处理（先变量读写，再条件分支，最后简单替换）
  - 条件宏 `{{if}}...{{else}}...{{/if}}` 采用从内到外的分层匹配，支持嵌套
  - 变量存储在角色级 `chatVariables` 对象中，`{{setvar}}`/`{{incvar}}`/`{{decvar}}` 实时读写
  - 宏替换统一封装在 `applyMacros()` 函数中，`buildRequestMessages()` 和 `buildCozeContext()` 均调用

##### 突破 2：滑动/分支的消息版本管理

- **挑战**：SillyTavern 的 Swipe 功能需要为每条 AI 消息保留多个版本，且版本间可自由切换，不能覆盖旧版本
- **方案**：
  - `addMessageToChat()` 为 assistant 消息初始化 `swipes` 数组（首个版本即当前内容）和 `swipeIndex` 索引
  - `regenerateSwipe()` 不删除旧内容，而是向 `swipes` 数组追加新版本并更新索引
  - `addMsgActions()` 渲染左右箭头按钮和"1/N"计数器，切换时从 `swipes` 数组读取对应版本内容并重新渲染 DOM
  - `finalizeStreamMsg()` 流式完成后将最终内容写入当前 swipe 版本

##### 突破 3：世界书 + 作者注释的上下文注入

- **挑战**：需要在构建 AI 请求时动态注入世界书条目（基于关键词匹配）和作者注释（基于频率），且不能破坏原有消息结构
- **方案**：
  - `buildRequestMessages()` 在组装消息前先调用 `getActiveWIEntries()` 扫描聊天文本，收集所有激活的世界书条目（常驻 + 关键词匹配），按去重后的顺序作为系统消息注入到聊天历史之前
  - 作者注释根据 `insertionFrequency`（每 N 条用户消息）判断是否注入，作为独立系统消息
  - 所有注入文本均经过 `applyMacros()` 宏替换

##### 突破 4：Coze 智能体到角色卡的完整映射

- **挑战**：Coze 智能体的数据结构（system_prompt / opening_line / suggested_replies / tags）需要完整映射到 Tavern 角色卡格式
- **方案**：
  - 智能体画廊拉取 `GET /api/agents` 列表，前端渲染卡片网格（头像/名称/描述/标签/统计）
  - 导入时 `system_prompt` → 角色系统提示词，`opening_line` → 角色开场白，`suggested_replies` → 快捷回复按钮（`label|content` 格式），`cozeAgentId` 保留用于 Coze 会话路由
  - 交互式选项链接 `coco://sendMessage?msg=xxx` 在消息渲染阶段（`appendMsgDOM` / `finalizeStreamMsg`）解析为蓝色按钮，点击触发自动发送

---

## v3.8 — 2026-07-23

### 10 项综合修复：R2 上传 404 + 移动端 UI + 频道功能 + 性能优化

#### 关键 Bug：R2 文件上传后 URL 返回 404

**现象**：聊天中上传图片/文件到 R2 后，返回的 URL（如 `https://domain/cdn-assets/chat-assets/...`）访问时返回 404，文件上传"成功"但无法显示。

**根因**：`public/_routes.json` 的 `include` 数组为 `["/api/*", "/pages/*", "/chat/*"]`，缺少 `/cdn-assets/*` 路径。Cloudflare Pages 根据 `_routes.json` 决定哪些路径触发 Functions，未列入 `include` 的路径会被当作静态文件处理。由于 `functions/cdn-assets/[[key]].js` 对应的 `/cdn-assets/*` 路径未被路由，R2 文件无法通过该 Function 读取，导致 404。

**修复**：在 `include` 中添加 `"/cdn-assets/*"`，使 `/cdn-assets/` 路径正确路由到 R2 代理 Function。

**经验教训**：
- Cloudflare Pages 的 `_routes.json` 是路由控制的核心配置，遗漏路径会导致 Function 不可达
- 添加新的 Pages Function 时，必须同步更新 `_routes.json` 的 `include` 数组
- 测试上传功能时，不仅要验证上传 API 返回成功，还要验证返回的 URL 可访问

---

#### 移动端 UI 修复

- **清理死 CSS**：删除 `style.css` 中已无 HTML 引用的 `.mobile-fab` 系列样式（浮动按钮已被 header 中的 ☰ 按钮取代）
- **统一 ☰ 按钮样式**：聊天视图 header 的 ☰ 按钮从内联样式改为使用 `sidebar-toggle-btn` 类，与其他视图（好友/公告/功能）保持一致
- **开发者按钮**：确认 `#actBarDeveloperBtn` 已在 activity bar 中正确显示，`updateNavbar()` 同步可见性

---

#### 频道功能增强

##### 频道头像统一

- `roomItemHTML` 函数中频道默认头像从 `📢` 改为 `channelAvatarHTML(r, 32)`，显示频道实际头像或 `💬` 默认图标
- 浏览频道列表也添加了频道头像显示
- `channelAvatarHTML()` 函数在头像加载失败时自动回退为 `💬` 图标

##### 频道公告错误处理

- `loadChannelAnnouncements` 增加 `error` 解构和错误日志
- 表不存在时显示具体错误信息（如 "Could not find the table"），不再静默返回"暂无公告"

##### 频道分组功能

- `renderRoomList` 添加频道分组筛选标签（类似好友分组），点击分组名筛选该分组下的频道
- 频道设置弹窗中添加"📁 频道分组管理"按钮，调用已有的 `showChannelGroupManager()` 管理分组
- 分组数据存储在 `localStorage`（`chat_channel_groups`），无需数据库变更

##### 入群申请改进

- 在频道聊天视图顶部显示入群申请横幅（仅管理员可见），包含申请人头像、昵称和通过/拒绝按钮
- 新增 `renderChannelJoinBanner(roomId)` 函数，在 `switchRoom` 中调用
- 新增 `fetchUserInfo(uid)` 函数带缓存，避免重复 API 调用查询同一用户信息
- `loadChannelJoinRequests` 改用缓存版本 `fetchUserInfo`，减少网络请求

---

#### 性能优化

##### 浏览频道 N+1 查询修复

**问题**：`showBrowseChannels` 函数对每个频道执行 2 次串行查询（成员数 + 当前用户是否已加入），N 个频道导致 2N 次 Supabase 查询。

**修复**：改为 2 次批量查询：
1. 一次 `.in('room_id', roomIds)` 查询获取所有频道的成员记录，前端聚合计算每频道的成员数
2. 一次 `.eq('user_id', currentUser.id).in('room_id', roomIds)` 查询检查当前用户已加入的频道

**效果**：查询次数从 2N 降为 2（常数级），浏览频道加载速度显著提升。

---

#### 其他修复

##### user_presence 错误处理

- `sendPresenceHeartbeat` 和 `getOnlineUserCount` 遇到 `PGRST205`（表不存在）错误时，设置 `__presenceTableMissing` 标志并停止后续重试，避免每 30 秒重复报错
- 用户需在 Supabase SQL Editor 中执行 `supabase-migration.sql` 创建 `user_presence` 表

##### HTML 渲染验证

- 确认 `renderMsgHTML` 使用 `<div class="chat-msg-content">`（v3.7 修复），`sanitizeHtml` 清理 href 中的反引号
- 问题根因是代码未部署到 Cloudflare Pages，非代码缺陷

#### 修改文件

- `public/_routes.json` — 添加 `/cdn-assets/*` 到 `include` 数组（关键修复）
- `public/style.css` — 删除 `.mobile-fab` 死 CSS（约 35 行）
- `public/index.html` — 统一 ☰ 按钮样式、频道头像替换、公告错误处理、N+1 优化、入群申请横幅、频道分组筛选、user_presence 错误处理
- `README.md` — 更新技术架构（R2 存储）、部署教程（R2 绑定步骤）、功能清单
- `CHANGELOG.md` — 本条目

---

## v3.4 — 2026-07-15

### Tavern 角色扮演聊天工具（重大新增）

新增独立的 SillyTavern 风格角色扮演聊天工具 `pages（与网站项目无关）/tavern/tavern.html`，单体 HTML 应用，浏览器直接运行，`localStorage` 存储。

#### 新增功能

- **角色管理系统**：创建/编辑/删除角色卡，含头像、描述、性格、场景、开场白、示例对话、系统提示词
- **SillyTavern Character Card V2 兼容**：支持 V2 格式角色卡导入导出，`charToCardV2()` / `cardV2ToChar()` 双向转换
- **批量导出导入**：多选角色批量导出为独立 JSON 文件（每个角色一个），合并导入时自动处理重名（添加后缀）
- **多 AI 提供商体系**（前缀路由 `getProviderInfo()`）：
  - NVIDIA NIM（11 个模型，预置密钥，需 CORS 代理）
  - OpenCode AI `oc:` 前缀（6 个免费模型，预置密钥，需 CORS 代理）
  - SiliconFlow `sf:` 前缀（5 个免费模型，支持 CORS 直连）
  - OpenRouter `or:` 前缀（4 个免费模型，支持 CORS 直连）
  - 逗包广场 Coze 站点 `cz:` 前缀（7 个智能体，账号登录，需 CORS 代理）
  - 自定义（任意 OpenAI 兼容 API）
- **逗包广场 Coze 站点 API 集成**：
  - 通过浏览器探索发现 Coze 站点 REST API：`POST /api/auth/login`（Cookie 认证）、`POST /api/conversations`（创建会话）、`POST /api/chat`（发送消息，SSE 流式 `data:{"delta":"chunk"}`）、`GET /api/agents`（获取智能体列表）
  - 设置面板新增 Coze 登录区域（站点地址/用户名/密码/登录按钮/状态显示）
  - 首条消息自动注入角色设定上下文（`buildCozeContext()`）
  - 编辑/删除/清空/重新生成消息时自动重置 Coze 会话映射，下次创建新会话
  - 401/403 错误自动清除 session 并提示重新登录
- **SSE 流式输出**：实时逐字显示 AI 回复，支持 AbortController 停止生成
- **继续生成**：在最后一条 AI 回复后追加续写（Coze 通过发送"请继续"消息实现）
- **内联消息编辑**：双击消息弹出 textarea 编辑器，替代 `prompt()` 弹窗，支持 Markdown 渲染
- **TTS 语音朗读**：Web Speech API `SpeechSynthesis`，可选语音/语速/音调/自动播放，自动清理 Markdown 标记
- **STT 语音输入**：Web Speech API `SpeechRecognition`，支持中英文识别，按钮模式触发
- **背景图系统**：4 种模式（默认/纯黑/纯白/自定义 URL），角色级背景覆盖，集成第三方图床（img.remit.ee / sm.ms）上传
- **上下文管理**：Token 预算控制、自动裁剪最早消息、上下文进度条可视化
- **本地模型支持**：Transformers.js v3 浏览器内推理（无需 API）

#### 修改文件

- `pages（与网站项目无关）/tavern/tavern.html` — 全部 Tavern 功能（约 3700 行单体 HTML）
- `functions/api/proxy.js` — CORS 代理增强

#### proxy.js CORS 代理增强

- 新增 `X-Coze-Session` 请求头支持：代理自动将其转为 `Cookie: db_session=<token>` 转发给 Coze 站点
- 新增 `X-Set-Session` 响应头：从 Coze 登录响应的 `Set-Cookie` 中提取 `db_session` 值返回给前端
- 使用 `getSetCookie()` + `get()` 双重 fallback 确保 Set-Cookie 提取兼容性
- OPTIONS 预检新增 `X-Coze-Session` 到 `Access-Control-Allow-Headers`，新增 `X-Set-Session` 到 `Access-Control-Expose-Headers`
- GET 请求也支持 Coze Cookie 认证

### 主站功能修复

- **注册/登录阻断修复**：设备指纹采集失败不再硬性阻断注册/登录（允许 null 指纹）
- **IP 注册频率限制放宽**：从每小时 3 次提高到 5 次
- **拍一拍后缀修复**：用户搜索 API 响应新增 `pat_suffix` 字段，拍一拍消息格式改为"拍了拍 [name] 的[suffix]"（无后缀时回退为"拍了拍 [name]"）
- **Agent 导入改版**：移除"从豆包对话链接导入"功能，改为"Agent Prompt + 对话流粘贴"格式，`parseHistoryText()` 支持多种格式（角色名换行/同行/标签/JSON），`extractRoleNameFromText()` 自动提取角色名

### 遇到的技术故障

#### 故障 1：第三方 CORS 代理全部失效（API 524）

- **现象**：Tavern 调用 AI API 时返回 524 错误，`proxy.cors.sh` 等第三方 CORS 代理服务已下线
- **影响**：所有依赖 CORS 代理的 AI 提供商（NVIDIA NIM、OpenCode）无法使用
- **解决方案**：创建自托管 CORS 代理 `functions/api/proxy.js`，部署在 Cloudflare Pages Functions 上，通过 `X-Target-URL` 请求头转发

#### 故障 2：NVIDIA NIM API 503（资源耗尽）

- **现象**：预置的 NVIDIA API Key 返回 503，资源已耗尽
- **解决方案**：新增 SiliconFlow 和 OpenRouter 作为替代提供商（均支持 CORS 直连，无需代理），并添加 OpenCode AI 作为默认提供商

#### 故障 3：Coze 站点 API 参数格式不兼容

- **现象**：按 OpenAI 格式（`conversation_id`/`agent_id`/`content`）调用 Coze API 返回 400 `missing params`
- **原因**：Coze API 使用 camelCase 参数名（`conversationId`/`agentId`），且消息字段为 `message` 而非 `content`
- **解决方案**：通过 Node.js 脚本暴力测试 8 种参数组合，最终确定正确格式为 `{ conversationId, message, agentId }`

#### 故障 4：Coze 站点使用 Cookie 认证，浏览器无法直接设置

- **现象**：浏览器 `fetch()` 无法手动设置 `Cookie` 请求头（被安全策略阻止）
- **解决方案**：在 CORS 代理中新增 `X-Coze-Session` 请求头，代理端将其转换为 `Cookie` 头转发；登录响应的 `Set-Cookie` 由代理提取为 `X-Set-Session` 响应头返回

#### 故障 5：Cloudflare Workers `Set-Cookie` 获取方式不一致

- **现象**：`response.headers.get('Set-Cookie')` 在 Cloudflare Workers 运行时中可能无法正确获取多个 Set-Cookie
- **解决方案**：优先使用 `response.headers.getSetCookie()`（返回数组），回退到 `get('Set-Cookie')`

#### 故障 6：editMessage 作用域错误

- **现象**：`hasMd` 变量在 `if` 块内声明但在外部引用，导致 ReferenceError
- **解决方案**：将 `let hasMd = false;` 提升到外层作用域

#### 故障 7：deleteMessage 内容匹配错误

- **现象**：`m.content === content` 可能匹配到错误的消息（内容相同的多条消息）
- **解决方案**：改用 DOM 位置索引匹配（`Array.from(allMsgs).indexOf(div)`）

#### 故障 8：拖拽导入失效

- **现象**：`fileInput.files = e.dataTransfer.files` 在大多数浏览器中不工作（Files 只读）
- **解决方案**：直接调用 `importFiles(e.dataTransfer.files)` 传入 FileList

### 技术突破

#### 突破 1：Coze 站点 API 逆向与集成

- **挑战**：Coze 站点使用自定义 REST API（非 OpenAI 兼容），Cookie 认证，有状态对话，SSE 格式不同
- **方案**：
  - 通过浏览器自动化探索站点，抓取网络请求发现全部 API 端点
  - Node.js 脚本暴力测试参数格式（8 种组合），确定 `{ conversationId, message, agentId }`
  - CORS 代理层实现 Cookie 认证转换（`X-Coze-Session` → `Cookie: db_session`）
  - 前端实现独立代码路径（`cozeLogin`/`cozeCreateConversation`/`cozeSendChat`/`parseCozeSSE`），与 OpenAI 兼容路径完全分离
  - 会话状态管理：`cozeConversations` 映射角色 ID 到 Coze 会话 ID，消息编辑/删除时自动重置

#### 突破 2：多提供商 API 抽象层

- **挑战**：需要同时支持 5+ 种 API 提供商，认证方式、请求格式、CORS 支持各不相同
- **方案**：前缀路由系统（`sf:`/`or:`/`oc:`/`cz:`/`custom`/bare），`getProviderInfo()` 统一解析，`API_PROVIDERS` 预设配置，CORS 代理智能开关（有代理走代理，无代理直连）

#### 突破 3：纯前端 TTS/STT 实现

- **挑战**：需要免费、无依赖的语音功能
- **方案**：使用浏览器内置 Web Speech API（`SpeechSynthesis` + `SpeechRecognition`），零成本、零依赖、零延迟，支持语音选择/语速/音调调节

---

## v3.3 — 2026-07-14

### 安全修复（严重）

- **密码 PBKDF2 哈希存储**：密码不再明文存入 D1 数据库。注册和修改密码时使用 Web Crypto API 的 PBKDF2（SHA-256，100000 次迭代，16 字节随机盐）进行哈希，存储格式 `pbkdf2$100000$saltHex$hashHex`。登录时自动兼容旧明文密码并平滑升级为哈希。
  - 影响文件：`functions/api/users.js`、`functions/api/users/login.js`、`functions/api/users/[id]/settings.js`
- **密码长度限制放宽**：从固定 6 位改为 6-32 位（前后端同步修改，共 8 处）
- **features.js DELETE 鉴权**：DELETE 端点原本无任何身份校验，任何人可删除功能图标。现已添加开发者身份验证（与 POST/PUT 一致）
- **custom-pages.js DELETE 鉴权**：从 URL query 参数获取 user_id（可伪造）改为基于 `Authorization: Bearer <token>` 的会话 token 鉴权
- **schema.sql matrix_room_id 约束修复**：`matrix_room_id TEXT NOT NULL UNIQUE` 改为 `matrix_room_id TEXT UNIQUE`，与运行时定义一致，避免新部署插入失败

### 功能修复

- **D1/Supabase 双库断层修复**：频道房间在前端通过 Supabase 创建，但 `deleteConversation`、`kickMember`、`checkChannelPermission` 三个函数仍调用 D1 API（D1 的 `chat_rooms` 表为空），导致这些功能始终失败。现已全部改为直接操作 Supabase，移除无效的 D1 API 调用。
  - `deleteConversation`：改为直接从 Supabase 删除频道全部关联数据（消息/成员/未读/管理员/封禁/禁言/设置/公告/工具/房间）
  - `kickMember`：移除冗余的 D1 API 调用（已有 Supabase 删除逻辑）
  - `checkChannelPermission`：改为查询 Supabase `chat_room_members` 表判断权限
- **triggerCleanup 清理**：移除请求体中后端未使用的 `user_id` 字段

### 遇到的技术故障

#### 故障 1：D1/Supabase 双数据库断层导致功能静默失效

- **现象**：删除对话、踢人、频道权限检查等功能完全失效，但前端用 `.catch(() => null)` 静默吞掉错误，导致"看起来能跑"但实际无效
- **原因**：聊天房间从前端直接通过 Supabase 创建（`__SB.from('chat_rooms').insert(...)`），但 Cloudflare Pages Functions 的 `chat/index.js` 查询的是 D1 数据库。D1 的 `chat_rooms` 表始终为空，所有 `SELECT * FROM chat_rooms WHERE id=?` 查询都返回 null
- **解决方案**：前端三个函数（`deleteConversation`、`kickMember`、`checkChannelPermission`）全部改为直接操作 Supabase，移除无效的 D1 API 调用

#### 故障 2：deleteConversation 请求体未 JSON.stringify

- **现象**：删除对话功能完全不可用，`fetch()` 抛出 TypeError
- **原因**：`body: { user_id: ..., room_id: ... }` 传递的是 JS 对象而非字符串，`fetch()` 不接受对象作为 body
- **解决方案**：随双库断层修复一并解决——改为直接操作 Supabase，不再调用 D1 API

#### 故障 3：密码明文存储

- **现象**：D1 数据库中 `password` 字段存储的是明文密码
- **原因**：注册和修改密码时直接将原始密码 `.bind(password)` 写入数据库
- **解决方案**：使用 Web Crypto API 的 PBKDF2 进行哈希处理（SHA-256，100000 次迭代），登录时兼容旧明文密码并自动升级

### 技术突破

#### 突破 1：PBKDF2 密码哈希在 Cloudflare Pages Functions 中的实现

- **挑战**：Cloudflare Workers/Pages Functions 不支持 Node.js 的 `bcrypt`/`scrypt` 模块，只能使用 Web Crypto API
- **方案**：使用 `crypto.subtle.importKey` + `crypto.subtle.deriveBits` 实现 PBKDF2-SHA-256，100000 次迭代，16 字节随机盐，256 位输出
- **兼容性**：`verifyPassword` 函数先检查存储格式，非 `pbkdf2$` 开头视为旧明文密码，直接比较后自动升级为哈希

---

## v3.2 — 2026-07-06

### 新增功能

- **SQL 文件合并**：将 8 个分散的 Supabase SQL 文件合并为 1 个 `supabase-migration.sql`，包含建表、索引、外键、触发器、Realtime、pg_cron 清理、Storage 权限策略，一次性执行全部完成
- **开发者文件上传改造**：前端文件上传从 Cloudflare R2 迁移到 Supabase Storage，`devUploadFile`/`devLoadFileList`/`devDeleteFile` 三个函数全部重写为使用 `__SB.storage.from('pages')` 直连 Supabase
- **custom-pages.js 权限修复**：DELETE 接口添加开发者权限校验，此前任何人都能删除自定义页面
- **内联颜色迁移至 CSS 变量**：通过 Python 脚本批量将 `index.html` 中 129 处硬编码内联颜色（如 `color:#1a1a2e`）替换为 CSS 变量（如 `color:var(--text-primary)`），确保暗色模式全局一致
- **style.css 版本升级**：版本号从 `?v=2` 升级到 `?v=3`，强制浏览器加载新样式
- **D1 清理脚本重命名**：`supabase-cleanup.sql` 重命名为 `d1-cleanup.sql`，消除命名歧义（该文件是 SQLite 语法，在 D1 Console 执行，不是 Supabase）
- **README 部署教程重写**：8 步傻瓜教程，每步附带验证方法，TRAE 可直接照着部署

### 修复

- **聊天隐藏功能改进**：隐藏会话不再被新消息自动取消；底部新增"已隐藏"折叠区，可一键恢复；隐藏图标从 👁️ 改为 🙈
- **清空聊天记录**：`clearChatHistory` 改为真正删除服务端消息（Supabase DELETE），不再仅清本地显示
- **`deleteConversation` 修复**：改用 `api()` 封装（自动设置 Content-Type），修复之前裸 `fetch` 未设置 JSON 头的问题
- **调试日志清理**：移除 27 条 `console.log('[CHAT-DEBUG]...')` 调试日志

### 遇到的技术故障

#### 故障 1：外键约束创建失败（FK constraint violation）

- **现象**：执行 `supabase-migration.sql` 时，创建 `fk_curd_room` 外键约束报错：`insert or update on table "chat_unread" violates foreign key constraint`
- **影响**：`chat_unread` 表中存在引用了已删除房间的孤立记录（如 `room_mq7j4ygnqofxs5`），PostgreSQL 在创建外键前会校验引用完整性，发现孤立数据后拒绝创建约束
- **原因**：聊天房间被删除后，关联的 `chat_unread`、`chat_room_members` 等子表记录未被级联清理
- **解决方案**：在外键创建语句前添加孤立数据清理语句：
  ```sql
  DELETE FROM chat_unread WHERE room_id NOT IN (SELECT id FROM chat_rooms);
  DELETE FROM chat_room_members WHERE room_id NOT IN (SELECT id FROM chat_rooms);
  -- ... 对所有子表执行相同清理
  ```
  清理完成后再创建外键约束即可成功

#### 故障 2：JavaScript SyntaxError 导致全站崩溃

- **现象**：部署后浏览器报 `Uncaught SyntaxError: Unexpected token '.'` 和 `Uncaught ReferenceError: showModal is not defined`，所有 JavaScript 功能失效
- **影响**：整个网站完全不可用——所有按钮、弹窗、聊天功能全部瘫痪
- **原因**：在移除调试日志（`console.log('[CHAT-DEBUG]...')`）时，误删了 `subscribeToRoom` 函数中 Supabase Realtime 订阅链的 INSERT 事件回调函数。原始代码是一个链式调用：
  ```javascript
  .on('postgres_changes', { event: 'INSERT', ... },
    payload => { handleRealtimeMessage(roomId, payload.new); })
  ```
  回调函数被删除后，链式调用断裂，`.on()` 后面缺少合法的回调参数，导致语法解析器在下一个 `.` 处报错
- **解决方案**：恢复被误删的 INSERT 事件回调：`payload => { handleRealtimeMessage(roomId, payload.new); }`
- **教训**：批量删除调试日志时必须逐行确认，不能简单按关键词批量删除——日志语句可能与其他代码在同一行或紧邻

#### 故障 3：D1 Web Console 不支持多语句执行

- **现象**：在 D1 Web Console 中粘贴 `schema.sql` 全部内容执行，报 `The request is malformed: Requests without any query are not supported`
- **原因**：D1 Web Console 对多语句 SQL 的解析有限制，一次只能执行一条语句（以分号结尾）
- **解决方案**：逐条粘贴执行。已在 README 中注明此限制

#### 故障 4：表情符号导致编辑工具失败

- **现象**：`SearchReplace` 工具无法匹配包含 👁️（含变体选择符 U+FE0F）的行
- **原因**：👁️ 是多码点表情（U+1F441 + U+FE0F），编码处理可能不一致
- **解决方案**：逐行单独替换，避免在搜索字符串中包含变体选择符

#### 故障 5：Supabase SQL Editor 浏览器自动化失败

- **现象**：尝试通过浏览器自动化操作 Supabase SQL Editor 执行 SQL，但 Monaco Editor 无法被程序化控制
- **原因**：Supabase SQL Editor 使用 Monaco Editor（VS Code 内核），它是一个复杂的虚拟化编辑器，不支持简单的 `textarea` 填充或 `contenteditable` 操作
- **解决方案**：放弃浏览器自动化方案，改为提供手动操作指南，让用户自行复制粘贴执行 SQL

### 技术突破

#### 突破 1：Supabase SQL 幂等迁移脚本设计

- **挑战**：需要将 8 个分散的 SQL 文件合并为 1 个文件，且必须能重复执行不报错、不丢数据
- **方案**：
  - 所有 `CREATE TABLE` 使用 `IF NOT EXISTS`
  - 所有 `CREATE INDEX` 使用 `IF NOT EXISTS`
  - 所有 `ALTER TABLE ADD COLUMN` 使用 `IF NOT EXISTS`
  - 外键约束使用 `DO $$ BEGIN IF NOT EXISTS ... END $$` 条件判断
  - 触发器使用 `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`
  - Realtime 使用 `DO $$ BEGIN IF NOT EXISTS ... END $$` 检查 `pg_publication_tables`
  - pg_cron 使用 `CREATE OR REPLACE FUNCTION` + `SELECT cron.schedule()`（重复 schedule 会创建多个同名任务，但 Supabase 会自动去重）
- **例外**：问卷表（`channel_questionnaire_answers` / `channel_questionnaires`）使用 `DROP TABLE IF EXISTS` + `CREATE TABLE`，因为结构变更较大，已在注释中标明会清空已有问卷数据

#### 突破 2：R2 到 Supabase Storage 的无缝迁移

- **挑战**：开发者文件上传功能原依赖 Cloudflare R2（`PAGES_BUCKET`），用户无法部署 R2
- **方案**：
  - 前端 `devUploadFile`/`devLoadFileList`/`devDeleteFile` 三个函数完全重写，使用 `__SB.storage.from('pages')` 直连 Supabase Storage
  - `functions/pages/[[id]].js` 保留 R2 优先读取逻辑作为兼容层（有 R2 时用 R2，无 R2 时回退 D1）
  - `functions/api/pages/upload.js` 保留 R2 API 作为 legacy 兼容（前端不再调用）
  - 用户只需创建 Supabase Storage `pages` 公开桶，无需配置任何 Cloudflare R2

#### 突破 3：内联颜色批量迁移至 CSS 变量

- **挑战**：`index.html` 中有 129 处硬编码的内联颜色样式（如 `style="color:#1a1a2e"`），暗色模式下无法统一覆盖
- **方案**：编写 Python 脚本，通过正则表达式批量匹配 `style="...color:#xxxx..."` 模式，根据颜色值映射到对应的 CSS 变量（`--text-primary`、`--text-faint`、`--bg-card` 等），逐行替换并验证语法正确性

---

## v3.1 — 2026-07-06

### 新增功能

- **Supabase 消息自动清理**：通过 `pg_cron` 每天凌晨自动清理 7 天前的聊天消息和孤立表情反应
- **全局亮/暗色模式**：`style.css` 完全重写（215 → 484 行），使用 CSS 变量驱动，主页/聊天/弹窗/开发者面板全部适配暗色模式

### 修复

- **Matrix 死代码清理**：`chat/index.js` 从 1046 行精简到 145 行，删除全部 Matrix 协议相关代码（约 800 行死代码），仅保留前端实际调用的 4 个接口
- **`handleBanMember`/`handleUnbanMember` bug**：原代码引用未定义的 `room` 变量会抛 ReferenceError，已随 Matrix 清理一并删除
- **`handleCleanupMessages` bug**：原代码引用 D1 不存在的 `chat_reactions` 表 + 使用错误的 `rows` 属性，已修复为正确的 D1 元数据清理
- **聊天操作按钮**：从内联样式的 `chat-recall-btn` 改为语义化的 `chat-room-act` 类，移除所有内联 `style` 属性

### 遇到的技术故障

#### 故障 1：Matrix 配置导致 API 500

- **现象**：`chat/index.js` 第 99 行检查 `MATRIX_HOMESERVER` 环境变量，未配置时所有 chat API 返回 500
- **影响**：`channel-members`、`kick-member`、`delete-conversation`、`cleanup-messages` 四个前端仍在调用的接口全部不可用，但前端用 `.catch(() => null)` 静默吞掉了错误，导致"看起来能跑"但频道成员列表加载失败、踢人无效
- **原因**：聊天消息层已从前端 Matrix 协议迁移到 Supabase 直连，但后端 `chat/index.js` 仍保留 Matrix 代码和前置检查
- **解决方案**：删除 Matrix 相关代码和第 99 行检查，仅保留纯 D1 操作的 4 个 handler

#### 故障 2：暗色模式主页不生效

- **现象**：切换暗色模式后，聊天面板变为深色，但主页（导航栏、卡片、弹窗、输入框）仍是亮色
- **原因**：原 `style.css` 仅在 `.dark` 类下覆盖了聊天面板的 ~15 条规则，主页约 20+ 个选择器无任何暗色覆盖；开发者弹窗内更是大量使用 `style="color:#1a1a2e"` 等硬编码内联样式
- **解决方案**：用 CSS 变量重写整个 `style.css`，所有颜色/背景/边框通过 `:root` 和 `.dark` 两套变量定义，切换时自动生效

#### 故障 3：隐藏会话被自动取消

- **现象**：用户隐藏会话后，对方发一条新消息就会自动取消隐藏，导致隐藏功能形同虚设
- **原因**：`handleRealtimeMessage` 和 `sendChatMsg` 中有"收到/发出消息时自动从隐藏列表移除"的逻辑，且与 `notifEnabled` 耦合
- **解决方案**：移除两处自动取消隐藏逻辑，隐藏的会话保持隐藏，仅增加未读计数

#### 故障 4：`deleteConversation` 缺少 Content-Type 头

- **现象**：删除对话时后端可能收不到正确的 JSON body
- **原因**：使用裸 `fetch()` 而非项目统一的 `api()` 封装，未设置 `Content-Type: application/json` 头
- **解决方案**：改用 `api()` 封装，并添加 `try/catch` 错误处理，网络失败时返回错误而非继续清空本地状态

#### 故障 5：`clearChatHistory` 仅清本地不删服务端

- **现象**：点击"清空聊天记录"后本地消息消失，但其他人仍能看到历史消息
- **原因**：`clearChatHistory` 只执行 `chatState.messages[roomId] = []`，不操作数据库
- **解决方案**：改为 `await __SB.from('chat_messages').delete().eq('room_id', roomId)`，同时清理 `chat_reactions` 和重置 `chat_unread`

---

## v3.0 — 2026-07-04（初始版本）

### 已有功能

- 用户注册/登录/搜索/资料编辑
- 好友/黑名单/举报系统
- 实时聊天（私聊+频道群聊）
- Supabase Realtime 消息推送
- 5 种频道准入模式
- 开发者后台（公告/功能/自定义页面）
- Cloudflare Pages Functions 后端 API
- D1 + Supabase 双库架构
