/* ═══════════════════════════════════════════════════════════
   V12.2 · WorkBuddy 同源后台（single-port HTTP service）
   ---------------------------------------------------------------
   解决的问题：
     V12.1 把 WorkBuddy 发布域当成「纯静态托管」，靠前端 fetch patch 把
     /api/* 跨域改写到主站。浏览器侧因此出现第三方 Cookie 被拦截、
     CORS 预检、Tracking Prevention、vendor/manifest 404，登录始终不通。

   本服务让 WorkBuddy 侧真正拥有后台服务器：
     1) 网页、CSS/JS/vendor/manifest/图片 全部由本服务同源提供；
     2) /api/*、/pages/*、/chat/*、/cdn-assets/* 同源反代到共享主站
        （Cloudflare Pages Functions + D1 + Supabase 仍是唯一事实来源）；
     3) 上游下发的 __Host-dp_device 设备凭据经本服务原样回种到本域，
        同源 cookie 不再被第三方策略拦截，设备身份确认链路才真正闭环；
     4) /.cloud/** 属于 WorkBuddy 云数据面平台网关，绝不反代到业务主站；
        若请求意外落到本服务，则带环回守卫回送到平台入口。

   部署约定（WorkBuddy 发布沙箱）：
     · 监听 process.env.PORT，绑定 0.0.0.0
     · 零第三方依赖，installCmd 留空
     · directory 仍是 public/，复用同一 appId 与保留域，
       云服务的精确 Origin 校验才不会失效

   环境变量（全部可选）：
     DP_UPSTREAM           共享主站，默认 https://doubao-plaza.pages.dev
     DP_UPSTREAM_FALLBACK  网络故障时的备用入口，默认关闭（见下）
     DP_CLOUD_ENDPOINT     平台云数据面入口，默认本应用保留域

   V12.3 修复（failed to fetch 根因）：
     · 平台门禁 Server: CloudStudio Gateway 会对「无 __wb_rsc 会话的非首页请求」
       直接 403 并返回 HTML。原实现依赖浏览器单独请求 /dp-backend.js 来判定
       部署形态，一旦该请求被 403，浏览器把 HTML 当 JS 执行失败，
       window.__DP_BACKEND__ 保持 undefined → 前端误判成「静态托管」→
       把 /api 改写成跨域绝对地址 → 出现 failed to fetch。
       现改为：出 HTML 时在 <head> 里内联注入 __DP_BACKEND__ = true，
       形态判定不再依赖任何额外子资源请求。
     · 备用上游 cf.gallopingroad.top 实测不可用（curl 返回 000 / SSL 失败，
       一次挂起 15s），主上游抖动时切过去必然长时间不返回，
       现默认关闭该 fallback，仅当显式配置 DP_UPSTREAM_FALLBACK 才启用。
     · 反代加 keep-alive 连接池，复用同一条 TLS 连接，降低跨网络段握手开销。
   ═══════════════════════════════════════════════════════════ */
'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const PRIMARY = trimSlash(process.env.DP_UPSTREAM || 'https://doubao-plaza.pages.dev');
// 默认关闭：历史默认值 cf.gallopingroad.top 实测连不通，启用反而把故障放大成 15s 挂起
const FALLBACK = trimSlash(process.env.DP_UPSTREAM_FALLBACK || '');
const CLOUD_ENDPOINT = trimSlash(process.env.DP_CLOUD_ENDPOINT || 'https://doubao-plaza-v11.app.workbuddy.host');
const UPSTREAM_TIMEOUT_MS = 300000;

// 反代连接复用：沙箱到上游是跨网络段，每次新建 TLS 连接要额外付 2 次以上 RTT
const AGENT_OPTS = {
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 96,
  maxFreeSockets: 24,
  timeout: 60000,
};
const HTTPS_AGENT = new https.Agent(AGENT_OPTS);
const HTTP_AGENT = new http.Agent(AGENT_OPTS);

// 与 public/_routes.json 的 Functions 路由范围保持一致
const PROXY_PREFIXES = ['/api/', '/pages/', '/chat/', '/cdn-assets/'];
const PROXY_EXACT = ['/api', '/pages', '/chat', '/cdn-assets'];

const HOP_REQUEST = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);
const HOP_RESPONSE = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

const DENY_NAMES = new Set([
  'server.js', 'server.mjs', 'server.cjs', 'package.json',
  'package-lock.json', 'wrangler.toml', '.env', '.npmrc',
]);

// 静态资源扩展名：沙箱若未随包带上某个目录（历史上 vendor/ 就发生过），
// 对该类路径做一次同源反代兜底，浏览器看到的仍是同源资源，不产生 CORS/CSP 问题。
const STATIC_ASSET_RE = /\.(js|mjs|css|json|webmanifest|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|eot|mp3|mp4|webm|wasm|pdf|txt|xml)$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
};

function trimSlash(s) { return String(s).replace(/\/+$/, ''); }

/* ── 部署形态注入（V12.3 核心修复）─────────────────────────────
   浏览器请求 /dp-backend.js 时若被平台门禁 403（返回 HTML），
   <script> 解析失败，window.__DP_BACKEND__ 就一直是 undefined，
   前端于是按「静态托管」跨域改写 /api，最终 failed to fetch。
   这里改为服务端在 HTML 里直接写入常量，让判定与网络请求彻底解耦。 */
const PROBE_TAG_RE = /<script\b[^>]*\bsrc=["']\/dp-backend\.js[^"']*["'][^>]*>\s*<\/script>/i;
const HEAD_OPEN_RE = /<head\b[^>]*>/i;
const BACKEND_INLINE = '<script>window.__DP_BACKEND__=true;window.__DP_BACKEND_SRC="server-inline";</script>';

function injectBackendProbe(html) {
  const src = String(html);
  if (PROBE_TAG_RE.test(src)) return src.replace(PROBE_TAG_RE, BACKEND_INLINE);
  if (HEAD_OPEN_RE.test(src)) return src.replace(HEAD_OPEN_RE, (m) => m + BACKEND_INLINE);
  return BACKEND_INLINE + src;
}

function isProxyPath(p) {
  return PROXY_EXACT.indexOf(p) >= 0 || PROXY_PREFIXES.some((x) => p.indexOf(x) === 0);
}

function clientIp(req) {
  const cf = header(req, 'cf-connecting-ip');
  if (cf) return cf;
  const real = header(req, 'x-real-ip');
  if (real) return real;
  const xff = header(req, 'x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

function header(req, name) {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] || '';
  return v || '';
}

/* 上游 Set-Cookie 常带 Domain=<主站>，浏览器会拒绝把它种到本域。
   __Host- 前缀本身要求不带 Domain，去掉后凭据即成为本域的 host-only cookie。 */
function cleanCookie(line) {
  return String(line).replace(/;\s*Domain\s*=[^;]*/gi, '');
}

function rewriteLocation(v, origin) {
  const s = Array.isArray(v) ? v[0] : String(v || '');
  if (s.indexOf(origin) === 0) return s.slice(origin.length) || '/';
  if (s.indexOf(PRIMARY) === 0) return s.slice(PRIMARY.length) || '/';
  return s;
}

function outboundHeaders(req, origin, extra) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_REQUEST.has(k)) continue;
    out[k] = v;
  }
  // 客户端无法伪造边缘 IP 头；统一由本服务按真实来源回写
  delete out['cf-connecting-ip'];
  out.host = new URL(origin).host;
  // 让上游 _middleware.js 的门禁按「同源」判定（origin === request url origin）
  out.origin = origin;
  // 全业务 API 的门禁证明，服务端强制覆盖，不信任客户端
  out['x-dp-client'] = 'plaza-v1';
  const ip = clientIp(req);
  if (ip) {
    out['x-dp-real-ip'] = ip;
    out['x-forwarded-for'] = ip;
  }
  if (extra) Object.assign(out, extra);
  return out;
}

function writeUpstreamResponse(res, upRes, origin) {
  const headers = {};
  for (const [k, v] of Object.entries(upRes.headers)) {
    if (HOP_RESPONSE.has(k)) continue;
    const lk = k.toLowerCase();
    if (lk === 'set-cookie') {
      headers[k] = (Array.isArray(v) ? v : [v]).map(cleanCookie);
    } else if (lk === 'location') {
      headers[k] = rewriteLocation(v, origin);
    } else if (lk === 'access-control-allow-origin' || lk === 'access-control-allow-credentials') {
      // 已经同源，跨域头无意义；去掉避免浏览器收到含糊的来源声明
      continue;
    } else if (lk === 'content-security-policy' && String(v).indexOf('frame-ancestors') >= 0) {
      // API 响应带的 default-src 'none' CSP 只约束直接导航，保留无害但去掉可减少噪音
      continue;
    } else {
      headers[k] = v;
    }
  }
  headers['X-DP-Gateway'] = 'workbuddy-same-origin';
  res.writeHead(upRes.statusCode || 502, headers);
  upRes.pipe(res);
  res.on('close', () => { try { upRes.destroy(); } catch (e) {} });
}

function proxy(req, res, url, origin, extra) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url.pathname + url.search, origin); }
    catch (e) { reject(e); return; }
    const mod = target.protocol === 'https:' ? https : http;
    const upReq = mod.request(target, {
      method: req.method,
      headers: outboundHeaders(req, origin, extra),
      timeout: UPSTREAM_TIMEOUT_MS,
      agent: target.protocol === 'https:' ? HTTPS_AGENT : HTTP_AGENT,
    }, (upRes) => {
      writeUpstreamResponse(res, upRes, origin);
      resolve();
    });
    upReq.on('timeout', () => upReq.destroy(new Error('upstream timeout')));
    upReq.on('error', reject);
    req.on('aborted', () => { try { upReq.destroy(); } catch (e) {} });
    // GET/HEAD 没有 body，pipe 也能正确结束
    req.pipe(upReq);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-DP-Gateway': 'workbuddy-same-origin',
  });
  res.end(body);
}

function safeResolve(p) {
  let decoded;
  try { decoded = decodeURIComponent(p); }
  catch (e) { return null; }
  const rel = decoded.replace(/^\/+/, '');
  const full = path.resolve(ROOT, rel);
  if (full !== ROOT && full.indexOf(ROOT + path.sep) !== 0) return null;
  return { full, rel };
}

function isDenied(rel) {
  const parts = rel.split(/[\\/]/);
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === 'node_modules') return true;
    if (DENY_NAMES.has(p.toLowerCase())) return true;
    if (p.charAt(0) === '.' && p !== '.well-known') return true;
  }
  return false;
}

function serveFile(req, res, full, opts) {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { notFound(req, res); return; }
    const ext = path.extname(full).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const isHtml = type.indexOf('text/html') === 0;
    const headers = {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'X-DP-Gateway': 'workbuddy-same-origin',
      'Cache-Control': opts && opts.noStore
        ? 'no-store, max-age=0'
        : (full.indexOf(path.sep + 'vendor' + path.sep) >= 0
          ? 'public, max-age=86400'
          : (isHtml ? 'no-cache' : 'public, max-age=3600')),
      'Accept-Ranges': 'bytes',
    };
    const range = header(req, 'range');
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    // HTML 需要注入部署形态常量，签名/长度都会变，因此不走 Range 与流式，统一整份下发
    if (isHtml) {
      fs.readFile(full, 'utf8', (rerr, html) => {
        if (rerr) { notFound(req, res); return; }
        const body = injectBackendProbe(html);
        delete headers['Accept-Ranges'];
        headers['Content-Length'] = Buffer.byteLength(body);
        headers['Cache-Control'] = 'no-store, max-age=0';
        res.writeHead(opts && opts.status ? opts.status : 200, headers);
        if (req.method === 'HEAD') { res.end(); return; }
        res.end(body);
      });
      return;
    }
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : st.size - 1;
      if (!m[1] && m[2]) { start = Math.max(0, st.size - Number(m[2])); end = st.size - 1; }
      if (start > end || start >= st.size) {
        res.writeHead(416, Object.assign({}, headers, { 'Content-Range': 'bytes */' + st.size }));
        res.end();
        return;
      }
      end = Math.min(end, st.size - 1);
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(full, { start, end }).pipe(res);
      return;
    }
    headers['Content-Length'] = st.size;
    res.writeHead(opts && opts.status ? opts.status : 200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(full).pipe(res);
  });
}

function notFound(req, res) {
  const accept = header(req, 'accept');
  if (accept.indexOf('text/html') >= 0) {
    const p = path.join(ROOT, '404.html');
    if (fs.existsSync(p)) { serveFile(req, res, p, { status: 404 }); return; }
  }
  sendJson(res, 404, { success: false, error: '资源不存在', gateway: 'workbuddy-same-origin' });
}

function serveStatic(req, res, url) {
  const found = safeResolve(url.pathname);
  if (!found || isDenied(found.rel)) { notFound(req, res); return; }
  let { full } = found;
  const { rel } = found;
  if (!rel || rel.slice(-1) === '/') full = path.join(full, 'index.html');
  else if (!path.extname(full)) {
    // Cloudflare Pages 的 clean URL：/developer → /developer.html
    if (!fs.existsSync(full) && fs.existsSync(full + '.html')) full = full + '.html';
  }
  if (!fs.existsSync(full)) {
    if (STATIC_ASSET_RE.test(url.pathname) && req.method === 'GET') {
      // 同源兜底：静态文件缺失时从共享主站取回，仍由本服务返回给浏览器
      proxy(req, res, url, PRIMARY).catch(() => {
        if (!res.headersSent) notFound(req, res);
        else res.destroy();
      });
      return;
    }
    notFound(req, res);
    return;
  }
  serveFile(req, res, full, {});
}

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (e) { sendJson(res, 400, { success: false, error: 'bad request' }); return; }
  const p = url.pathname;

  // 健康检查：确认发布域确实跑在真后台上，而不是静态托管
  if (p === '/__dp/health') {
    const info = {
      success: true,
      mode: 'workbuddy-backend',
      version: '12.3',
      upstream: PRIMARY,
      fallback: FALLBACK,
      time: new Date().toISOString(),
    };
    // ?diag=1 时回显平台网关转发进来的来源标识头，用于核对真实客户端 IP 是否可用
    // （只回显调用者自己的请求头，不涉及他人数据）
    if (url.searchParams.get('diag') === '1') {
      info.clientIp = clientIp(req) || '';
      info.headers = {
        'cf-connecting-ip': header(req, 'cf-connecting-ip') || '',
        'x-real-ip': header(req, 'x-real-ip') || '',
        'x-forwarded-for': header(req, 'x-forwarded-for') || '',
        'true-client-ip': header(req, 'true-client-ip') || '',
        'x-client-ip': header(req, 'x-client-ip') || '',
      };
    }
    sendJson(res, 200, info);
    return;
  }

  // 前端同源判定探针：静态发布域下发 false，本服务动态下发 true
  if (p === '/dp-backend.js') {
    const body = 'window.__DP_BACKEND__ = true;\n';
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'X-DP-Gateway': 'workbuddy-same-origin',
    });
    res.end(body);
    return;
  }

  // 云数据面平台网关：绝不反代到业务主站。正常由平台边缘直接接管；
  // 若意外落到本服务，回送平台入口并带环回守卫。
  if (p.indexOf('/.cloud/') === 0) {
    if (header(req, 'x-dp-cloud-passthrough')) {
      sendJson(res, 404, { success: false, error: '云数据面未由平台网关接管', gateway: 'workbuddy-same-origin' });
      return;
    }
    try {
      await proxy(req, res, url, CLOUD_ENDPOINT, { 'x-dp-cloud-passthrough': '1' });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 502, { success: false, error: '云数据面不可达' });
      else res.destroy();
    }
    return;
  }

  if (isProxyPath(p)) {
    try {
      await proxy(req, res, url, PRIMARY);
      return;
    } catch (e) {
      // 仅网络层故障才切换备用入口；上游返回 4xx/5xx 属于业务结果，原样透传
      if (!res.headersSent && FALLBACK && FALLBACK !== PRIMARY) {
        try { await proxy(req, res, url, FALLBACK); return; }
        catch (e2) { /* 落到下方统一 502 */ }
      }
      if (!res.headersSent) {
        sendJson(res, 502, { success: false, error: '共享服务暂时不可达，请稍后重试' });
      } else {
        res.destroy();
      }
      return;
    }
  }

  serveStatic(req, res, url);
}

const server = http.createServer((req, res) => {
  Promise.resolve(handle(req, res)).catch((e) => {
    console.error('[dp-gateway]', e && e.message);
    if (!res.headersSent) sendJson(res, 500, { success: false, error: '后台内部错误' });
    else res.destroy();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[dp-gateway] WorkBuddy same-origin backend listening on 0.0.0.0:' + PORT);
  console.log('[dp-gateway] upstream=' + PRIMARY + ' fallback=' + FALLBACK);
});
