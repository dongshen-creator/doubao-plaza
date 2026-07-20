// CORS 代理 - 用于转发 AI API 请求（如 NVIDIA NIM、OpenAI、Coze 站点等）
// 部署在 Cloudflare Pages 上，免费且不依赖第三方代理服务
// 使用方式：POST /api/proxy，Header 中带 X-Target-URL 指定目标地址
// Coze 支持：X-Coze-Session 头会自动转为 Cookie: db_session=<value>

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Target-URL, X-Coze-Session, X-Access-Token',
      'Access-Control-Expose-Headers': 'X-Set-Session',
      'Access-Control-Max-Age': '86400'
    }
  });
}

export async function onRequestPost(context) {
  const { request } = context;

  // 获取目标 URL
  const targetUrl = request.headers.get('X-Target-URL');
  if (!targetUrl) {
    return Response.json({ error: '缺少 X-Target-URL 头' }, { status: 400 });
  }

  // 安全检查：只允许 HTTPS
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'https:') {
      return Response.json({ error: '仅支持 HTTPS 目标' }, { status: 400 });
    }
  } catch {
    return Response.json({ error: '无效的目标 URL' }, { status: 400 });
  }

  // 获取请求体（支持 multipart/form-data 文件上传，用 arrayBuffer 保留二进制）
  const body = await request.arrayBuffer();

  // 构建转发 headers
  const forwardHeaders = new Headers();
  const contentType = request.headers.get('Content-Type');
  if (contentType) forwardHeaders.set('Content-Type', contentType);
  const auth = request.headers.get('Authorization');
  if (auth) forwardHeaders.set('Authorization', auth);

  // Coze Cookie 认证：将 X-Coze-Session 转为 Cookie 头
  const cozeSession = request.headers.get('X-Coze-Session');
  if (cozeSession) {
    forwardHeaders.set('Cookie', 'db_session=' + cozeSession);
  }

  // 上科大 GenAI 认证：转发 X-Access-Token 头
  const accessToken = request.headers.get('X-Access-Token');
  if (accessToken) {
    forwardHeaders.set('X-Access-Token', accessToken);
  }

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: forwardHeaders,
      body: body
    });

    // 返回响应，保留流式特性（SSE）
    const respHeaders = new Headers();
    // 复制内容类型
    const respContentType = response.headers.get('Content-Type');
    if (respContentType) respHeaders.set('Content-Type', respContentType);
    // 添加 CORS 头
    respHeaders.set('Access-Control-Allow-Origin', '*');
    respHeaders.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    respHeaders.set('Access-Control-Expose-Headers', 'X-Set-Session');
    // 对于流式响应，不设置 Content-Length
    if (respContentType && respContentType.includes('text/event-stream')) {
      respHeaders.set('Cache-Control', 'no-cache');
      respHeaders.set('Connection', 'keep-alive');
    }

    // Coze 登录响应：提取 Set-Cookie 中的 db_session 值
    // 优先使用 getSetCookie()（返回数组），回退到 get()
    let setCookieValues = [];
    if (typeof response.headers.getSetCookie === 'function') {
      setCookieValues = response.headers.getSetCookie();
    } else {
      const sc = response.headers.get('Set-Cookie');
      if (sc) setCookieValues = [sc];
    }
    for (const sc of setCookieValues) {
      const match = sc.match(/db_session=([^;]+)/);
      if (match) {
        respHeaders.set('X-Set-Session', match[1]);
        break;
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: respHeaders
    });
  } catch (err) {
    return Response.json({ 
      error: '代理请求失败: ' + (err.message || '未知错误'),
      target: targetUrl.substring(0, 100)
    }, { 
      status: 502,
      headers: {
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

// GET 请求也支持（用于测试代理是否可用，或 Coze GET 请求）
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const targetUrl = url.searchParams.get('url');
  
  if (!targetUrl) {
    return Response.json({ 
      status: 'ok', 
      message: 'CORS 代理运行中。使用方法：POST 请求并附带 X-Target-URL 头。',
      time: new Date().toISOString()
    }, {
      headers: { 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'https:') {
      return Response.json({ error: '仅支持 HTTPS' }, { status: 400 });
    }

    const getHeaders = {};
    const auth = context.request.headers.get('Authorization');
    if (auth) getHeaders['Authorization'] = auth;

    // Coze Cookie 认证
    const cozeSession = context.request.headers.get('X-Coze-Session');
    if (cozeSession) {
      getHeaders['Cookie'] = 'db_session=' + cozeSession;
    }

    // 上科大 GenAI 认证
    const accessToken = context.request.headers.get('X-Access-Token');
    if (accessToken) {
      getHeaders['X-Access-Token'] = accessToken;
    }

    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: getHeaders
    });

    const respHeaders = new Headers();
    const respContentType = response.headers.get('Content-Type');
    if (respContentType) respHeaders.set('Content-Type', respContentType);
    respHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(response.body, {
      status: response.status,
      headers: respHeaders
    });
  } catch (err) {
    return Response.json({ 
      error: '代理请求失败: ' + (err.message || '未知错误')
    }, { 
      status: 502,
      headers: { 'Access-Control-Allow-Origin': '*' }
    });
  }
}
