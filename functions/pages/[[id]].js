// Cloudflare Pages Function - Render Custom Pages
// [[id]].js 捕获 /pages/{id} 以及 /pages/{id}/子路径
// 优先从 R2 读取文件，无 R2 或无文件时回退到 D1 的 html_content

// 注入到自定义页面的主页会话检测脚本
function homepageSessionScript() {
  return '<script>' +
'(function(){' +
'window._hpSession=null;' +
'window._hpReady=new Promise(function(r){window._hpResolve=r;});' +
'window.getHomepageSession=function(){return window._hpReady;};' +
'window.checkHomepageSession=function(){' +
'var token=typeof localStorage!==\'undefined\'?localStorage.getItem(\'dp_token\'):null;' +
'if(!token){window._hpResolve(null);return;}' +
'fetch(\'/api/users/auto-login\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({token:token})})' +
'.then(function(r){return r.json()}).then(function(d){' +
'window._hpSession=d.success?{user:d.data,token:d.token||token}:null;' +
'try{window.dispatchEvent(new CustomEvent(\'hp-session\',{detail:window._hpSession}));}catch(e){}' +
'window._hpResolve(window._hpSession);' +
'}).catch(function(){window._hpResolve(null);});' +
'};' +
'window.checkHomepageSession();' +
'})();' +
'</script>';  
}

function injectIntoHTML(html, script) {
  var idx = html.lastIndexOf('</body>');
  if (idx === -1) idx = html.lastIndexOf('</BODY>');
  if (idx === -1) return html + script;
  return html.slice(0, idx) + script + html.slice(idx);
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
          return new Response(injectIntoHTML(html, homepageSessionScript()), {
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
        return new Response(injectIntoHTML(page.html_content, homepageSessionScript()), {
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
