# 网站工具框架扩展教程

## 框架概述
网站工具系统位于 `functions/api/tools/` 目录，由以下组件构成：
- `registry.js` — 工具注册表（唯一真实来源），定义所有工具的元数据
- `ai.js` — AI类工具后端端点（处理 ai_chat 和 ai_image 类型）
- `proxy.js` — 免费 API 代理端点（处理 proxy_get 类型）
- 前端 `openToolPanel()` — 工具面板入口，根据 api_type 分发到不同执行函数

## 支持的工具类型（api_type）

| api_type | 后端端点 | 说明 | 示例 |
|----------|----------|------|------|
| `ai_chat` | POST /api/tools/ai | AI文本对话（SSE流式） | ai_chat, ai_translate, ai_summarize |
| `ai_image` | POST /api/tools/ai | AI图片生成 | ai_draw |
| `proxy_get` | GET /api/tools/proxy | 代理转发免费API | weather, ip, currency, joke |
| `direct_url` | 无（前端直接访问URL） | 直接URL工具 | qrcode, avatar |
| `page` | 自定义后端 | 独立子页面工具 | xfy_blog（小肥羊讲堂） |

## 如何添加新工具

### 方法一：添加简单的 AI/API 工具
1. 在 `functions/api/tools/registry.js` 的 `TOOL_REGISTRY` 数组中添加工具定义
2. AI类工具示例：
```javascript
{
  id: 'my_ai_tool',           // 唯一ID，不加_lhy后缀
  name: '我的AI工具',
  icon: '🤖',
  category: 'independent',
  description: '工具描述',
  api_type: 'ai_chat',        // 或 'ai_image'
  model: '@cf/zai-org/glm-4.7-flash',
  system_prompt: '系统提示词',
  input_fields: [
    { name: 'message', type: 'textarea', label: '输入', placeholder: '...', required: true }
  ],
  result_type: 'streaming_text', // 或 'image'
  max_tokens: 512,
  supports_history: true       // 是否支持多轮对话
}
```
3. 代理API工具示例：
```javascript
{
  id: 'my_api_tool',
  name: 'API工具',
  icon: '🔧',
  category: 'independent',
  description: '工具描述',
  api_type: 'proxy_get',
  url_template: 'https://api.example.com/data',
  default_params: {},
  input_fields: [
    { name: 'param1', type: 'text', label: '参数', required: true }
  ],
  result_type: 'json_card',   // text/image/weather_card/table/json_card
  supports_history: false
}
```
4. 直接URL工具示例（无需后端）：
```javascript
{
  id: 'my_url_tool',
  name: 'URL工具',
  icon: '🔗',
  category: 'independent',
  description: '工具描述',
  api_type: 'direct_url',
  url_template: 'https://api.example.com/generate?text={data}',
  default_params: {},
  input_fields: [
    { name: 'data', type: 'text', label: '内容', required: true }
  ],
  result_type: 'image'
}
```

### 方法二：添加页面类工具（独立子页面）
适用于需要复杂交互界面的工具（如博客、计算器等）。

1. 在 `registry.js` 中注册工具：
```javascript
{
  id: 'my_page_tool',
  name: '页面工具',
  icon: '📐',
  category: 'independent',
  description: '工具描述',
  api_type: 'page',
  page_handler: 'renderMyPage',  // 前端渲染函数名
  input_fields: [],
  result_type: 'page',
  supports_history: false
}
```

2. 在 `public/index.html` 中实现渲染函数：
```javascript
function renderMyPage(container, tool) {
  // container 是页面容器 DOM 元素
  // tool 是工具定义对象
  container.innerHTML = '<h3>我的工具</h3>';
  // 实现工具逻辑...
}
```

3. 如需后端API，在 `functions/api/` 下创建对应文件（如 `functions/api/mytool.js`）

4. 开发者在「开发者-功能」界面选择该工具创建功能卡片，用户点击即可打开

### 方法三：添加自定义后端工具
适用于需要复杂后端逻辑的工具。

1. 在 `registry.js` 中注册工具，使用 `api_type: 'page'` + `page_handler`
2. 创建后端API文件（如 `functions/api/mytool.js`）
3. 在前端 `page_handler` 函数中调用后端API
4. 后端API需遵循统一规范：CORS头、try-catch、null检查

## 工具定义字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 唯一标识符，不加_lhy后缀 |
| name | string | 是 | 显示名称 |
| icon | string | 是 | emoji图标 |
| category | string | 是 | 工具分类（independent=独立工具） |
| description | string | 是 | 工具描述 |
| api_type | string | 是 | 工具类型（ai_chat/ai_image/proxy_get/direct_url/page） |
| model | string | 否 | AI模型ID（仅AI类工具） |
| system_prompt | string | 否 | AI系统提示词（仅AI类工具） |
| url_template | string | 否 | API URL模板（proxy_get/direct_url类工具） |
| default_params | object | 否 | 默认参数（proxy_get/direct_url类工具） |
| input_fields | array | 是 | 输入字段定义 |
| result_type | string | 是 | 结果渲染类型 |
| max_tokens | number | 否 | AI最大token数 |
| supports_history | boolean | 否 | 是否支持多轮对话 |
| page_handler | string | 否 | 前端渲染函数名（仅page类工具） |
| pre_process | string | 否 | 前处理类型（如geocode） |

## input_fields 字段类型
- `text` — 单行文本输入
- `textarea` — 多行文本输入
- `select` — 下拉选择（需提供 options 数组）

## result_type 渲染类型
- `streaming_text` — AI流式文本
- `image` — 图片显示
- `text` — 纯文本
- `weather_card` — 天气卡片
- `json_card` — JSON数据卡片
- `table` — 表格显示
- `page` — 独立子页面

## 博客系统（小肥羊讲堂）架构
- 数据库：D1 blog_posts / blog_comments / blog_announcements 表
- 后端API：`functions/api/blog.js`（列表/创建）、`functions/api/blog/[id].js`（单篇CRUD）、`functions/api/blog/comments.js`（评论）、`functions/api/blog/announce.js`（公告）、`functions/api/blog/publish.js`（Matrix发布）
- 前端：`renderBlogPage()` 入口 → `blogShowList()` 列表 → `blogShowPost()` 阅读 → `blogShowEditor()` 编辑
- Matrix集成：`publishToMatrix()` 通过 Matrix Client-Server API 发送消息到指定房间
- 权限模型：开发者=全权管理，博客作者=管理自己的文章和评论，普通用户=阅读和评论
