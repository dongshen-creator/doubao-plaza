// Cloudflare Pages Function - Render Custom Pages
// [[id]].js 捕获 /pages/{id} 以及 /pages/{id}/子路径
// 优先从 R2 读取文件，无 R2 或无文件时回退到 D1 的 html_content

// 注入到 <head> 最前端的同步登录墙脚本
// 无 token 时用 document.write 完全替换页面，阻止任何外部资源加载
// 有 token 时页面正常渲染（0 网络开销）
function loginWallHead() {
  return '<script id="hp-login">' +
  '(function(){' +
  'var t=typeof localStorage!="undefined"?localStorage.getItem("dp_token"):null;' +
  'if(t){' +
  // token 存在，页面正常渲染
  'window._hpToken=t;' +
  '}else{' +
  // 无 token → 立即终止原始页面，document.write 登录提示
  'document.open();' +
  'document.write("<!DOCTYPE html><html lang=\\"zh-CN\\"><head><meta charset=\\"UTF-8\\"><meta name=\\"viewport\\" content=\\"width=device-width,initial-scale=1\\"><title>\\u8BF7\\u5148\\u767B\\u5F55</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#F7F8FC;font-family:-apple-system,BlinkMacSystemFont,\\"PingFang SC\\",\\"Microsoft YaHei\\",sans-serif;text-align:center}.hp-c{padding:32px}.hp-i{font-size:64px;margin-bottom:24px}.hp-h{font-size:24px;font-weight:700;color:#1a1a2e;margin-bottom:12px}.hp-p{color:#9ca3af;margin-bottom:28px;font-size:14px;line-height:1.6}.hp-a{display:inline-flex;align-items:center;gap:6px;padding:12px 32px;border-radius:12px;background:linear-gradient(135deg,#FF6B35,#FF8F5E);color:#fff;text-decoration:none;font-size:15px;font-weight:600;transition:all .25s}.hp-a:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(255,107,53,.35)}</style></head><body><div class=\\"hp-c\\"><div class=\\"hp-i\\">\\uD83D\\uDD12</div><div class=\\"hp-h\\">\\u8BF7\\u5148\\u767B\\u5F55</div><div class=\\"hp-p\\">\\u8BBF\\u95EE\\u6B64\\u9875\\u9762\\u9700\\u8981\\u767B\\u5F55\\u9017\\u5305\\u7528\\u6237\\u5E7F\\u573A\\u8D26\\u53F7</div><a href=\\"\\" class=\\"hp-a\\">\\uD83C\\uDFE0 \\u524D\\u5F80\\u4E3B\\u9875\\u767B\\u5F55</a></div></body></html>");' +
  'document.close();' +
  '}' +
  '})();' +
  '</script>';
}

function injectIntoHTML(html, block) {
  // 注入到 <head> 开头（所有外部资源之前）
  var hMatch = html.match(/<head[\s>]/i);
  if (hMatch) {
    var idx = hMatch.index;
    var tagEnd = html.indexOf('>', idx);
    if (tagEnd !== -1) {
      return html.slice(0, tagEnd + 1) + block + html.slice(tagEnd + 1);
    }
  }
  // fallback: 注入到 </head> 前
  var hIdx = html.indexOf('</head>');
  if (hIdx === -1) hIdx = html.indexOf('</HEAD>');
  if (hIdx !== -1) {
    return html.slice(0, hIdx) + block + html.slice(hIdx);
  }
  // fallback: 追加到最前面
  return block + html;
}

function getContentType(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  const map = {
    'html':'text/html','css':'text/css','js':'application/javascript',
    'json':'application/json','png':'image/png','jpg':'image/jpeg',
    'jpeg':'image/jpeg','gif':'image/gif','webp':'image/webp',
    'svg':'image/svg+xml','ico':'image/x-icon','mp4':'video/mp4',
    'webm':'video/webm','mp3':'audio/mpeg','wav':'audio/wav',
    'pdf':'application/pdf','txt':'text/plain','woff':'font/woff',
    'woff2':'font/woff2','ttf':'font/ttf',
  };
  return map[ext] || 'application/octet-stream';
}

export async function onRequestGet(context) {
  try {
    const { env, params } = context;
    // [[id]] catch-all 参数是数组形式（如 ["daniel","xyz","123"]）
    // 需要正确处理数组参数，避免 toString 导致逗号分隔异常
    let fullPath = (params && params.id) || '';
    if (Array.isArray(fullPath)) {
      fullPath = fullPath.join('/');
    }
    fullPath = String(fullPath);
    const parts = fullPath.split('/').filter(Boolean);
    const pageId = parts[0] || '';
    const filePath = parts.slice(1).join('/') || 'index.html';

    if (!pageId) {
      return notFoundResponse('页面不存在');
    }

    // 1) 尝试从 R2 读取
    if (env && env.PAGES_BUCKET) {
      try {
        const r2Key = `pages/${pageId}/${filePath}`;
        const obj = await env.PAGES_BUCKET.get(r2Key);
        if (obj) {
          const ct = obj.httpMetadata?.contentType || getContentType(filePath);
          if (ct === 'text/html') {
            const html = await new Response(obj.body).text();
            return new Response(injectIntoHTML(html, loginWallHead()), {
              headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' },
            });
          }
          return new Response(obj.body, {
            headers: {
              'Content-Type': ct,
              'Cache-Control': 'public, max-age=86400',
            },
          });
        }
      } catch (e) { /* R2 not available or error */ }
    }

    // 2) 如果是 index.html，回退到 D1
    if (filePath === 'index.html' && env && env.DB) {
      try {
        const page = await env.DB.prepare(
          `SELECT title, html_content FROM custom_pages WHERE id = ?`
        ).bind(pageId).first();

        if (page) {
          return new Response(injectIntoHTML(page.html_content, loginWallHead()), {
            headers: { 'Content-Type': 'text/html' },
          });
        }
      } catch (e) { /* DB error */ }
    }

    // 3) 404
    return notFoundResponse('文件不存在');
  } catch (e) {
    // 兜底：任何未捕获异常都返回 404，而非 1101
    console.error('pages/[[id]] error:', e);
    return notFoundResponse('服务器错误');
  }
}

function notFoundResponse(msg) {
  return new Response('<!DOCTYPE html><html><head><title>404</title><meta charset="utf-8"></head><body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif"><div style="text-align:center"><h1>404</h1><p>' + msg + '</p><a href="/" style="color:#FF6B35">返回首页</a></div></body></html>', {
    status: 404,
    headers: { 'Content-Type': 'text/html' },
  });
}