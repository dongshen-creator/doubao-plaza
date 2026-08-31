# 更新说明 (CHANGELOG)

记录每次更新的内容、遇到的技术故障及解决方案、技术突破。

---

## v5.14 — 2026-08-31

### 变更：前端企业级体验优化（消息本地缓存 + 增量渲染 + 未读提示 + 全局健壮性 + 依赖自托管）

基于「企业级聊天网站」目标的前端性能/体验专项优化（在 v5.13 基础上，本版本同时承载了本次 10 项优化审计中的多项已落地改动）。

#### 一、消息本地缓存（本次重点，sessionStorage 按房间）
- **背景**：原先每次切换会话 / 重新进入会话都会重新拉取服务端最近 200 条消息，网络耗时 + 白屏等待；弱网 / 短时断线时更是打不开历史。
- **实现**：
  1. 新增缓存读写辅助（`getMsgCache` / `setMsgCache` / `clearMsgCache` / `restoreMsgCache`），键前缀 `dp_msg_cache_v1_`，有效期 6 小时，只缓存轻量字段（event_id/sender/content/ts 等，不带 reactions）
  2. `switchRoom` / `openChatByRoomId`：内存没有时先从 `sessionStorage` 恢复缓存 → **即时渲染（秒开）** → 再后台静默刷新最新消息；会话内已实时收的新消息与缓存合并去重按时间排序
  3. 所有写入点同步维护缓存：`loadMessages`、`loadOlderMessages`（加载更多）、`pollNewMessages`（轮询增量）、Realtime 收到新消息、撤回/编辑（`handleRealtimeUpdate`）、全部发送路径（文本/图片/视频/文件/分享工具/分享名片/分享频道）、发送失败回滚
  4. 失效清理：清空服务端记录、单方面清理本地、移除私聊、删除会话/频道、离开频道、被请离频道——全部同步清除对应缓存
  5. 缓存与「本地清理时间戳」（`dp_local_cleared`）联动：已清理过的房间不会把清理前的历史从缓存里复活
- **收益**：会话切换即时渲染、弱网断线仍可看最近历史、减少 200 条重复拉取

#### 二、消息列表增量渲染（避免全量重绘闪烁）
- 新增 `appendNewMessages(roomId, newMsgs)`：新消息到达时用 `insertAdjacentHTML('beforeend')` 增量追加单条消息节点并注入日期分隔符（复检），不再整列 `innerHTML` 重建
- 应用于：发送消息乐观添加、轮询增量合并；条件不满足（有编辑/撤回/分页等）时自动回退全量渲染，保证不丢渲染

#### 三、未读标题 + favicon 红点
- 新增 `updateTitleUnread(total)`：合并各会话/频道未读数后标题变为 `(N) 逗包用户广场`；favicon 动态叠加红色角标（data-URI，恢复时保留原始 favicon）；未读数归零自动恢复

#### 四、全局错误兜底 + 离线横幅
- `unhandledrejection` 全局兜底（console 提示，避免未捕获 Promise 异常白屏）；`offline`/`online` 事件驱动顶部网络状态横幅，恢复联网自动补拉消息 + 刷新会话列表

#### 五、第三方依赖自托管（防 CDN DNS 污染 / local-address-space 拦截）
- FingerprintJS 从 jsdelivr CDN 改为自托管 `/vendor/fingerprintjs/fp.min.js`（浏览器指纹用于防批量注册）
- SunEditor（博客富文本编辑器）改为按需懒加载：首屏不再阻塞，进入博客编辑器时才动态加载，并支持加载失败提示
- KaTeX 数学公式渲染改为 `requestIdleCallback` 空闲期加载（`timeout: 3000` 兜底），避免首屏卡顿

#### 修改文件表
| 文件 | 说明 |
|------|------|
| `public/index.html` | v5.14 全部前端改动：消息缓存读写/恢复/失效、`appendNewMessages` 增量渲染、`updateTitleUnread` 标题/favicon 红点、全局错误与离线横幅、SunEditor/KaTeX 懒加载、FingerprintJS 自托管引用 |
| `public/vendor/fingerprintjs/fp.min.js` | **新增**：FingerprintJS 4.5.1 自托管文件 |
| `CHANGELOG.md` | 本记录 |

#### 验证记录
- [x] `node --check` 语法验证：index.html 全部 5 个内联脚本块通过
- [x] 消息缓存逻辑走查：所有 `chatState.messages[...]` 写入点均联动缓存写入或失效清理；删除/清空/离开/被踢场景缓存同步移除
- [ ] 浏览器实测：切会话秒开（缓存命中）、断网切会话仍显示最近历史、发送/撤回后重进会话缓存一致
- [ ] 数据库：本版本无 D1/Supabase 改动

---

## v5.13 — 2026-08-30

### 变更：移动端上线弹窗修复 + 消息实时提速 + 防批量注册 + 多项安全加固

#### 一、修复：移动端上线弹窗看不见
- **根因**：移动端（<768px）`.activity-bar` 会变成底部 TabBar（`position:fixed; bottom:0; z-index:100`，高 56px+安全区），而上线提醒弹窗容器 `.online-notify-container` 位于 `bottom:20px; z-index:99` —— 弹窗整块落在 TabBar 区域内且层级更低，**被 TabBar 完全盖住**，移动端永远看不见（桌面端无 TabBar 不受影响）
- **修复**：`style.css` 新增移动端媒体查询——弹窗上移至 TabBar 之上（`bottom:calc(64px + env(safe-area-inset-bottom))`），左右各 16px 自适应满宽，层级提升到 105
- 顺带修复：`startOnlineNotify` 每次调用（如重新登录）都重复 `addEventListener('visibilitychange')`，改为只绑定一次，避免重复补查/重复弹窗

#### 二、优化：消息实时响应速度
1. **`subscribeToRoom` 频道复用**：原先每次切换会话/`loadRoomList` 刷新都会**先退订再重建**同名 Realtime 频道，重订握手窗口期内到达的消息只能等 5~15s 轮询兜底，造成延迟尖峰；且移动端弱网下频繁重订更易失败。现改为「已处于 joined 状态的频道直接复用」，仅频道不可用（errored/closed）时才重建
2. **断线自动重订补全**：订阅回调原先只处理 `CLOSED`，`CHANNEL_ERROR`/`TIMED_OUT`（移动端切后台弱网常见）不会触发重订，断流后只能靠轮询。现三种状态都会在 3 秒后自动重订
3. **回前台实时恢复**：新增 `ensureRealtimeAlive()`——页面转可见时若 Realtime WebSocket 已断开则主动 `connect()`（幂等）并重订所有非 joined 状态的房间频道，与既有的「前台立即补拉」形成互补

#### 三、修复：新建对话（开启私聊）无法快速发起
- **根因**：`openPrivateChatInFriends` 要等「查找房间 → 创建房间」全部完成才渲染聊天界面；而查找既有私聊是**逐房间串行查询成员（N+1）**，私聊多的用户点击「发起私聊」后界面卡住数秒
- **修复**：
  1. 点击后**立即渲染聊天界面外壳**（显示「正在打开会话…」），房间查找/创建与历史消息加载并行在后
  2. 查找改为 3 次固定查询 + 内存配对（新函数 `findOrCreatePrivateRoom`）：会话列表缓存命中零查询；未命中时 1 次成员查询 + 1 次私聊房间查询 + 1 次成员批量查询，替代 N+1
  3. 房间不存在时创建：两个成员 upsert 改并行（原先串行）
  4. `loadRoomList()`（重接口）不再阻塞消息加载，移到后台执行；订阅 Realtime 与轮询提前到 `loadMessages` 之前启动

#### 四、新增：小肥羊讲堂每日限投一篇
- **规则**：普通用户每个自然日（北京时间）最多提交 **1 篇**新文章送审；**开发者不受限**；**修改已发布/送审中的文章**走 `PUT /api/blog/[id]`，不经过创建入口，天然不受影响；被驳回（rejected）的文章不计入当日名额（送审未成功占用，允许当天改投新篇）
- **实现**：`POST /api/blog` 服务端强制校验（`date(created_at,'+8 hours') = date('now','+8 hours')` 且 status != 'rejected' 计数 ≥1 拒绝，HTTP 429），前端绕过无效；超限返回明确提示

#### 五、修复：博客预览弹窗透明
- **根因**：`blogShowLatexPreview` 预览弹窗使用了 `.modal-box` 类，但**全项目不存在该样式定义**（样式化弹窗类是 `.modal`）→ 弹窗背景透明，预览内容与页面混在一起几乎不可读
- **修复**：改用 `.modal` 类（`background:var(--modal-bg)`），并固定头部、内容区独立滚动

#### 六、新增：防批量注册机制（抗 Tor / 动态 IP）
原防护（同 IP 频率限制 + 设备指纹一机一号）对洋葱网络/轮换代理基本无效：换 IP 即绕过，Tor 浏览器每次会话指纹随机化。本次新增四层防护（核心思路：**用真实算力成本而非 IP 身份防批量**）：
1. **PoW 工作量证明（核心）**：注册前前端向 `GET /api/users/register-challenge` 取挑战，本地穷举 nonce 使 `SHA-256(challenge:nonce)` 有 20 个前导零位（约 1~3 秒/次），注册请求携带 `pow_token + pow_nonce` 服务端验证（HMAC-SHA256 签名防篡改难度/过期）。批量注册者每注册一号都需支付真实算力，**与 IP 无关**。难度可通过环境变量 `REGISTER_POW_DIFFICULTY`（16~22）调整，密钥用 `REGISTER_POW_SECRET`（未配置则自动生成持久化到 D1）
2. **挑战单次有效 + 时间窗**：新 D1 表 `register_challenges`（schema.sql 已加，幂等可重跑）记录签发时间：15 分钟过期、签发后 <2 秒提交直接拒（脚本秒回即暴露）、原子消耗防重放；挑战先只读校验、落库前才消耗，保证「昵称重复」等校验失败后重试**无需重新解题**
3. **Tor 出口节点拦截**：对照 torproject 官方出口 IP 列表（D1 缓存 6 小时、拉取失败自动放行），命中拒绝注册；可用环境变量 `BLOCK_TOR_REGISTRATION=off` 关闭
4. **蜜罐字段**：注册表单隐藏输入框（屏幕外），机器人自动填表会填入，后端直接拒绝
- 兼容性：`register_challenges` 表未创建（未重跑 schema.sql）时整套 PoW 自动降级放行，不影响正常注册

#### 七、安全审查与修复
| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| 1 | `functions/api/proxy.js` | **硬编码 NVIDIA API Key**（源码泄露即密钥泄露，且开放代理无鉴权可被盗刷） | 移除硬编码回退值，仅从环境变量 `NVIDIA_API_KEY` 读取；未配置时不注入，用户自带 key |
| 2 | `functions/api/users/login.js` | **登录无暴力破解防护**（密码可无限试错）+ 哈希比较非常量时间 | 新增 `login_attempts` 表（首次自动创建）：同 IP 15 分钟 10 次失败、同账号 15 分钟 5 次失败即锁定；比较改恒定时间（与 recover.js 同实现） |
| 3 | `functions/api/chat/index.js` | **越权（IDOR）**：`kick-member`/`delete-conversation` 信任客户端传入的 `user_id`，任何人可冒充管理员踢人或删除频道 | 身份改为从 Bearer 会话 token 提取（`getAuthUserId`），未登录拒绝，body 中的 user_id 不再采信 |
| 4 | `functions/cdn-assets/[[key]].js` | R2 文件按扩展名回 Content-Type，缺 `nosniff`；SVG 可内嵌脚本（存储型 XSS 面） | 统一加 `X-Content-Type-Options: nosniff`；`image/svg+xml`/`text/html` 强制 `Content-Disposition: attachment` + CSP sandbox |
| 5 | `functions/api/features.js` | 功能卡 `link_url`/`icon_url` 无协议校验（可存 `javascript:` URL） | POST/PUT 均加 http(s) 协议白名单 |
| 6 | `functions/api/blog.js` / `blog/[id].js` | 封面图 `cover_image` 无协议校验 | POST/PUT 均加 http(s) 协议白名单（遵循 AGENTS.md 规则 6） |
| 7 | `public/index.html` | `toast()` 消息未转义直接 innerHTML（380+ 调用点，部分拼接可能回显用户内容的服务端错误串） | 统一 `esc(message)` 转义（全部调用点均为纯文本，已核查无依赖 HTML 的调用） |
| 8 | `public/_headers` | CSP 残留 4 个已不使用的 CDN 域（v5.11 自托管后 unpkg/cdnjs/staticfile/bootcdn 已无引用） | script-src/script-src-elem/style-src-elem/font-src 移除多余 CDN 域，仅保留 jsdelivr（FingerprintJS/tavern 依赖）；补 `worker-src 'self' blob:` |
| 9 | `functions/api/users.js` | 用户搜索接口无结果集上限（全表扫 + 全量返回） | 增加 `LIMIT 500` 上限 |

#### 修改文件表
| 文件 | 说明 |
|------|------|
| `public/style.css` | 移动端 `.online-notify-container` 上移至 TabBar 之上 + 层级 105 + 满宽自适应 |
| `public/index.html` | 上线提醒 visibilitychange 只绑一次；`subscribeToRoom` 频道复用 + 三态重订；`ensureRealtimeAlive` 前台重连；私聊立即渲染 + `findOrCreatePrivateRoom` 批量查询；博客预览弹窗 `.modal-box`→`.modal`；注册 PoW 求解器 + 蜜罐字段；`toast()` 转义 |
| `public/_headers` | CSP 收窄 + worker-src |
| `functions/api/_lib/pow.js` | **新增**：PoW 签发/验证/消耗 + Tor 出口列表缓存拦截 |
| `functions/api/users/register-challenge.js` | **新增**：GET 签发注册 PoW 挑战 |
| `functions/api/users.js` | 注册接 PoW/蜜罐/Tor 校验 + 挑战原子消耗；搜索 LIMIT 500 |
| `functions/api/users/login.js` | 登录暴力破解锁定 + 恒定时间比较 |
| `functions/api/chat/index.js` | kick/delete 越权修复（会话鉴权） |
| `functions/api/features.js` | link_url/icon_url 协议白名单 |
| `functions/api/blog.js` | 每日限投一篇（服务端强制）+ cover_image 校验 |
| `functions/api/blog/[id].js` | cover_image 校验 |
| `functions/cdn-assets/[[key]].js` | nosniff + SVG/HTML 强制下载 |
| `schema.sql` | 新增 `register_challenges` 表 + 索引（幂等可重跑） |
| `CHANGELOG.md` | 本记录 |

#### 验证记录
- [x] 全部修改文件 `node --check` 语法通过（index.html 5 个内联脚本块、9 个 Function 文件）；CSS 花括号配平
- [ ] Supabase 无本版本改动（如未执行过 v5.12 的迁移脚本则仍需重跑 `supabase-migration.sql`）；D1 无需手动操作——`register_challenges`/`site_settings` 表在首次注册验证时自动创建（幂等），重跑 `schema.sql` 亦可
- [ ] 移动端（<768px 宽度）实测：另一账号上线时弹窗出现在底部 TabBar 上方且完整可见
- [ ] 实测私聊：注册 PoW 约 1~3 秒（手机端可能 2~5 秒）后注册成功；同一昵称注册失败后修改昵称重试**不要求重新解题**
- [ ] 实测普通用户当天第 2 篇博客送审被拒（429 提示），修改已发布文章不受影响；开发者发多篇不受影响
- [ ] 博客编辑器「👁 预览」弹窗背景为卡片色（不透明），暗色模式下正常
- [ ] 私聊快速发起：点击「发起私聊」后界面立即出现，消息秒级到达（Realtime 正常时）；弱网切后台再回前台消息自动补拉
- [ ] 若 NVIDIA 密钥原先依赖硬编码回退值：部署前需在 Cloudflare Pages 环境变量配置 `NVIDIA_API_KEY`，否则 NIM 预置密钥通道停用（用户自带 key 不受影响）

---

## v5.12 — 2026-08-22

### 变更：修复发消息再次失败（new row violates RLS for table "chat_unread"）

- **现象**：上线后发消息报 `发送失败（new row violates row-level security policy for table "chat_unread"）`
- **根因**：`increment_unread()` 触发器会在 `chat_messages` 插入后，为「房间内除发件人外的其他成员」往 `chat_unread` 写未读计数（用户那行 `user_id` = 接收方）。该触发器此前未声明 `SECURITY DEFINER`，因此以调用者（发件人）身份执行；而收紧后的 `chat_unread_insert` 策略要求 `app_user_id() = user_id`，对接收方行的写入被 RLS 拦截 → 触发器抛错 → **整条 `chat_messages` INSERT 回滚 → 发消息失败**（前几版此处策略为 `(true)`，故未暴露）
- **修复**：将 `increment_unread()` 声明为 `SECURITY DEFINER SET search_path = public, pg_temp`（信任的内部触发器逻辑，仅按成员关系递增未读计数，绕过 RLS 限制，符合其作为系统自动记账的定位）
- **注意**：DB 改动需在 Supabase SQL Editor 重跑本迁移脚本后生效

#### 修改文件表
| 文件 | 说明 |
|------|------|
| `supabase-migration.sql` | `increment_unread()` 加 `SECURITY DEFINER SET search_path`（幂等，可重跑） |
| `CHANGELOG.md` | 本记录 |

#### 验证记录
- [ ] 重跑迁移后，发送私聊/群聊消息不再报 chat_unread 的 RLS 违规
- [ ] 接收方能看到未读计数 +1（触发器恢复自动记账）

---

## v5.11 — 2026-08-21

### 变更：解决 CDN 资源被拦截 + 修复私聊收发消息持续 403

#### 一、CDN 资源（KaTeX / SunEditor）被「local address space」拦截
- **现象**：线上 `doubao-plaza.pages.dev` 报错 `Access to ... blocked by CORS policy: Permission was denied for this request to access the local address space`，且所有备选 CDN（jsdelivr / unpkg / cdnjs / cdn.staticfile.net / cdn.bootcdn.net）逐一全部失败
- **根因**：用户网络环境下外部 CDN 被 DNS 污染解析到本地/私网地址，触发 Chrome 私有网络访问（PNA）拦截；**换个 CDN 没用**，任何外链都会同样失败
- **修复**：改为**本地同源静态资源自托管**，不再依赖外部 CDN：
  1. 将 KaTeX@0.16.9 完整 `dist`（含 `katex.min.js`、`katex.min.css`、`contrib/auto-render.min.js`、`fonts/*.woff2` 共 80+ 文件）下载解压到 `public/vendor/katex/dist/`
  2. 将 SunEditor@2.45.1 的 `dist/suneditor.min.js`、`dist/css/suneditor.min.css` 放到 `public/vendor/suneditor/`
  3. `public/index.html` 中 SunEditor 与 KaTeX 的 `<link>`/`<script>` 全部改为本地 `/vendor/...` 路径；KaTeX 动态加载器由「多 CDN 回退」简化为「同源顺序加载主库→auto-render」，失败才标记
  4. 本地同源资源走 `'self'` 白名单，CSP 无需新增外域；KaTeX 字体相对路径 `fonts/*` 由 `font-src 'self'` 放行

#### 二、私聊/群聊收发消息持续 403（new row violates row-level security policy for table "chat_messages"）
- **现象**：读消息（`rest/v1/chat_messages` 两次 403）与发消息（RLS 违规）提示，刷新/自动刷新 JWT 后依旧
- **根因**：收紧后的策略要求私聊房间必须本人是「房间成员或房主」；而创建私聊时是**一次性批量插入双方成员**（`insert([memA, memB])`）。当房间**由对方创建**（`created_by` = 对方）时，本方可写入自己那行，但写入**对方行**会被成员 RLS 拒绝，**整批 insert 一起失败 → 本人始终没有成员记录** → 读写持续 403
- **修复**：
  1. **前端**：私聊创建成员改为**分别 upsert**，先保证本人是成员（`onConflict:'room_id,user_id'`、自我行永不阻塞），对方行单独 upsert 且失败静默。这样非房主打开既存私聊时能自愈补回自己成员身份
  2. **RLS**：`chat_messages_insert` 的 `WITH CHECK` 增加 `OR is_room_creator(room_id, app_user_id())`，与读取策略对齐，房主即使无成员记录也可发消息

#### 修改文件表
| 文件 | 说明 |
|------|------|
| `public/vendor/katex/dist/*` | 新增：KaTeX@0.16.9 本地静态资源（js/css/fonts/contrib） |
| `public/vendor/suneditor/dist/*` | 新增：SunEditor@2.45.1 本地静态资源（js/css） |
| `public/index.html` | SunEditor/KaTeX 引用改本地同源；KaTeX 加载器简化为同源顺序加载；私聊成员改分别 upsert 自愈 |
| `supabase-migration.sql` | `chat_messages_insert` 增加 `is_room_creator` 分支（幂等，可重跑） |
| `CHANGELOG.md` | 本记录 |

#### 验证记录
- [x] CDN 引用无残留（`suneditor@` / `katex@0.16.9` / 旧变量均无）
- [x] 本地 vendor 文件齐全（katex 81 文件含 fonts、suneditor js/css）
- [ ] 部署后刷新页面确认 KaTeX（公式）与 SunEditor（富文本）正常渲染、不再报 CORS/local-address-space 错误
- [ ] 部署后在 Supabase SQL Editor 重跑一次 `supabase-migration.sql`（幂等）；实测：两个账号互开私聊，非房主也能正常收发消息、不出现 403

---

## v5.10 — 2026-08-21

### 变更：Supabase 全部 SQL 整合为单一文件

#### 一、整合内容
将原本分散的 Supabase 脚本**全部合并进 `supabase-migration.sql`（唯一文件）**：
- `supabase-migration.sql`（基础：表结构 / 索引 / 外键 / 触发器 / Realtime / Storage / 开放 RLS）
- `supabase-security-fix.sql`（安全加固：开发者白名单 / 敏感列保护 / 读侧 RLS 收紧 / 写残留收紧 / 服务端门禁 RPC `verify_admission`、`get_admission_questions`、`get_admission_settings`、`redeem_invite` / 函数加固）
- `fix-chat-members-rls.sql`（私聊成员写入策略：允许 本人/房主/管理员 插入成员）

#### 二、本次合并的关键修正（重要）
1. **问卷表不再重置数据**：原先 `channel_questionnaires`/`channel_questionnaire_answers` 用 `DROP+CREATE`，重跑会清空已配置的问卷数据；已改为 `CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS` 补齐列，真正做到幂等不丢数据。
2. **修复辅助函数前置引用**：`app_user_id` / `is_channel_public` / `is_room_creator` / `is_room_member` / `is_room_admin` / `is_developer` 及 `developers` 白名单表统一前移到第 21.x 段（在所有 RLS 策略与门禁 RPC 之前），否则在全新数据库上执行到 `chat_messages_insert` 等引用函数的策略时会报"函数不存在"。
3. **恢复被上次合并遗漏的内容**：首次合并落下了一批安全内容，本次补齐——服务端门禁 RPC、`developers` 白名单、敏感列 `REVOKE SELECT`、读侧 RLS 收紧、`sign_auth_jwt`/`increment_unread` 撤销执行权限、`cleanup_old_chat_messages` 固定 `search_path`。
4. **改名策略重复执行报"已存在"修复**：`channel_join_requests` 的 4 个策略在加固段被从「任何人可插入/更新/删除入群申请」改名为 `join_requests_insert/update/delete`，但改名后的新策略名未在 `CREATE` 前 `DROP IF EXISTS`，导致整段脚本重复执行时报 `ERROR: 42710 policy "join_requests_insert" already exists`。已在每次 `CREATE POLICY "join_requests_*"` 前补同名 `DROP POLICY IF EXISTS`。经全量扫描，**共 82 个策略中所有同名重复创建均已有前置同名 DROP**，重复执行不再报"策略已存在"。
5. **cron 定时任务幂等**：每日清理旧消息的 `cron.schedule('cleanup-old-chat-messages', ...)` 改为「先 `cron.unschedule` 同名任务（异常忽略）再重建」，避免重复执行脚本时在 pg_cron 中堆积多个同名定时任务。

#### 修改文件表
| 文件 | 说明 |
|------|------|
| `supabase-migration.sql` | 整合三个 Supabase 脚本的全部内容；修正问卷表幂等创建；前移辅助函数；补齐遗漏的安全加固（RPC/白名单/读侧收紧/函数加固） |
| `supabase-security-fix.sql` | **已删除**（内容并入 `supabase-migration.sql`） |
| `fix-chat-members-rls.sql` | **已删除**（内容并入 `supabase-migration.sql`） |
| `AGENTS.md` | 目录结构说明同步：Supabase 增量脚本已并入唯一迁移文件 |
| `CHANGELOG.md` | 本记录 |

#### 验证记录
- [x] 三个源脚本的所有函数/RPC/策略均能在合并文件中找到唯一定义（逐项核对：`app_user_id`、`is_*`、4 个门禁 RPC、`sign_auth_jwt`、`REVOKE`、`developers` 等，各自仅定义一次）
- [x] 问卷表创建方式改为幂等，重跑不丢数据
- [ ] 部署后在 Supabase SQL Editor 整体粘贴执行一次，确认无报错、无数据丢失；实测入群密码/问卷/邀请码仍正常（`verify_admission`/`redeem_invite` RPC 可用）、私聊与群聊收发正常、私聊双方建房成员插入正常（部署后补）

---

## v5.9 — 2026-08-21

### 变更：修复重复发送 + 大幅降低会话接收延迟

#### 一、bug1 修复：连按发送键重复发送
- **根因**：`sendChatMsg` 是 async 函数，内部挂起（`await`）期间首次调用还没执行到禁用按钮，第二次调用又进入，导致重复插入消息
- **修复**：拆分外层 `sendChatMsg`（加发送锁 `window.__sendingMsg`）+ 内层 `doSendChatMsg`（实际逻辑）。外层用 `try/finally` 保证锁必然释放，发送期间任何后续 Enter/点击直接忽略

#### 二、bug2 修复：会话接收延迟高（基本 1 分钟收到一次）
- **根因**：消息到达依赖 Realtime 实时推送为主，但后台标签页/Realtime 断连时消息只能靠轮询兜底；而 v5.8 把轮询降到 后台 60s / 空闲 20s，导致后台期间消息延迟飙到近一分钟
- **修复**：
  1. **轮询频率回调到 活跃 5s / 空闲 15s / 后台 30s**（兼顾实时性与算力），Realtime 正常时近实时、失效时兜底也在几秒内
  2. **切回前台立即补拉**：`visibilitychange` 监听，页面由隐藏转可见且聊天打开时立刻触发 `pollNewMessages()`，避免后台丢失的消息要等最长 30s
  3. **Realtime 与轮询互补**：`handleRealtimeMessage` 收到新消息时重置轮询空闲计数为 0，让轮询保持活跃快速档
  4. **DB 侧加固 Realtime**：`chat_messages`、`chat_reactions` 设置 `REPLICA IDENTITY FULL`（幂等），确保 UPDATE/DELETE 的 postgres_changes 拿到完整旧行正确广播（编辑/撤回/删除实时同步）

#### 修改文件表
| 文件 | 说明 |
|------|------|
| `supabase-migration.sql` | `chat_messages`/`chat_reactions` 加 `REPLICA IDENTITY FULL`（幂等） |
| `public/index.html` | 发送锁防重（`sendChatMsg`+`doSendChatMsg`）；轮询频率 5/15/30s；前台补拉（visibilitychange）；Realtime 收到消息重置空闲计数 |
| `CHANGELOG.md` | 本记录 |

#### 验证记录
- [x] 5 个内联 `<script>` 块 `node --check` 语法检查通过（0 错误）
- [ ] 部署后实测：同一聊天快速连续按 Enter → 只发送一条；两个账号群聊互发消息，前台应近实时收到（秒级），后台切回前台立即补拉（部署后补）

---

## v5.8 — 2026-08-21

### 变更：调低聊天消息轮询频率（节省算力，实时性不受影响）

#### 背景
聊天消息此前有 Realtime 实时推送（INSERT/UPDATE/DELETE 订阅）为主通道，轮询仅作兜底。但轮询频率偏高（活跃 5s / 空闲 12s / 后台 30s），在无新消息时会持续空转消耗 Supabase 算力。

#### 调整
| 场景 | 原频率 | 新频率 |
|------|--------|--------|
| 活跃（正在聊天/刚收到消息） | 5s | 8s |
| 空闲（连续 3 次无新消息） | 12s | 20s |
| 后台标签页（页面不可见） | 30s | 60s |
| 首次进入会话 | 5s | 8s |

- 群聊实时性完全由 Realtime 推送保证，轮询仅作断线/失步时的兜底，降频不影响群聊可用性

#### 修改文件表
| 文件 | 说明 |
|------|------|
| `public/index.html` | `pollNewMessages` 自适应轮询频率：活跃 8s / 空闲 20s / 后台 60s；`startMessagePolling` 初始 8s；同步更新注释 |
| `CHANGELOG.md` | 本记录 |

#### 验证记录
- [x] 5 个内联 `<script>` 块 `node --check` 语法检查通过（0 错误）
- [ ] 部署后实测：群聊收发消息延迟无明显感知（Realtime 推送实时到达）；长时间无消息时轮询请求明显减少（DevTools Network 观察）（部署后补）

---

## v5.7 — 2026-08-18

### 变更：上线提醒实时化 + 全界面暗色模式修复 + 交互打磨

#### 一、上线提醒实时化（修复延迟高 / 不显示）
- **轮询间隔 30 秒 → 10 秒**，降低上线提醒延迟
- **移除 `document.hidden` 时暂停轮询**的逻辑，改为页面重新可见时立即补查一次（`visibilitychange` 监听）
- **新增 Supabase Realtime 订阅 `user_presence` 表**（`postgres_changes` 全事件监听），用户上线/下线即时推送，无需等待轮询周期
- 弹窗样式优化：左侧橙色渐变指示条 + 头像描边 + 平滑滑入动画

#### 二、暗色模式硬编码浅色修复（8 处）
- 修复 `index.html` 内联样式 8 处硬编码浅色（`#F7F8FC`/`#f9fafb`/`#f3f4f6`/`#FFF3ED`）→ 统一替换为 CSS 变量（`var(--bg-input)`/`var(--bg-hover)`/`var(--accent-bg)`/`var(--border-color)`）
- 覆盖范围：设置弹窗资料卡、功能开关行、消息表情 reaction 徽章、@提及自动补全 hover、频道设置静音行边框、准入设置 tab 下划线/激活态、问卷题目行

#### 三、交互打磨
- **消息入场动画**：记录上次渲染的消息 eid 集合，仅对新增消息应用 `.chat-msg-new` 淡入上移动画，避免整体重渲染时全部消息闪烁
- **移动端 safe-area**：底部 TabBar、侧边栏抽屉、遮罩层、右侧上下文面板适配 iPhone 底部安全区（`env(safe-area-inset-bottom)`）

#### 修改文件表
| 文件 | 说明 |
|------|------|
| `public/index.html` | 上线提醒 10 秒轮询 + Realtime 订阅（`subscribePresenceRealtime`/`handlePresenceRealtime`）；暗色模式 8 处硬编码颜色改 CSS 变量；消息入场动画（`_prevMsgEids` 对比 + `.chat-msg-new` 类） |
| `public/style.css` | `.online-notify` 弹窗样式优化；`.chat-msg-new` 入场动画 keyframes；移动端 safe-area 适配 |
| `supabase-migration.sql` | `user_presence` 表加入 Realtime 发布（幂等） |
| `CHANGELOG.md` | 本记录 |

#### 验证记录
- [x] 5 个内联 `<script>` 块 `node --check` 语法检查通过（0 错误）
- [x] CSS 花括号配平检查通过
- [ ] 部署后实测：A 用户上线 B 用户应在 10 秒内（或 Realtime 即时）看到弹窗；暗色模式下各弹窗/列表/徽章无刺眼浅色；新消息淡入动画正常（部署后补）

---

## v5.6 — 2026-08-18

### 变更：上线提醒弹窗 + 活动栏新消息红圈数字

#### 功能一：上线提醒
- 登录后每 30 秒轮询 `user_presence` 表（`last_seen` 5 分钟内视为在线），对比上次在线集合，**新上线**的用户弹出右下角短时通知（头像 + `@昵称 上线了`），3.2 秒后自动滑出消失
- **防轰炸**：首次加载仅记录当前在线集合不弹窗（避免登录时对已在线的用户集体弹窗）；同一用户离线后再上线可再次提醒
- **黑名单过滤**：黑名单用户上线不提醒
- 页面隐藏（`document.hidden`）时暂停轮询，避免后台空转

#### 功能二：活动栏红圈数字
- 活动栏（桌面端最左列 / 移动端底部 TabBar）各入口的未读提示由「红点」升级为「红圈数字」：
  - 好友栏 = 私聊未读 + 好友申请数
  - 频道栏 = 频道未读 + 入群申请数
  - 公告栏 = 未读公告数
  - 讲堂栏 = 未读博客通知数
- 数字超过 99 显示 `99+`；进入对应界面后清零隐藏
- 未读计数沿用既有 `chat_unread` 表（Supabase 触发器累加）+ 前端 `chatState.rooms.unread` 汇总

#### 修改文件表
| 文件 | 说明 |
|------|------|
| `public/index.html` | 上线提醒轮询/弹窗逻辑（`startOnlineNotify`/`pollOnlineNotify`/`showOnlineNotify`）；活动栏徽章改红圈数字（好友/频道/公告/讲堂）；`updateBlogActivityBadge` 统一讲堂未读数字 |
| `public/style.css` | `.online-notify-container`/`.online-notify` 弹窗样式与滑入动画；`.activity-badge` 数字徽章样式 |
| `CHANGELOG.md` | 本记录 |

#### 验证记录
- [x] 5 个内联 `<script>` 块语法检查通过（0 错误）
- [ ] 部署后实测：A 用户登录时 B 用户应看到「@A 上线了」弹窗；好友/频道/公告/讲堂有新内容时对应栏显示红圈数字，进入后消失（部署后补）

---

## v5.5 — 2026-08-16

### 变更：重做频道公告置顶条布局（固定于聊天顶栏下方）

#### 问题
频道公告置顶条（`channelAnnouncementBanner`）此前被 `insertBefore` 插入到消息列表容器 `chatMsgs` 的 firstChild，成为消息流的第一项，**随聊天记录一起滚动**；且切换频道/私聊后旧公告条从不移除，会残留显示。

#### 修复
1. **插入位置改为顶栏正下方**：公告条改为 `chatViewHeader.insertAdjacentElement('afterend', ...)`（与入群申请横幅 `channelJoinBanner` 同一模式），并加 `flex-shrink:0`，固定在顶栏与消息区之间，不随消息滚动。
2. **样式重做**：改为通栏固定条（`var(--accent-bg)` 背景 + 底部 accent 分隔线），左侧 📌 图标、中间标题（超长省略号截断）、右侧「点击阅读」。
3. **残留清理**：`loadMessages` 中无置顶公告或非频道时移除旧公告条；`switchRoom` 切换房间时先移除旧公告条，避免缓存渲染窗口期残留。

#### 修改文件表
| 文件 | 说明 |
|------|------|
| `public/index.html` | `loadMessages` 公告条重做（插入位置/样式/清理）；`switchRoom` 切换时清理旧公告条 |
| `CHANGELOG.md` | 本记录 |

#### 验证记录
- 5 个内联 `<script>` 块 `node --check` 语法检查通过
- 待部署后实测：进入有置顶公告的频道，公告条应固定在顶栏下方且不随消息滚动；切换到无公告频道/私聊，公告条应消失

---

## v5.4 — 2026-08-11

### 调研：moss TTS/STT 接入声网平台服务（轮10-1c）

#### 背景
MOSS（MOSI api.mosi.cn）TTS/STT 上游损坏，计划切换为声网平台服务（模型通过声网控制台选择，非 BYOK）：
- TTS：豆包（bytedance，325 音色）/ CosyVoice（cosyvoice，阿里云）/ MiniMax（minimax）
- STT：凤鸣（fengming，声网自研）/ 豆包流式 / Paraformer-v2（阿里云）/ 火山流式

#### 调研结论（实测）
1. **声网语音服务全部为 RTC 实时形态，无 HTTP 文件转写/合成 API**：
   - convoai（对话式 AI 引擎）：已开通（agents 列表 200 OK）；RTC 频道内实时对话，`join` 必填 `llm` 配置，TTS 输出在频道内，HTTP 拿不到音频文件
   - speech-to-text（实时转录翻译）：**未开通**（`ServiceNotEnabled`）；RTC 频道内实时转写，`join` 请求体 anyOf 仅 `rtcConfig` 变体，**无 URL/离线文件输入**（实测 url-only → `InvalidFieldValue`）
   - Voice Agent 产品线：WebSocket 流式（模型供应商直连）
2. **认证**（实测）：
   - HTTP Basic Auth（`base64(customerKey:customerSecret)`）→ 全部 `Invalid authentication credentials`（Customer Key/Secret 已失效或非本项目可用）
   - RTC Token（007，`Authorization: agora token="007..."`）→ 有效；凭证 = App ID `0353243e...` + App Certificate `d4c65781...`（已归档至 `amadeus/administrator/personal_data/agora-credentials.md`）
3. **形态不匹配**：moss 现状为 HTTP 转接端点（浏览器录音上传→文本 / 文本→音频文件），与声网 RTC 形态不匹配，**端点上游无法直接切换为声网 RESTful API**

#### 可行路线（待用户选择）
- **路线 A（RTC 改造）**：moss 前端集成 Agora Web SDK（RTC 推流麦克风）→ 控制台开通「实时转录翻译服务」→ `speech-to-text` agent 转写；TTS 经 convoai agent（需 LLM 配置）或流式通道。改造量大，且受控制台开通状态阻塞
- **路线 B（保持 HTTP 形态）**：moss 端点换用有 HTTP 文件形态的语音服务（如火山引擎豆包 TTS/流式 ASR、阿里云 DashScope Paraformer/CosyVoice、MiniMax 官方 API——均为 BYOK 直连，与「控制台选择非 BYOK」诉求不同）

#### 修改文件表
| 文件 | 说明 |
|------|------|
| `amadeus/administrator/personal_data/agora-credentials.md` | 新建：声网凭证归档（App ID / App Certificate / 认证方式实测 / 服务开通状态 / 形态限制） |
| `CHANGELOG.md` | 本记录 |

---

## v5.3 — 2026-08-11

### 变更：撤下 MOSS TTS 渠道（仅保留浏览器 TTS 朗读）

#### 背景
MOSS TTS 服务不可用，为避免界面出现不可用的渠道，从 Tavern 界面移除 MOSS TTS 相关入口与逻辑，只保留 Web Speech API 浏览器 TTS 朗读。

#### 修改文件表
| 文件 | 说明 |
|------|------|
| `public/tavern.html` | 移除「AI 声线设计」入口与提示、`voiceDesignModal` 弹窗、MOSS 音色数据（`MOSS_BUILTIN_VOICES`）与自定义音色管理函数、语音下拉 MOSS 分组、`speakText` 的 MOSS 分流、`speakTextMoss` 函数、`handleMossVoiceShareParam` 调用 |
| `CHANGELOG.md` | 本记录 |

#### 验证记录
- [x] 移除后仍保留：浏览器 TTS（`speechSynthesis`）朗读、STT 语音输入（含 MOSS STT 引擎选项）
- [x] 内联 `<script>` 7 个块 `node --check` 语法全部通过
- [ ] 部署后实测：TTS 设置页无 MOSS 入口，朗读按钮走浏览器 TTS 正常发声（部署后补）

---

## v5.2 — 2026-08-09

### 修复：即时私聊消息无法传送到对方 / 刷新读不到私聊记录

#### 问题现象
- 私聊发出消息对方收不到（本地乐观渲染后实际插入失败）
- 刷新页面后私聊房间/历史记录读不到
- 频道聊天正常（可发可收），仅私聊受影响
- 频道审批「通过」时提示「添加成员失败」

#### 根本原因（RLS 策略与前端成员插入不匹配）
- 前端 `openPrivateChatInFriends` 创建私聊房间时，**一次性插入两名成员**（`[{user_id: 我}, {user_id: 对方}]`）
- 但 `chat_room_members_insert` 策略（V1+V3 安全加固）为 `WITH CHECK (app_user_id() = user_id)`，**只允许给自己建成员记录**
- 插入「对方」那一行时请求者是本人 → 违反策略 → PostgREST 多行插入**原子回滚** → 私聊房间只有 `chat_rooms` 记录、**一条成员都没有**
- 而 `chat_messages_insert` / `chat_messages_read` 均要求「发送者/读者是房间成员」→ 消息插不进、读不出 → 对方收不到、刷新读不到
- 频道之所以正常，是因为频道成员由用户**自己加入**（单行 self-insert 通过策略）
- 同一过严策略还导致 `approveJoinRequest`（管理员替申请人插成员）失败

#### 修复内容
1. **RLS 策略**（`supabase-migration.sql`，并新增增量脚本 `fix-chat-members-rls.sql`）：`chat_room_members_insert` 放宽为「本人 OR 房间创建者 OR 频道管理员」可插入成员记录，与既有 update/delete 策略口径一致
2. **前端健壮性**（`public/index.html`）：私聊建房改用 `chat_rooms.upsert`（规避并发/历史残留 UNIQUE 冲突），成员插入补错误检查并打印日志，避免静默失败

#### 修改文件表
| 文件 | 说明 |
|------|------|
| `supabase-migration.sql` | 放宽 `chat_room_members_insert` 策略（本人/房主/管理员） |
| `fix-chat-members-rls.sql` | 新增增量脚本，仅改成员写入策略，免全量重跑（避免问卷表被重置） |
| `public/index.html` | 私聊建房 upsert + 成员插入错误检查 |
| `CHANGELOG.md` | 本记录 |

#### 验证记录
- [x] 改动内联 `<script>` `node --check` 语法通过（5/5）
- [ ] 部署后在 Supabase SQL Editor 执行 `fix-chat-members-rls.sql`，实测：新私聊建房后双方收发正常；刷新能读到历史；审批通过加人成功（部署后补）

---

## v5.1 — 2026-08-06

### 修复：聊天上传报「请先登录」(401) / 无扩展名图床链接不显示为媒体 / 上传超时健壮性

#### 修复 1：聊天上传图片/文件报「请先登录」(401)

- **根因**：站内 `/api/upload/tmpfile` 要求 JWT 登录态（`Authorization: Bearer dp_token`），但前端 `uploadImageToPicgo` / `uploadFileToTmpfile` / `uploadChatBgFallback` 三处调用均未携带 Authorization 头 → 后端返回 401，前端提示「请先登录」
- **修复**（`public/index.html`）：三处 `/api/upload/tmpfile` 调用统一补 `Authorization: Bearer dp_token`（与 `/api/upload/picgo` 一致）

#### 修复 2：聊天消息中无扩展名图床链接不显示为图片/视频/音频

- **根因**：`linkify()` 仅按「扩展名」识别媒体链接；粘贴 `https://img.scdn.io/xxx`（无扩展名）这类图床链接时识别失败，退化为普通超链接
- **修复**（`public/index.html`）：重写 `linkify()` —— ① 先剥离 query/hash 再判定；② `IMG_HOSTS` 已知图床域名白名单 + 扩展名双轨识别；③ 图片/视频/音频统一经 `imgProxyUrl` 代理加载（img-proxy 已放行 video/audio）；④ 图片带 `data-raw-url` 属性，点击调用 `openMediaViewer('image', rawUrl)` 查看原图；⑤ 新增 `imageFailToLink(raw)`：媒体加载失败自动回退为可点击超链接，不破版

#### 健壮性：上传请求超时控制

- `public/index.html`：tmpfile 三处上传（`AbortSignal.timeout(25000)`）+ img.scdn.io 直传（`AbortSignal.timeout(15000)`）统一加超时中止，避免网络异常时请求无限挂起

#### 修改文件表

| 文件 | 说明 |
|------|------|
| `public/index.html` | 三处 tmpfile 补 Authorization；`linkify` 重写（IMG_HOSTS 白名单 + 媒体内嵌 + openMediaViewer + imageFailToLink 回退）；上传超时控制 |
| `CHANGELOG.md` | 本记录 |

#### 验证记录
- [x] 全部改动内联 `<script>` `node --check` 语法通过（index 5/5）
- [ ] 部署后浏览器实测：聊天上传图片/文件成功；粘贴无扩展名图床链接显示为内嵌媒体；坏链回退超链接（部署后补）

---

## v5.0 — 2026-08-04

### 综合修复：聊天频道发送失败 / Tavern TTS·STT / 自定义 AI API 直连失败 / 站内 Workers AI 未连接 / 主题适配

#### 修复 1：聊天频道发不出消息（会话瞬时失效后永久卡死 + 公开频道 RLS 过严）

- **根因 A（前端）**：`sendChatMsg` 在 Supabase 插入报权限错误时直接 `__clearSupabaseSession()` 并提示「登录状态已失效」——若页面加载时首次 `setSession` 因网络波动瞬时失败（如浏览器 PNA/DNS 干扰），后续所有发送都会命中该分支，且无自动恢复，表现为「聊天频道发不了对话」
- **修复**：`__ensureSupabaseSession(force)` 新增强制刷新参数；`sendChatMsg` 遇到 RLS/权限错误时**先强制刷新会话并重试一次插入**，仍失败才清会话并给出具体错误提示
- **根因 B（RLS）**：`chat_messages_insert` 策略要求 `chat_room_members` 必有成员记录，而读取策略允许公开频道（`is_channel_public`）免成员读取——成员记录缺失时（加入流程中断等）能读不能发
- **修复**：`supabase-migration.sql` 中 `chat_messages_insert` 放宽为「本人 +（公开频道 OR 成员记录）」，与读取策略对齐；**已同步应用到线上 Supabase**

#### 修复 2：Tavern TTS 无法播放 + STT 麦克风被禁

- **根因**：全局 CSP 未声明 `media-src`，blob: 音频被 `default-src 'self'` 兜底拦截（控制台：`Loading media from blob:... violates CSP`）；`Permissions-Policy: microphone=()` 全局禁用了麦克风
- **修复**（`public/_headers`）：CSP 增加 `media-src 'self' blob: data: https:`、`img-src` 增加 `blob:`；`Permissions-Policy` 改为 `camera=(), geolocation=(), microphone=(self)`（仅同源页面可用麦克风，camera/geolocation 仍禁用）

#### 修复 3：Tavern 自定义 API / 智谱 / DeepSeek 直连失败（PNA/CORS）

- **根因**：浏览器 Private Network Access (PNA) 拦截——本机代理/DNS 把 `api.deepseek.com` 等 AI 域名解析成内网地址时，浏览器直接 fetch 报 `Permission was denied for this request to access the local address space`；智谱等渠道本身也无 CORS 响应头
- **修复**（`public/tavern.html`）：新增 `fetchRemoteApi()` 统一请求入口——直连失败（网络/CORS/PNA 错误）时**自动回退站内 `/api/proxy` 转发**（Cloudflare 后端发起请求，不受客户端 DNS 影响）；接入 `sendMessage` / `regenerateSwipe` / `continueGenerate` 三处远程 API 路径

#### 修复 4：站内 Workers AI（`cf:` / 站内 AI）未连接 + 模型收敛为便宜小模型

- **根因**：Cloudflare Pages 项目**未绑定 AI**（`ai_bindings: null`，API 实测确认），`/api/tools/ai` 返回 503「AI 服务未绑定」
- **修复（配置操作，非代码）**：Dashboard → doubao-plaza → Settings → Functions → **Bindings → Add → Workers AI**，变量名填 `AI`，保存后重新部署。可选：同时补 R2 绑定（`PAGES_BUCKET`，聊天上传兜底存储）
  - 注：已实测 REST API（`PATCH /pages/projects`）与 wrangler CLI 均无法添加 Workers AI 绑定（该接口仅支持已废弃的 Constellation 格式），必须在 Dashboard 操作
- **模型收敛（V5.0）**：站内 AI 相关模型统一改为便宜小模型，控制成本：
  - `functions/api/tools/ai.js` CF 白名单：移除 `@cf/deepseek/deepseek-r1-distill-qwen-32b`（32B 推理模型，成本高），保留 Llama 3.2-1B / 3B / Llama 3.1-8B-FP8，新增 `@cf/ibm-granite/granite-4.0-h-micro`
  - `functions/api/tools/registry.js`：AI对话默认模型 `@cf/zai-org/glm-4.7-flash` → `@cf/meta/llama-3.2-3b-instruct`（AI翻译保持 1B、AI总结保持 Granite Micro；AI画图保持 flux-1-schnell 为图片工具）
  - `public/tavern.html`：cf: 模型下拉移除 DeepSeek 32B、新增 Granite Micro；站内 AI 文案同步更新

#### 修复 5：聊天视频消息无法播放（img-proxy 拒绝视频）

- **根因**：`/api/img-proxy` 只放行 `image/*`，`video:` 消息的 `<video src>` 经代理转发后返回 502「非图片内容」
- **修复**（`functions/api/img-proxy.js`）：放行 `video/*` 与 `audio/*`；超时 15s→10s（坏图更快触发前端占位兜底）

#### 修复 6：Tavern 图床上传 403/401（img.remit.ee / sm.ms 停服）

- **根因**：img.remit.ee（403）与 sm.ms（401）已停止匿名/代理上传；`IMG_PROXY` 硬编码了绝对域名
- **修复**（`public/tavern.html` `uploadToImageHost`）：新增「站内上传」优先通道（`/api/upload/tmpfile` 服务端转发，登录 dp_token 即可）；代理地址改相对路径 `/api/proxy`；失效图床降级为兜底自动跳过

#### 修复 7：Tavern 主题色适配（结构性颜色变量化 + 嵌入跟随主站实际配色）

- 新增语义结构变量层 `--tv-page/--tv-panel/--tv-deep/--tv-hover/--tv-soft/--tv-ink/--tv-muted`（亮/暗双态默认值与原观感一致），自定义 CSS 中的暗色面板色（#2a2a3e/#1e1e2e/#3a3a4e 等）与蓝色残留 rgba(22,93,255,α) 全部改为变量 / `color-mix(in srgb, var(--acc) N%, transparent)`
- 预编译 Tailwind 的任意值类（`dark:bg-[#1e1e2e]` / `dark:bg-[#2a2a3e]` / `dark:bg-[#1a1a2e]`，共 40+ 处，含 JS 模板字符串）用高特异性规则 `html.dark .dark\:bg-[...]` 统一接管（文档中存在两份 bundle，同权重按序会压过覆盖块，故提升特异性）
- 嵌入模式跟随主站实际配色：主站 `syncTavernPrefs` 增推 `dark` 与 `palette`（读取 body 计算样式中的 `--bg-primary/--bg-secondary/--bg-tertiary/--bg-hover/--text-primary/--text-muted`）；tavern `syncEmbeddedFromParent` 接收后写 `--tv-*` 变量，暗色下面板色与主站完全一致（实测：#0f172a/#1e293b 系列生效）；`toggleTheme` 同步补调 `syncTavernPrefs`
- Tailwind Play CDN 生产警告静默（bundle 内 `console.warn` 文案替换）

#### 修复 8：Tavern 人格管理 UI 重做（原交互反人类）

- **编辑区上置**：编辑/新建表单从列表底部移到列表上方，打开时自动 `scrollIntoView` 滚入视野，并显示标题（「编辑人格：xxx」/「新建人格」）
- **头像快捷选择**：新增 22 个常用表情一键选择 + 实时预览框（输入框输入即时同步预览），不再要求手输 emoji
- **删除确认**：删除人格前弹 `confirm` 确认，避免误删；列表行头像改为圆角方块展示
- **当前人格指示**：弹窗头部新增「当前：xxx」徽标；使用中的人格行显示「使用中」标签（去掉暗色下蓝色残留 `dark:text-blue-400`）
- **交互增强**：Esc / 点击遮罩关闭弹窗；名称输入框回车直接保存；切换人格 toast 显示新人格名

#### 修复 9：cf: 模型发送无回复 / 500(3030)（Workers AI 流式格式升级 + 内容安全过滤）

- **根因 A（无回复）**：Workers AI 流式 chunk 实际可能是对象（`{response}` 或 OpenAI 兼容 `{choices:[{delta:{content}}]}`）、原始 SSE 字符串或二进制 Uint8Array；旧解析只读 `chunk.response` → 内容全丢、只剩 `[DONE]`
- **修复 A**（`functions/api/tools/ai.js`）：TransformStream 全类型兼容——字符串/Uint8Array 解码/对象 `response`/`choices[0].delta.content`，SSE 行（`data: {...}`）自动解析提取
- **根因 B（500/3030）**：Workers AI 内容安全过滤（NSFW）拦截角色扮演输入，`env.AI.run` 抛 `(code 3030)` → 500
- **修复 B**（`public/tavern.html` `friendlyApiError`）：3030 映射为「内容被 Workers AI 安全过滤拦截，请调整措辞或换用自定义 API」；5007（模型不存在）一并映射

#### 修复 10：Tavern 弹窗全透明 + 主题色残留

- **弹窗透明根因**：`.modal-card` 类被 5 个弹窗（人格/世界书/设置等）使用，但**全文件无任何 CSS 定义** → 弹窗背景透明
- **修复**：主题层补 `.modal-card` 亮/暗双态样式（白底 / `var(--tv-panel)` + 圆角 + 阴影）
- **主题色残留**：设置区 Cloudflare 提示框 4 处 `orange-*` 硬编码 → `var(--acc)`/`color-mix`；15 处 `dark:text-blue-400`（角色列表/人格行）→ 统一走 `text-primary`（var(--acc)）
- 注：线上 `/tavern` 文件的 `bg-primary` 已是 var(--acc)（实测部署文件仅 1 条规则）；用户端看到固定橙色多为浏览器缓存旧版，强制刷新即可

#### 修复 11：MOSS 自定义音色：分享 / 导入 / 下载

- **分享**：自定义音色列表新增「分享」按钮 → 复制 `tavern.html?mossVoice=<voice_id>&mossVoiceName=<name>` 分享链接；他人打开链接自动导入该音色并清理地址栏参数
- **导入**：声线设计弹窗新增「导入他人分享的音色」输入框，支持粘贴分享链接或裸 voice_id（UUID 自动识别），导入后自动出现在自定义列表与语音下拉
- **下载**：声线生成试听区新增「下载音频」按钮（blob 直下 mp3）

#### 修复 12：聊天 tmpfile 文件预览连不上

- **根因**：`file:` 消息的 tmpfile.link iframe 预览 src 走了 `/api/img-proxy`，而 img-proxy 只转发媒体类型、拒绝 HTML 页面 → 预览恒 502
- **修复**（`public/index.html`）：iframe 改为直连 tmpfile.link 原地址（tmpfile.link 服务本身在线，实测 200）

#### 修复 13：Tavern 嵌入 iframe 重定向丢失 embed 参数 + 主题色缓存

- **根因**：线上 `/tavern.html` 被 308 永久重定向到 `/tavern`，且 `Location` **丢弃查询参数**（`?embed=1` 丢失）→ 嵌入模式样式不生效
- **修复**（`public/index.html`）：两处 iframe src 改为 `/tavern?embed=1`（直连无重定向，参数保留）
- **主题色缓存说明**：线上 `/tavern` 文件 `bg-primary` 已确认 var(--acc)（唯一规则）；用户端看到 `rgb(255 107 53)` 硬编码为浏览器/边缘缓存旧版，强制刷新（Ctrl+Shift+R）即可；iframe URL 变更后自然带新缓存键

#### 修改文件

| 文件 | 说明 |
|------|------|
| `public/_headers` | CSP `media-src`/`img-src` blob + `Permissions-Policy` microphone=(self) |
| `public/index.html` | `__ensureSupabaseSession(force)` + `sendChatMsg` 失败重试；`syncTavernPrefs` 推送 dark/palette；`toggleTheme` 补调；tmpfile 预览直连 |
| `public/tavern.html` | `fetchRemoteApi` 代理回退 ×3；`uploadToImageHost` 站内优先；`--tv-*` 主题变量层 + 嵌入调色板同步；人格 UI 重做；`.modal-card` 补样式；orange/blue 残留清理；MOSS 音色分享/导入/下载；模型下拉收敛；Tailwind 警告静默 |
| `supabase-migration.sql` | `chat_messages_insert` 公开频道免成员记录（已同步线上） |
| `functions/api/img-proxy.js` | 放行 video/audio；超时 10s |
| `functions/api/tools/ai.js` | CF 模型白名单收敛为便宜小模型；流式解析兼容 `choices[0].delta.content` |
| `functions/api/tools/registry.js` | AI对话默认模型改 Llama 3.2-3B |
| `TOOL_FRAMEWORK_GUIDE.md` | 示例模型同步更新 |
| `CHANGELOG.md` | 本记录 |

#### 验证记录
- [x] JWT 全链路线上实测：D1 session → `/api/refresh-supabase-token` → Edge Function `sign-jwt` → ES256 token（含 `app_metadata.d1_user_id`）200 通过
- [x] 浏览器端到端实测：加入公开频道 → 发送消息成功入库（测试账号/消息已清理）；页面加载时首次 `setSession` 瞬时失败场景可复现，重试逻辑已覆盖
- [x] 主题适配 Playwright 本地实测：暗色 + 模拟主站调色板推送 → chatHeader/moreMenu/sidePanel/.modal 计算样式分别为 #0f172a/#1e293b（与主站一致）；默认（无父页面）回退原 #1e1e2e/#2a2a3e 观感不变
- [x] 全部改动文件内联 `<script>` / Functions 文件 `node --check` 语法通过（tavern 7/7、index 5/5、后端 5/5）
- [ ] 部署后浏览器实测：TTS 播放、STT 麦克风、自定义 API 直连失败回退代理、主题色跟随（部署后补）

---

## v4.13 — 2026-08-04

### Tavern Cloudflare 模型免密钥（改走站内 Workers AI 端点）

#### 变更

1. **Cloudflare 模型不再需要 Account ID / CORS 代理**：此前 tavern 的 `cf:` 模型需填写 Cloudflare Account ID 并拼 `{ACCOUNT_ID}/ai/run/...` 远程地址；现改为由本站后端 `/api/tools/ai`（`env.AI` Workers AI 绑定）直接提供，登录逗包广场（`dp_token`）即可使用，无需填写任何密钥或 Account ID
2. **后端 `/api/tools/ai` 新增模型覆盖参数**：`ai.js` 增加 CF 模型白名单校验，支持 `model`（覆盖默认模型）、`messages`（消息数组直传，替代原 message/history 二参数）、`max_tokens` 透传；非白名单模型走原站内 AI 路径保持兼容
3. **tavern 三处请求路径接入新端点**：`sendMessage` / `regenerateSwipe` / `continueGenerate` 新增 `provider === 'cloudflare'` 分支，POST `/api/tools/ai` 携带 `dp_token` + `model` + `messages` + `max_tokens`，流式解析复用站内 AI 的 `{text}` 格式
4. **设置面板 UI 更新**：`gmCloudflareWrap` 改为免密钥说明（移除 Account ID 输入字段）；`needsProxy` 仅 NVIDIA 需 CORS 代理（cloudflare 不再需要）；保存/读取对旧配置做判空兼容

#### 修改文件

| 文件 | 说明 |
|------|------|
| `functions/api/tools/ai.js` | CF 模型白名单 + `model` / `messages` / `max_tokens` 参数支持（V4.13） |
| `public/tavern.html` | `API_PROVIDERS.cloudflare` 免密钥化 + 设置面板说明 + 三处请求路径新增 cloudflare 分支 |
| `CHANGELOG.md` | 本记录 |

#### 验证记录
- [ ] `node --check` ai.js 语法通过
- [ ] tavern 选择 `cf:` 模型 → 设置面板显示「本站提供 · 免密钥」，无 Account ID 输入框、无 CORS 代理框
- [ ] tavern 登录后发送消息 / 重新生成 / 继续生成均走 `/api/tools/ai` 正常流式输出
- [ ] 未登录使用 `cf:` 模型 → 提示「请先在逗包用户广场登录」

---

## v4.12 — 2026-08-04

### 修复 Tavern 外部 AI API 被全局 CSP 拦截 + 主题色全面跟随主题变量

#### 修复

##### 1. 外部 AI API（智谱 / 自定义 / DeepSeek 等）被 CSP 拦截 —— 彻底解决
- **根因**：全局 `_headers` 的 CSP `connect-src` 仅白名单 supabase / 翻译 / 图床 6 个域名，**不含任何 AI 提供商**；tavern 的智谱（`open.bigmodel.cn`）与「自定义 API」（任意域名）设计为浏览器直连（`corsProxy:''`），被拦截时浏览器报 `Refused to connect because it violates the document's Content Security Policy`
- **修复**：`public/_headers` 全局 CSP `connect-src` 由域名白名单放宽为 `'self' https: wss:`——允许任意 https（含自定义 API 任意域名）与 wss 连接，同时消除 v4.11 遗留的「嵌入模式外部 AI 直连被拦」已知限制
- 主站页面安全不受影响：`default-src 'self'`、`script-src` 白名单等其余指令保持原样；`frame-ancestors 'self'` 也保留（防止跨站嵌入）

##### 2. 主题色切换不同步 tavern 嵌入页 —— 断链补齐
- **根因**：主站 `setThemeColor()` 仅写 localStorage + 切 body 类，**未调用 `syncTavernPrefs()`**，导致 tavern iframe 收不到主题色变更推送
- **修复**：`setThemeColor()` 末尾补调 `syncTavernPrefs()`（该方法本已发送 `dp_theme_color` → iframe `syncEmbeddedFromParent` → `applyThemeColor` 写入 `--acc`/`--acc2`），主站切主题色后 tavern 立即跟随

##### 3. tavern 大量颜色不随主题色变化 —— 硬编码全面变量化
- **根因（三层）**：
  1. 自定义 CSS 中 **41 处硬编码 `#FF6B35`**（主色）与 16 处 `#FF8F5E`（暗色变体）——只跟随默认橙色，不跟 `--acc`/`--acc2`
  2. **预编译 Tailwind 的 `primary` 色是蓝色 `rgb(22 93 255)`（#165DFF）**，`tailwind.config`（`primary:'#FF6B35'`）是死代码（tavern 无 Tailwind CDN/运行时，L24 的 bundle 无 tailwind 引擎符号）——`bg-primary` 头部、`text-primary` 图标、hover/focus/dark 变体等 10 条规则全部是蓝色
  3. `#FFF1E8`（浅橙背景 6 处）与 `rgba(255,107,53,α)`（阴影/浅底 11 处）同样硬编码
- **修复（tavern.html 共 76 处 + 编译块 10 处）**：
  - 自定义 CSS 硬编码纯色 → `var(--acc)` / `var(--acc2)`；`#FFF1E8` → `color-mix(in srgb, var(--acc) 10%, #fff)`
  - `rgba(255,107,53,α)` → `color-mix(in srgb, var(--acc) N%, transparent)`；`rgba(255,143,94,α)` → 同上用 `var(--acc2)`
  - 预编译 Tailwind 块内 10 条 primary 规则：`rgb(22 93 255 / ...)` / `#FF6B35` 全部替换为 `var(--acc)` / `color-mix(in srgb, var(--acc) N%, transparent)`（含 `.bg-primary`、`.text-primary`、`.hover:bg-primary/90`、`.focus:ring-primary/30`、`.dark:bg-primary/20` 等）
  - **保留不动**：`:root { --acc: #FF6B35; --acc2: #FF8F5E }` 默认定义、`THEME_ACCENTS` 六色映射数据、登录墙独立文档（L16）与 bundle（L24）内硬编码、`tailwind.config` 死代码
  - 运行时代码 10 处 `style.color` 红/绿/黑/白（状态指示、语音按钮）为语义色，不随主题，保留

#### 修改文件

| 文件 | 说明 |
|------|------|
| `public/_headers` | CSP `connect-src` 放宽为 `'self' https: wss:`（外部 AI API / 自定义 API 可直连） |
| `public/index.html` | `setThemeColor()` 补调 `syncTavernPrefs()` 推送主题色到 tavern iframe |
| `public/tavern.html` | 76 处自定义 CSS 硬编码色 + 预编译 Tailwind 10 条 primary 规则全部变量化（`var(--acc)`/`var(--acc2)`/`color-mix`） |
| `CHANGELOG.md` | 本记录 |

#### 验证记录
- [ ] 部署后 `curl -I` 验证两域名 CSP 头含 `connect-src 'self' https: wss:`
- [ ] tavern 嵌入主站：切任一主题色（蓝/绿/紫…）→ 头部 / 按钮 / 链接 / hover 颜色跟随变化，暗色模式 `--acc2` 变体同步
- [ ] tavern 设置-模型配置：智谱 / 自定义 API 发送消息不再报 CSP Refused to connect

---

## v4.11 — 2026-08-04

### Tavern 嵌入模式修复（主题同步 / CSP / 站内 AI 免密钥）+ 人格 UI 优化

#### 修复

##### 1. Tavern 嵌入主站时主题色不同步
- tavern 新增 `:root { --acc: #FF6B35; --acc2: #FF8F5E }` 平台化主色调变量，`button.bg-primary` 由硬编码 `#FF6B35` 渐变改为 `linear-gradient(135deg, var(--acc), var(--acc2))` + `color-mix` 阴影
- 新增 `THEME_ACCENTS`（orange/blue/green/purple/pink/cyan 六色映射）+ `applyThemeColor(colorId)`（写入 `--acc`/`--acc2`）
- `syncEmbeddedFromParent` 接收主站 `themeColor` 并应用；主站 `syncTavernPrefs` 发送 `dp_theme_color`（默认 orange）——嵌入时主题色与主站完全一致

##### 2. Tavern 嵌入时 CSP 阻断外部 AI API（智谱 / NVIDIA / 站内对话）
- **结论（v4.11.1 回滚）**：Cloudflare Pages 在静态文件层面**无法对单个文件单独放宽 CSP**——
  - `_headers` 的 `/tavern.html` 路径规则线上验证**不生效**：`_headers` 对同一 header 在多个匹配规则中采用「值逗号拼接」合并语义，多 CSP 策略被浏览器同时强制执行 = 取交集 = 最严格策略仍生效，无法单独放宽
  - 尝试 `functions/tavern.html.js`（`env.ASSETS.fetch()` 取回静态资源后在函数内覆写 CSP，`_routes.json` include 加入 `/tavern.html`）→ **上线后该路径返回 404**：路径一旦被 Function 路由接管，`env.ASSETS.fetch()` 无法再取回同名静态资源，页面直接打不开
  - **已回滚**：删除 Function、还原 `_routes.json`，tavern.html 恢复为纯静态托管，继续使用全局 CSP
- **最终影响**：嵌入模式下**站内 AI（`st:ai_chat`，同源 `/api/tools/ai`）不受影响**，可正常使用；仅「外部 AI 直连」（SiliconFlow / OpenRouter 等跨域 API）在嵌入时仍被全局 CSP 的 `connect-src` 拦截，属已知限制——需跨域调用时请使用可 CORS 直连的提供商或改走站内 AI

##### 3. 新增「站内 AI」提供商（免密钥）
- gmModel 下拉最前新增 `⚡ 站内AI（本站·免密钥·推荐）` → `st:ai_chat`
- `getProviderInfo` 识别 `st:` 前缀 → provider `site`
- `API_PROVIDERS.site` 配置（apiBase `/api/tools/ai`，免密钥说明文案）
- `sendMessage` 新增站内 AI 分支：走 `POST /api/tools/ai`（`tool_id: ai_chat` + `buildRequestMessages` 历史 + `Bearer dp_token`），SSE 流式解析（`data: {text}` + `[DONE]`），未登录时报错提示
- gmModel change 处理器：选择站内 AI 时自动隐藏 API 地址 / API Key 配置框

##### 4. 人格设置 UI 优化
- 人格列表整行可点击切换（原仅有小圆点按钮），悬停高亮
- 编辑 / 新建人格时名称输入框自动聚焦

#### 修改文件

| 文件 | 说明 |
|------|------|
| `public/tavern.html` | 主题变量 / 站内 AI 提供商 / 人格 UI / onVirtualScroll 残留清理 |
| `public/index.html` | `syncTavernPrefs` 发送 themeColor |
| `CHANGELOG.md` | 本记录 |

> **v4.11.1（已回滚）**：曾新增 `functions/tavern.html.js` 并在 `_routes.json` include 加入 `/tavern.html` 以放宽 tavern 的 CSP，上线后该路径 404（Function 路由接管后 `env.ASSETS.fetch()` 无法取回同名静态资源），已删除并还原 `_routes.json`，详见上方「结论（v4.11.1 回滚）」。

---

## v4.10 — 2026-08-04

### Tavern 接入 MOSS 高质量音色（TTS/STT/声线设计）+ 气泡操作栏重设计 + 嵌入同步

#### 新增功能

##### 1. MOSS AI 语音能力（tavern）
- **TTS 高质量朗读**：语音设置新增「MOSS 高质量音色（AI）」分组（15 个官方内置音色，硬编码兜底，`GET /audio/voices` 上游偶发 502 时仍可选）；选择 `moss:` 前缀音色后朗读自动走 `/api/moss/tts`（moss-tts 模型），支持点击再停、多音色切换、Markdown 清理
- **STT AI 语音输入**：语音输入设置新增引擎选择（浏览器免费 / MOSS AI 更准确）+ 识别语言 + 连续识别；MOSS 引擎走 MediaRecorder 录音 → multipart 上传 `/api/moss/stt`（moss-transcribe 模型），识别结果自动填入输入框
- **AI 声线设计弹窗**：设置面板新增「AI 声线设计」入口；输入试听文本 + 一句话声音风格描述 → 调 `/api/moss/voice-generations`（moss-voice-generator）生成音频试听 → 「保存为音色」把预览音频上传 `/api/moss/voices`（multipart audio_sample）创建可复用 voice_id → 存入 localStorage（`tavern_moss_voices`），自动出现在语音下拉并可设为朗读音色；弹窗内可选用/删除自定义音色
- 后端新增 4 个 MOSS 转接端点（密钥仅存后端 env `MOSS_API_KEY`，前端不暴露）：
  - `functions/api/moss/tts.js` — 文本转语音（`POST /api/moss/tts`，audio 模式返回音频二进制）
  - `functions/api/moss/stt.js` — 语音转文本（`POST /api/moss/stt`，multipart `file` 字段）
  - `functions/api/moss/voices.js` — 音色列表 GET + 创建音色 POST（multipart audio_sample）
  - `functions/api/moss/voice-generations.js` — 声线设计生成（input + instruction，url/audio 两种 delivery_method）

##### 2. 频道气泡操作栏重设计（index.html）
- 消息时间戳常驻显示，操作按钮（翻译/回复/表情）悬停或触屏时淡入显示，主界面更清爽
- 新增 🌐 翻译一级快捷按钮（高亮样式），一键调用现有翻译服务；编辑/撤回收进 ⋯ 更多菜单
- 触屏设备（`@media (hover:none)`）操作栏常驻，保证移动端可用

##### 3. Tavern 顶部工具栏精简
- 头部高频操作只留「主题 / 设置 / 新建角色」，导入 / 链接导入 / 构建 / 导出 / 人格收进「更多」下拉菜单（点击外部或 Esc 关闭）

##### 4. Tavern 嵌入主站主题/背景/字体同步
- tavern 新增 `syncEmbeddedFromParent`（同源直调）：接收主站聊天背景图（`dp_chat_bg`）与字体族并实时应用，无主站背景时恢复自身配置
- 主站新增 `syncTavernPrefs`：iframe 加载完成与聊天背景变更（`applyChatBackground`）时自动推送；两条嵌入路径（页面工具 / 工具面板覆盖层）均绑定

#### 修改/新增文件

| 文件 | 说明 |
|------|------|
| `functions/api/moss/tts.js` | **新增** — MOSS 文本转语音转接端点 |
| `functions/api/moss/stt.js` | **新增** — MOSS 语音转文本转接端点（multipart file） |
| `functions/api/moss/voices.js` | **扩展** — 新增 POST 创建音色（multipart audio_sample） |
| `functions/api/moss/voice-generations.js` | **新增** — MOSS 声线设计生成端点 |
| `public/tavern.html` | MOSS 内置音色列表 + TTS/STT/声线设计设置区 + 相关 JS；顶部工具栏「更多」下拉；`syncEmbeddedFromParent` |
| `public/index.html` | 气泡操作栏重设计（时间戳 + 悬停操作栏 + 翻译快捷入口）；`syncTavernPrefs` + iframe 同步绑定 |
| `public/style.css` | `.chat-msg-actions` / `.chat-msg-action-translate` / `.chat-msg-time-text` / 触屏常驻规则 |
| `CHANGELOG.md` | 本文档 |

#### 验证记录
- 后端 4 个 MOSS 端点 + 既有 translate/stream：`node --check` 语法通过；MOSS 密钥仅存后端，前端无泄漏
- MOSS TTS：真实调用 200（audio/mpeg 音频返回）；STT：multipart 上传真实调用成功返回转写文本
- 声线设计闭环：真实调用验证 生成（voice-generations 200 + 音频URL）→ 下载 → 创建音色（voices POST 200 + voice_id）→ 用该 voice_id TTS 朗读 200 全链路通过
- 内置音色：以官方文档 15 个真实 voice_id 硬编码兜底（`GET /audio/voices` 上游偶发 502 时仍可选）
- tavern/index 全量 `<script>` 提取 `node --check` 通过

---

## v4.9 — 2026-08-04

### Tavern 体验升级：云盘导入助手 + 主题色对齐 + 背景/质感 + 统一转接层

#### 新增功能

##### 1. 飞书云盘链接导入助手
- tavern 粘贴链接时自动检测飞书云盘链接（`feishu.doubao.com/drive/file/...`），弹出导入助手弹窗
- 助手内 iframe 匿名渲染云盘 JSON 内容（解决跨域只读限制），用户复制后粘贴 JSON 一键解析导入角色卡
- 支持 `chara_card_v2` 标准格式解析

##### 2. 统一转接层（tavern 网络工具封装）
- 新增 `functions/api/tools/fetch.js` — 统一内容获取端点（`GET /api/tools/fetch?url=...`）：
  - **SSRF 防护**：复用 `/api/img-proxy` 的 `isPrivateHost` 检测，拒绝内网/保留地址
  - **大小限制**：最大转发 20MB
  - **超时控制**：15 秒未响应自动中止（AbortController）
  - **CORS 透传**：附加 `Access-Control-Allow-Origin: *`，跨域可用
- tavern 链接导入策略1 从无防护的 `/api/proxy?url=`（AI API 专用，含密钥注入）切换到统一转接层，失败时仍回退 allorigins → 直连

#### 修改/新增文件

| 文件 | 说明 |
|------|------|
| `functions/api/tools/fetch.js` | **新增** — 统一内容获取端点（SSRF 防护 + 20MB + 15s 超时） |
| `public/tavern.html` | 云盘链接检测 + 导入助手弹窗；导入策略切换至 `/api/tools/fetch`；主题色全量对齐平台橙色（`#165DFF`→`#FF6B35`、`#3b82f6`/`#93c5fd`/`#60a5fa`→`#FF8F5E`、`#eff6ff`/`#f0f5ff`→`#FFF1E8` 等 68 处）；主按钮渐变质感（`linear-gradient(135deg,#FF6B35,#FF8F5E)` + 悬浮动效）；背景设置实测确认（默认/纯黑/纯白/自定义 URL + 图床三级回退） |
| `README.md` | 项目结构新增 `tools/fetch.js`；Tavern 章节新增「统一转接层（内容获取）」说明 |

#### 验证记录
- 飞书云盘导入助手：Playwright 实测粘贴 `chara_card_v2` JSON → 解析导入 → 角色列表新增成功
- 主题色：亮/暗/hover 三态全橙、蓝色残留 0、JS 7/7 `node --check` 通过
- 背景设置：纯黑 → `rgb(0,0,0)`、自定义 URL → `backgroundImage` 均实测生效
- UI 质感：11 个主按钮渐变生效，消息气泡/顶栏/进度条保持纯色不受影响
- 统一转接层：`node --check` 语法通过

---

## v4.8 — 2026-07-29

### 小肥羊讲堂（博客系统）+ 工具框架升级 + IP注册限制

#### 新增功能

##### 1. 同IP注册数量上限限制
- 在原有的「同IP每小时5次」频率限制基础上，新增「同IP最多10个账号」总数限制
- 修改文件：`functions/api/users.js`

##### 2. 小肥羊讲堂（博客系统）
- **博客列表页**：知乎风格卡片布局，支持搜索、封面图、标签、阅读量显示
- **博客阅读页**：文章正文（HTML渲染）+ 作者信息 + 标签 + Matrix房间链接 + 评论区
- **博客编辑器**：标题、封面图URL、摘要、正文（支持HTML）、标签（逗号分隔最多5个）
- **评论系统**：任何已登录用户可评论，评论作者/博客作者/开发者可删除
- **公告系统**：开发者可发布/删除公告，公告在博客列表页顶部以横幅展示
- **权限模型**：开发者=全权管理，博客作者=管理自己的文章和评论，普通用户=阅读和评论
- **Matrix集成**：博客发布时自动通过 Matrix Client-Server API 发送到指定房间（需配置 `MATRIX_ACCESS_TOKEN` 环境变量，未配置时静默跳过）

##### 3. 工具框架升级 — 新增 `page` 类型工具
- 新增 `api_type: 'page'` 工具类型，支持独立子页面工具
- `openToolPanel()` 函数新增 page 类型分发逻辑：检测 `page_handler` 字段并调用对应前端渲染函数
- 博客系统作为首个 page 类型工具注册（id: `xfy_blog`，page_handler: `renderBlogPage`）

##### 4. 可扩展工具框架文档
- 新增 `TOOL_FRAMEWORK_GUIDE.md` — 完整的工具框架扩展教程
- 涵盖5种工具类型（ai_chat/ai_image/proxy_get/direct_url/page）的添加方法
- 包含工具定义字段说明、input_fields类型、result_type渲染类型

#### 数据库变更
- 新增 `blog_posts` 表：博客文章（标题、内容、摘要、封面图、标签、作者信息、浏览量、Matrix事件ID）
- 新增 `blog_comments` 表：评论（支持嵌套回复、置顶）
- 新增 `blog_announcements` 表：公告（开发者发布、置顶）
- 需在 D1 Console 中执行 `schema.sql` 中新增的建表语句

#### 新增文件
- `functions/api/blog.js` — 博客列表查询 + 创建（含Matrix发布）
- `functions/api/blog/[id].js` — 单篇博客 CRUD
- `functions/api/blog/comments.js` — 评论管理
- `functions/api/blog/announce.js` — 公告管理（仅开发者）
- `functions/api/blog/publish.js` — 重新发布到Matrix
- `TOOL_FRAMEWORK_GUIDE.md` — 工具框架扩展教程

#### 修改文件
- `schema.sql` — 新增 blog_posts/blog_comments/blog_announcements 建表语句
- `functions/api/tools/registry.js` — 新增 xfy_blog 工具定义（page类型）
- `public/index.html` — 新增 openToolPanel page类型支持 + 完整博客前端UI
- `README.md` — 更新项目结构和功能清单

---

## v4.7 — 2026-07-28

### 网站工具包系统（AI工具 + 免费API工具）

#### 新增功能

##### 1. 工具注册表（Tool Registry）

**实现**：`functions/api/tools/registry.js` 统一管理所有工具定义，包含 12 个工具：
- AI 类（4个）：AI对话、AI翻译、AI总结、AI画图（基于 Cloudflare Workers AI）
- 免费 API 类（8个）：天气查询、二维码生成、IP查询、汇率查询、随机笑话、每日名言、头像生成、数学计算

##### 2. AI 工具端点（`functions/api/tools/ai.js`）

- 统一处理 AI 文本对话（SSE 流式输出）和图片生成
- 基于 Cloudflare Workers AI 绑定（`env.AI`），支持 `@cf/zai-org/glm-4.7-flash`、`@cf/meta/llama-3.2-1b-instruct`、`@cf/black-forest-labs/flux-1-schnell` 等模型
- 速率限制：每用户每小时 30 次（基于 `site_settings` 表）
- Bearer Token 鉴权

##### 3. 代理转发端点（`functions/api/tools/proxy.js`）

- 转发免费公共 API 请求，避免前端 CORS 限制
- 支持模板 URL（`{param}` 占位符）和查询参数两种模式
- 天气工具内置地理编码前处理（城市名 → 经纬度）
- 带超时控制（10秒）

##### 4. 开发者界面第三种创建方法：网站工具

- 功能管理界面新增「网站工具」链接类型
- 开发者可从工具注册表中选择工具，创建为功能卡片
- `features` 表扩展 `tool_type`、`tool_config` 列
- 功能卡片显示工具图标 + "工具" 标签

##### 5. 工具面板系统（前端）

- 点击工具类功能卡片 → `openToolPanel()` 打开交互式面板
- 动态渲染输入表单（文本框、下拉框、文本域）
- AI 文本工具：SSE 流式输出，逐字显示，带光标动画
- AI 图片工具：生成后显示图片 + 下载按钮
- 天气工具：渲染天气卡片（当前天气 + 3天预报）
- 汇率工具：渲染表格
- 支持 6 种结果类型：`streaming_text`、`image`、`weather_card`、`json_card`、`table`、`text`

##### 6. AI 对话历史本地缓存

- AI 对话历史存储在浏览器 `localStorage`（`dp_ai_history_{toolId}`），不占用 D1 数据库空间
- 保留最近 10 轮对话（20条消息），支持清空
- 仅 `supports_history: true` 的工具启用多轮上下文

#### 数据库变更

- `features` 表新增 `tool_type TEXT`、`tool_config TEXT` 列
- 移除 `ai_conversations` 表（改为 localStorage 存储）

#### 文件变更

- 新增：`functions/api/tools/registry.js`、`functions/api/tools/ai.js`、`functions/api/tools/proxy.js`
- 删除：`functions/api/tools/ai-history.js`
- 修改：`public/index.html`（工具面板系统、功能卡片支持工具类型、本地AI历史）
- 修改：`public/style.css`（AI消息样式、工具面板样式）
- 修改：`schema.sql`（移除 ai_conversations 表）
- 修改：`functions/api/chat/index.js`（移除 ai_conversations 迁移）
- 修改：`functions/api/features.js`（支持 tool_type/tool_config）

#### 部署要求

1. 在 Cloudflare Dashboard → Settings → Functions → AI bindings 中配置 AI 绑定（变量名 `AI`）
2. 执行 `schema.sql` 中的工具包迁移语句（如已有数据库）

---

## v4.6 — 2026-07-28

### 公开频道管理 + 频道公告权限深度修复 + 开发者界面新增标签

#### 新增功能

##### 1. 公开频道管理（开发者后台）

**需求**：开发者可以从现有频道中选取特定频道作为"公开频道"，无需用户手动加入即默认显示在所有用户的频道列表中，并支持独立的公开频道分组管理。

**实现**：
1. Supabase 新增 `public_channels` 表（`id`, `room_id`, `group_name`, `sort_order`, `created_at`），含索引和 RLS 策略（所有人可读，开发者可写）
2. 开发者界面新增「📡 公开频道」标签页（第5个标签）
3. 管理界面展示所有频道列表，可通过勾选框将频道设为/取消公开
4. 公开频道支持分组管理：新建分组、为公开频道选择分组、删除分组（删除后频道归入"默认分组"）
5. `loadRoomList` 中获取公开频道数据，过滤掉用户已加入的频道后存入 `chatState.publicChannels`
6. `renderRoomList` 中新增「📡 公开频道」区块，按分组归类展示，点击可一键加入频道
7. 新增 `publicChannelItemHTML`、`joinPublicChannel` 函数
8. 未加入任何频道的用户也能看到公开频道列表

**数据流**：`public_channels` 表 → `loadRoomList` 获取 → `chatState.publicChannels` → `renderRoomList` 按分组渲染 → 用户点击加入

---

#### 故障修复

##### 2. 频道公告：开发者和管理员创建的公告不可见（深度老bug）

**现象**：频道内只有创建者的公告能被看见并置顶，开发者和管理者创建的公告看不见。

**根因**（三重）：
1. `checkChannelPermission` 函数检查 `chat_room_members` 表而非 `chat_admins` 表来判断管理员权限，导致权限判断不一致——该函数用于控制频道设置弹窗中的"+ 发布"按钮显示，以及用户弹窗中的管理操作
2. `getPermissionLevel` 函数在 `chatState.rooms` 中找不到房间时直接返回 0，跳过了 `chat_admins` 表检查——当房间数据未及时加载时，管理员权限被错误地判定为 0
3. 频道上下文面板（右侧栏）和频道设置弹窗均使用 `channelAnnouncementList` 作为元素 ID，当两者同时存在于 DOM 中时，`getElementById` 返回第一个匹配元素，导致公告内容加载到错误的容器中

**修复**：
1. `checkChannelPermission`：改为统一调用 `getPermissionLevel(roomId, currentUser.id) >= 1`，确保开发者(3)、创建者(2)、管理员(1)均通过权限检查
2. `getPermissionLevel`：移除 `if (!room) return 0` 的提前返回，改为 `if (room && room.created_by === userId) return 2`——即使房间不在 `chatState.rooms` 中，仍会继续检查 `chat_admins` 表
3. 频道设置弹窗中的公告列表和工具列表改用独立元素 ID（`settingsChannelAnnouncementList`、`settingsChannelToolList`）
4. `loadChannelAnnouncements` 和 `loadChannelTools` 新增 `containerId` 可选参数，支持指定目标容器
5. `saveAnnouncement` 和 `deleteChannelAnnouncement` 操作后同时刷新上下文面板和设置弹窗的公告列表

**权限体系**：开发者(3) > 创建者(2) > 管理员(1) > 普通成员(0)，管理员及以上均可管理公告。

---

#### 修改文件

- `public/index.html` — 公开频道管理界面及函数、公告权限三重修复、元素 ID 去重
- `supabase-migration.sql` — 新增 `public_channels` 表及 RLS 策略
- `README.md` — 功能清单新增公开频道
- `CHANGELOG.md` — 本条目

---

## v4.5 — 2026-07-25

### 频道公告弹窗阅读 + 公告权限修复 + 设置页新内容不可见修复

#### 故障修复

##### 1. 置顶公告点击跳转到设置页面（应弹出阅读窗口）

**现象**：频道聊天界面顶部的置顶公告横幅，点击后直接打开频道设置弹窗，而非显示公告内容供阅读。

**根因**：`banner.onclick` 绑定为 `showRoomSettings()`，打开整个频道设置面板，而非专门展示公告内容。

**修复**：
1. 新增 `showPinnedAnnouncements(announcements)` 函数，创建独立弹窗展示置顶公告内容（标题 + 富文本内容 + 时间）
2. 横幅查询从 `limit(2)` 改为 `limit(5)`，支持显示更多置顶公告
3. 横幅文案从"查看"改为"点击阅读"
4. `banner.onclick` 改为调用 `showPinnedAnnouncements(pinned)`，直接传入已查询的公告数据
5. 弹窗支持点击遮罩关闭、滚动浏览多条公告

---

##### 2. 只有创建者能发公告，管理员和开发者不行

**现象**：频道公告的发布/编辑/删除操作仅限频道创建者（permission level 2），管理员（level 1）被阻止。

**根因**：
1. `showAnnouncementEditor` 和 `deleteChannelAnnouncement` 中权限检查为 `myLevel < 2`，阻止了管理员（level 1）
2. `loadChannelAnnouncements` 中 `isAdmin` 判断为 `room.created_by === currentUser.id || isDeveloper()`，未包含频道管理员（chat_admins 表），导致管理员看不到编辑/删除按钮

**修复**：
1. `showAnnouncementEditor`：`myLevel < 2` → `myLevel < 1`，允许管理员及以上发布/编辑公告
2. `deleteChannelAnnouncement`：`myLevel < 2` → `myLevel < 1`，允许管理员及以上删除公告
3. `loadChannelAnnouncements`：`isAdmin` 改为使用 `getPermissionLevel(roomId, currentUser.id) >= 1`，准确包含频道管理员

**权限体系**：开发者(3) > 创建者(2) > 管理员(1) > 普通成员(0)，管理员及以上均可管理公告。

---

##### 3. 个人设置界面新内容不可见（修改昵称/自我介绍/密保问题）

**现象**：设置页账号标签页中看不到新增的"修改昵称"、"自我介绍"、"密保问题"区块。

**根因**：`index.html` 中存在两个 `switchSettingsTab` 函数定义——第一个（ES6 async 语法）包含新内容，但被第二个（传统 function 赋值语法）覆盖。实际运行的是第二个定义，它调用 `settingsAccountHTML()` 渲染账号设置页，但该函数不包含新增区块。

**修复**：
1. 在 `settingsAccountHTML()` 中添加"修改昵称"区块（含30天冷却提示）
2. 在 `settingsAccountHTML()` 中添加"自我介绍"区块（含30天冷却提示）
3. 在 `settingsAccountHTML()` 中添加"密保问题"区块（7个预设问题，含30天冷却）
4. 在 `switchSettingsTab` 中添加 `loadSecurityQuestion()` 和 `loadProfileCooldown()` 调用
5. 修复 `updateProfile` 提示文字："公告内容" → "自我介绍"

---

#### 修改文件

- `public/index.html` — 置顶公告弹窗函数、公告权限检查修复、设置页新内容补充
- `CHANGELOG.md` — 本条目

---

## v4.4 — 2026-07-25

### 资料修改冷却机制 + 密保问题找回密码 + Supabase 延迟优化 + 好友消息发送者显示修复 + 设置页好友/频道数显示改版

#### 新增功能

##### 1. 资料修改冷却机制（30天）

**需求**：修改昵称、自我介绍、密保问题各需一个月冷却时间。

**实现**：
1. D1 `users` 表新增字段：`name_changed_at`、`bio_changed_at`、`security_question_changed_at`（TEXT 类型，记录上次修改时间）
2. `settings.js` 后端 `update_profile` action 添加冷却检查逻辑：
   - 昵称修改：查询 `name_changed_at`，若距今不足30天则返回剩余天数
   - 自我介绍修改：查询 `bio_changed_at`，同上
   - 密保问题修改：查询 `security_question_changed_at`，仅对已有密保问题的用户生效；首次设置不限制
3. 新增 `get_profile_cooldown` action，返回昵称和自我介绍的冷却状态
4. `set_security_question` action 添加冷却检查
5. 前端设置页显示冷却提示和剩余天数

##### 2. 密保问题找回密码

**需求**：在之前登录过的设备上，通过密保问题找回密码。

**实现**：
1. 7个预设密保问题（宠物名/电影/小学/父亲名/母亲名/出生城市/食物）
2. 密保答案使用 PBKDF2-SHA256 哈希存储（与密码相同安全级别），答案统一转小写后哈希
3. 登录页新增"忘记账号"入口
4. 找回流程：选择本设备已登录过的账号（localStorage 存储，最多10个）→ 回答密保问题 → 重置密码 → 自动登录
5. 新增 `/api/users/recover` 端点，支持验证密保答案和重置密码
6. `get_security_question` action 返回密保问题和冷却状态

---

#### 故障修复

##### 1. Supabase 高延迟

**现象**：聊天界面消息加载缓慢，Supabase 查询响应时间长。

**根因**：每次消息轮询都附带 reactions（表情反应）查询，导致额外的数据库往返；固定轮询间隔（5秒）在无新消息时造成不必要的请求。

**修复**：
1. 移除冗余的 reactions 轮询查询
2. 实现自适应轮询间隔：有新消息时 5 秒轮询，连续 3 次无新消息后延长至 12 秒

---

##### 2. 好友消息不显示发送者

**现象**：私聊中对方发送的消息不显示发送者名称。

**根因**：`sender_name` 字段在某些情况下为空，前端未做回退处理；发送者名称字号过小（10px）且字重不足，难以辨认。

**修复**：
1. 发送者名称字号从 10px 增至 12px，字重设为 700
2. 当 `sender_name` 缺失时，回退到房间 `other` 用户信息获取名称

---

##### 3. 聊天布局分列异常

**现象**：私聊区域布局异常，内容分成两列显示。

**根因**：`privateChatArea` 的 `display` 属性设为 `block`，未启用 flex 布局。

**修复**：`privateChatArea` 的 `display` 从 `block` 改为 `flex`

---

##### 4. 设置页好友/频道数用红点显示

**现象**：个人设置界面的好友数和频道数使用红点 badge 展示，不够直观。

**修复**：
1. 新增 `.tab-count` CSS 类，使用常规数字样式（灰色背景、圆角、小字号）
2. 将好友/频道/黑名单 tab 的 badge 从 `.tab-badge`（红点）改为 `.tab-count`（常规数字）
3. 数字始终显示（即使为0），不再条件隐藏

---

#### 修改文件

- `schema.sql` — 新增 `name_changed_at`、`bio_changed_at`、`security_question_changed_at` 字段
- `functions/api/users/[id]/settings.js` — 冷却检查逻辑、`get_profile_cooldown` action、密保问题冷却
- `functions/api/users/recover.js` — 密保问题找回密码端点（新建）
- `public/index.html` — 设置页新内容、冷却提示、好友消息发送者显示、布局修复、badge 改版
- `public/style.css` — `.tab-count` 样式
- `CHANGELOG.md` — 本条目

---

## v4.3 — 2026-07-24

### 回归 img.scdn.io 直连图床（参照 project2.0）+ 三级降级链

#### 核心变更

**用户反馈**：「project2.0 里这个图床上传功能还是正常的」

**发现**：通过研究 project2.0 代码，发现它使用 `img.scdn.io` 图床 API（`https://img.scdn.io/api/v1.php`），**直接从前端 fetch**，不走 Cloudflare Function 中转。该图床仍在线运行，已托管 853,700 张图片，支持 CORS 直连、无需 API Key。

**对比 project3.0 的问题**：
- v4.0~v4.2 一直尝试 picgo.net（Chevereto API）通过 Cloudflare Function 中转上传，但遇到 502/400 等各种问题
- API key 传递方式、FormData 转发、base64 编码等问题反复出现

**修复方案**：回归 project2.0 的 `img.scdn.io` 直连方案，同时保留 picgo.net Function 和 tmpfile.link 作为多级降级：

1. **首选 img.scdn.io**（前端直连，无需 API Key，字段名 `image`）
2. **备选 picgo.net**（通过 `/api/upload/picgo` Cloudflare Function 服务端转发）
3. **兜底 tmpfile.link**（通过 `/api/upload/tmpfile` Cloudflare Function 服务端转发）

聊天背景上传也同步改为 img.scdn.io 直连，降级走 tmpfile.link。

#### 修改文件

- `public/index.html` — `uploadImageToPicgo()` 改为三级降级链；`uploadChatBg()` 改用 img.scdn.io 直连
- `CHANGELOG.md` — 本条目

---

## v4.2 — 2026-07-24

### 修复 picgo.net 502 + 移除 sm.ms/img.remit.ee 降级

#### 故障修复

##### 1. picgo.net 上传 502 Bad Gateway

**现象**：上传图片到 picgo.net 时，`/api/upload/picgo` 返回 502 Bad Gateway。

**根因**：
1. API key 使用了 `X-API-Key` header，但 Chevereto API 要求 key 通过 URL 参数传递（`?key=xxx`）
2. 使用 base64 data URL 作为 `source` 字段，Cloudflare Workers 中 `btoa()` 对大文件编码不稳定

**修复**：
1. API key 改回 URL 参数传递：`PICGO_UPLOAD_URL + '?key=' + PICGO_API_KEY + '&format=json'`
2. 上传方式从 base64 data URL 改为二进制 Blob：`new Blob([buffer], { type: contentType })`
3. 增加对非 JSON 响应（如 Cloudflare 拦截页面）的 HTML title 提取
4. 增加对 Chevereto 不同错误格式的兼容处理

##### 2. /api/proxy 401 Unauthorized

**现象**：聊天背景上传 picgo.net 失败后，降级方案通过 `/api/proxy` 请求 sm.ms，返回 401 Unauthorized。

**根因**：sm.ms API v2 现在需要认证 token，匿名请求返回 401。`/api/proxy` 转发请求后，sm.ms 的 401 状态码被透传给客户端。

**修复**：完全移除 sm.ms 和 img.remit.ee 降级方案，改用自有服务端端点 `/api/upload/tmpfile`（tmpfile.link）作为聊天背景上传的降级方案，避免 CORS 和认证问题。

#### 修改文件

- `functions/api/upload/picgo.js` — API key 改用 URL 参数，上传方式改为二进制 Blob，增强错误处理
- `public/index.html` — `uploadChatBgFallback()` 改用 `/api/upload/tmpfile`，移除 sm.ms/img.remit.ee
- `CHANGELOG.md` — 本条目

---

## v4.1 — 2026-07-24

### 图床/文件上传完全分离 + 专用上传端点 + 修复 picgo.net 400

#### 核心变更：图床与文件上传分离

**用户反馈**：「文件是文件，图床是图床，不能混在一起的」

**原问题**：旧代码中 `uploadImageFile()` 同时处理图片和文件上传，所有类型的文件都会先尝试 picgo.net 图床（仅支持图片），导致非图片文件上传失败。同时通过 CORS 代理转发 multipart/form-data 时，picgo.net 返回 400 Bad Request。

**修复方案**：

1. **新建 `functions/api/upload/picgo.js`** — 专用图片上传 Cloudflare Function
   - 服务端直接请求 picgo.net API（无 CORS 问题，无代理转发问题）
   - 接收前端 FormData → 读取文件 → 构建新的 FormData（`source` 字段）→ 发送到 picgo.net
   - API Key 在 URL 参数中传递（Chevereto 要求）
   - 仅接受图片类型，最大 25MB

2. **新建 `functions/api/upload/tmpfile.js`** — 专用文件上传 Cloudflare Function
   - 服务端直接请求 tmpfile.link API
   - 接收前端 FormData → 读取文件 → 构建新的 FormData（`file` 字段）→ 发送到 tmpfile.link
   - 支持所有文件类型，最大 100MB
   - 匿名上传，文件 7 天后自动删除

3. **前端函数完全分离**：
   - `uploadImageToPicgo(file)` — 图片上传：picgo.net → R2 兜底 → sm.ms 最后备选
   - `uploadFileToTmpfile(file)` — 文件上传：tmpfile.link → R2 兜底
   - `uploadChatImage(input)` 调用 `uploadImageToPicgo`
   - `uploadChatFile(input)` 调用 `uploadFileToTmpfile`
   - 频道头像上传和批量图片上传也改用 `uploadImageToPicgo`

**根因分析**：通过 CORS 代理转发 multipart/form-data 时，代理使用 `arrayBuffer()` 读取请求体再转发，虽然保留了 Content-Type 头（含 boundary），但 Cloudflare Workers 的 `fetch()` 对重新发送 ArrayBuffer + 自定义 Content-Type 的 multipart/form-data 处理存在问题。专用 Function 在服务端构建全新的 FormData 对象，避免了此问题。

---

#### 修改文件

- `functions/api/upload/picgo.js` — 新建：picgo.net 专用图片上传端点
- `functions/api/upload/tmpfile.js` — 新建：tmpfile.link 专用文件上传端点
- `public/index.html` — 分离图片/文件上传逻辑，更新所有调用点
- `CHANGELOG.md` — 本条目

---

## v4.0 — 2026-07-24

### 图床迁移 picgo.net + tmpfile.link 文件上传 + 频道头像修复 + escAttr 转义修复

#### 故障修复

##### 1. 图床上传失败（迁移至 picgo.net）

**现象**：聊天中上传图片持续失败，之前使用的 img.api.aa1.cn 和 img.remit.ee 均不稳定。

**根因**：免费图床服务频繁变更 API 或下线，旧代码未适配新接口格式。

**修复**：
1. 将 picgo.net（Chevereto API）设为首选图床，API Key 通过 URL 参数传递（Chevereto 要求），`source` 通过 FormData body 传递
2. 新增 tmpfile.link 作为第二优先级上传方式（支持图片和视频，匿名上传）
3. Cloudflare R2 保留为第三优先级兜底
4. 解析 Chevereto API 响应格式 `{ image: { url: "..." } }` 和错误格式 `{ error: { message: "..." } }`
5. 解析 tmpfile.link 响应格式 `{ downloadLink: "..." }`

**经验教训**：Chevereto API 的 key 必须通过 URL 参数传递（`?key=xxx`），而非 Header 或 FormData 字段；多图床应优先级链式降级，确保至少一个可用。

---

##### 2. 频道头像更新 400 Bad Request

**现象**：频道头像不显示，控制台报错 `GET chat_channel_settings?select=room_id,avatar_url,guest_mode&room_id=in.(...) 400 (Bad Request)`。

**根因**：
1. `chat_channel_settings` 表缺少 `guest_mode` 列（Supabase 未执行最新迁移脚本）
2. `loadRoomList()` 查询包含所有房间 ID（包括私聊），URL 过长导致 400 错误
3. Supabase `in()` 过滤器对超长 URL 返回 400

**修复**：
1. 在 `supabase-migration.sql` 中添加 `guest_mode BOOLEAN DEFAULT false` 列定义和幂等 ALTER TABLE
2. `loadRoomList()` 改为只查询频道类型房间（`roomMap[rid].type === 'channel'`），排除私聊房间
3. 分批查询（每批最多 10 个 room_id），避免 URL 长度超限

**用户需操作**：在 Supabase SQL Editor 中重新执行 `supabase-migration.sql`，添加 `guest_mode` 列。

---

##### 3. 文件渲染 SyntaxError: Invalid or unexpected token

**现象**：聊天中点击文件/图片相关按钮时报错 `Uncaught SyntaxError: Invalid or unexpected token`。

**根因**：`escJS()` 函数将双引号 `"` 转义为 `\"`，但在 HTML 双引号属性（`onclick="..."`）中，`\"` 会被 HTML 解析器视为属性结束，导致后续 JS 代码被截断并产生语法错误。

**修复**：
1. 新增 `escAttr()` 函数，专门用于 HTML onclick 属性中的 JS 字符串参数转义
2. `escAttr()` 先做 JS 字符串转义（单引号字符串），再做 HTML 属性编码（`"` → `&quot;`）
3. 将所有 `onclick` 属性中的 `escJS()` 调用替换为 `escAttr()`
4. 删除行 5600 处重复的旧版 `escAttr()` 定义（仅做 HTML 实体编码，未处理 JS 字符串转义）

**经验教训**：HTML 属性值中的 JS 字符串需要双重转义——先 JS 转义（防注入），再 HTML 编码（防属性截断）。不能只用单一转义函数。

---

##### 4. 文件上传 iframe 预览嵌入

**新增功能**：tmpfile.link 上传的文件在聊天中渲染为 iframe 预览，而非简单下载链接。

**实现**：
1. `renderMsgHTML()` 中检测文件 URL 是否来自 tmpfile.link
2. 如果是，渲染 `<iframe>` 预览（200px 高度，sandbox 安全沙箱）+ 底部下载链接
3. 其他来源文件保持原有的简单链接渲染
4. iframe 配置 `sandbox="allow-same-origin allow-scripts allow-popups allow-forms"` 确保安全性

---

#### 修改文件

- `public/index.html` — 图床迁移至 picgo.net、tmpfile.link 集成、escAttr 转义修复、频道头像批量查询、文件 iframe 预览
- `supabase-migration.sql` — 添加 `guest_mode` 列定义和幂等 ALTER TABLE
- `CHANGELOG.md` — 本条目
- `README.md` — 更新图床架构说明

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
