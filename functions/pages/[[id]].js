// Cloudflare Pages Function - Render Custom Pages
// [[id]].js 捕获 /pages/{id} 以及 /pages/{id}/子路径
// 优先从 R2 读取文件，无 R2 或无文件时回退到 D1 的 html_content

// 注入到自定义页面的主页会话检测 + 登录遮罩（内联 HTML + script）
function overlayBlock() {
  return '<style id="hp-style">' +
'#hp-overlay{position:fixed;top:0;left:0;right:0;bottom:0;z-index:999999;background:#F7F8FC;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;transition:opacity .35s}' +
'#hp-overlay.hp-hidden{opacity:0;pointer-events:none}' +
'.hp-spinner{width:34px;height:34px;border:3px solid #e5e7eb;border-top-color:#FF6B35;border-radius:50%;animation:hp-spin .75s linear infinite;margin:0 auto 18px}' +
'@keyframes hp-spin{to{transform:rotate(360deg)}}' +
'.hp-card{text-align:center;padding:48px 32px;max-width:380px}' +
'.hp-card h2{font-size:22px;font-weight:700;color:#1a1a2e;margin-bottom:8px}' +
'.hp-card p{font-size:14px;color:#9ca3af;margin-bottom:28px;line-height:1.6}' +
'.hp-btn{display:inline-flex;align-items:center;gap:6px;padding:12px 32px;border-radius:12px;border:none;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;transition:all .25s}' +
'.hp-btn-primary{background:linear-gradient(135deg,#FF6B35,#FF8F5E);color:#fff;box-shadow:0 4px 14px rgba(255,107,53,.35)}' +
'.hp-btn-primary:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(255,107,53,.4)}' +
'.hp-btn:active{transform:scale(.97)}' +
'</style>' +
'<div id="hp-overlay"><div class="hp-card"><div class="hp-spinner"></div><h2>正在验证登录状态...</h2></div></div>' +
'<script>' +
'(function(){' +
'var ov=document.getElementById("hp-overlay");' +
'if(!ov)return;' +
'window._hpSession=null;' +
'window._hpReady=new Promise(function(r){window._hpResolve=r;});' +
'window.getHomepageSession=function(){return window._hpReady;};' +
'function showLogin(msg){' +
'ov.innerHTML="<div class=\\"hp-card\\"><div class=\\"hp-icon\\">&#x1F512;</div><h2>"+msg+"</h2><p>\\u8BBF\\u95EE\\u6B64\\u9875\\u9762\\u9700\\u8981\\u767B\\u5F55\\u9017\\u5305\\u7528\\u6237\\u5E7F\\u573A\\u8D26\\u53F7</p><a href=\\"/\\" class=\\"hp-btn hp-btn-primary\\">&#x1F3E0; \\u524D\\u5F80\\u4E3B\\u9875\\u767B\\u5F55</a></div>";' +
'}' +
'var token=typeof localStorage!="undefined"?localStorage.getItem("dp_token"):null;' +
'if(!token){showLogin("\\u8BF7\\u5148\\u767B\\u5F55");window._hpResolve(null);return;}' +
'fetch("/api/users/auto-login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:token})})' +
'.then(function(r){return r.json()})' +
'.then(function(d){' +
'if(d.success){' +
'window._hpSession={user:d.data,token:d.token||token};' +
'window._hpResolve(window._hpSession);' +
'ov.classList.add("hp-hidden");' +
'var s=document.getElementById("hp-style");if(s)s.remove();' +
'setTimeout(function(){ov.remove()},350);' +
'}else{' +
'localStorage.removeItem("dp_token");' +
'showLogin("\\u4F1A\\u8BDD\\u5DF2\\u8FC7\\u671F");' +
'window._hpResolve(null);' +
'}' +
'})' +
'.catch(function(){' +
'showLogin("\\u7F51\\u7EDC\\u9519\\u8BEF");' +
'window._hpResolve(null);' +
'});' +
'})();' +
'</script>';
}

function injectIntoHTML(html, block) {
  // 优先注入到 <body> 标签后，遮罩作为 body 第一个子元素
  var bodyMatch = html.match(/<body[\s>]/i);
  if (bodyMatch) {
    var idx = bodyMatch.index;
    var tagEnd = html.indexOf('>', idx);
    if (tagEnd !== -1) {
      return html.slice(0, tagEnd + 1) + block + html.slice(tagEnd + 1);
    }
  }
  // fallback: 注入到 </head> 前
  var hIdx = html.lastIndexOf('</head>');
  if (hIdx === -1) hIdx = html.lastIndexOf('</HEAD>');
  if (hIdx === -1) {
    hIdx = html.lastIndexOf('</body>');
    if (hIdx === -1) hIdx = html.lastIndexOf('</BODY>');
    if (hIdx === -1) return html + block;
  }
  return html.slice(0, hIdx) + block + html.slice(hIdx);
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
  const { env, params } = context;
  const fullPath = params.id || '';
  const parts = fullPath.split('/');
  const pageId = parts[0];
  const filePath = parts.slice(1).join('/') || 'index.html';

  // 1) 尝试从 R2 读取
  if (env.PAGES_BUCKET) {
    try {
      const r2Key = `pages/${pageId}/${filePath}`;
      const obj = await env.PAGES_BUCKET.get(r2Key);
      if (obj) {
        const ct = obj.httpMetadata?.contentType || getContentType(filePath);
        if (ct === 'text/html') {
          const html = await new Response(obj.body).text();
          return new Response(injectIntoHTML(html, overlayBlock()), {
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
    } catch (_) { /* R2 not available or error */ }
  }

  // 2) 如果是 index.html，回退到 D1
  if (filePath === 'index.html' && env.DB) {
    try {
      const page = await env.DB.prepare(
        `SELECT title, html_content FROM custom_pages WHERE id = ?`
      ).bind(pageId).first();

      if (page) {
        return new Response(injectIntoHTML(page.html_content, overlayBlock()), {
          headers: { 'Content-Type': 'text/html' },
        });
      }
    } catch (_) { /* DB error */ }
  }

  // 3) 404
  return new Response('<!DOCTYPE html><html><head><title>404</title><meta charset="utf-8"></head><body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif"><div style="text-align:center"><h1>404</h1><p>文件不存在</p><a href="/" style="color:#FF6B35">返回首页</a></div></body></html>', {
    status: 404,
    headers: { 'Content-Type': 'text/html' },
  });
}