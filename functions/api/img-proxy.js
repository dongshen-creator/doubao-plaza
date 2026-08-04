// 图片/媒体代理：浏览器端外部图片、视频、音频统一走本站域名（/api/img-proxy?url=...），
// 规避浏览器 Private Network Access (PNA) / CORS 对外部资源的拦截。
// 部署在 Cloudflare Pages Functions，fetch 从 Cloudflare 网络发起，不受客户端 DNS/代理影响。
// V5.0 修复：放行 video/* 与 audio/*（聊天视频消息此前被「非图片内容」拒绝导致无法播放）；超时缩短至 10s。

const MAX_BYTES = 10 * 1024 * 1024; // 最大转发 10MB

// IPv4 私网/保留段判定（纯 IPv4 点分格式）
function isPrivateV4(host) {
  if (host === 'localhost' || host === '127.0.0.1') return true;
  if (/^0\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^127\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d)\./.test(host)) return true; // CGNAT
  return false;
}

// hostname 归一化 + SSRF 判定：
// new URL() 对 IPv6 返回带方括号 hostname，且 IPv4 映射地址为十六进制（如 [::ffff:a00:1] = 10.0.0.1），
// 必须还原后再匹配，否则映射地址可绕过内网拦截。
function isPrivateHost(host) {
  if (!host) return true;
  let h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  // IPv6 回环 / ULA 私网(fc00::/7) / 链路本地(fe80::/10)
  if (h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d 或 ::ffff:aabb:ccdd) → 还原为 IPv4 再检查
  if (h.startsWith('::ffff:')) {
    const rest = h.slice(7);
    let v4 = null;
    if (rest.includes('.')) {
      v4 = rest; // 点分形式
    } else {
      const groups = rest.split(':');
      // ::ffff: 后应为恰好 2 组 16 位（32 位 IPv4）
      if (groups.length === 2 && groups.every(g => /^[0-9a-f]{1,4}$/.test(g))) {
        const g0 = parseInt(groups[0], 16);
        const g1 = parseInt(groups[1], 16);
        v4 = [(g0 >> 8) & 0xff, g0 & 0xff, (g1 >> 8) & 0xff, g1 & 0xff].join('.');
      }
    }
    return v4 ? isPrivateV4(v4) : true; // 无法还原的映射地址一律拒绝
  }
  return isPrivateV4(h);
}

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target) {
    return Response.json({ error: '缺少 url 参数。用法: /api/img-proxy?url=<编码后的图片地址>' }, { status: 400 });
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return Response.json({ error: '无效的 url' }, { status: 400 });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return Response.json({ error: '仅支持 http/https 协议' }, { status: 400 });
  }
  if (isPrivateHost(parsed.hostname)) {
    return Response.json({ error: '禁止访问内网地址' }, { status: 403 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(target, {
      method: 'GET',
      // 不带 Referer（绕过部分图床防盗链）；带常见 UA
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!resp.ok) {
      return new Response('上游返回 ' + resp.status, { status: 502 });
    }
    const ctype = resp.headers.get('Content-Type') || '';
    // 只转发图片/音视频内容（部分图床用 octet-stream，一并放行；解码失败会自行触发 onerror 回退）
    if (!ctype.startsWith('image/') && !ctype.startsWith('video/') && !ctype.startsWith('audio/') && ctype !== 'application/octet-stream') {
      return new Response('非媒体内容', { status: 502 });
    }
    const len = parseInt(resp.headers.get('Content-Length') || '0', 10);
    if (len > MAX_BYTES) {
      return new Response('图片过大', { status: 413 });
    }

    const headers = new Headers();
    headers.set('Content-Type', ctype);
    headers.set('Cache-Control', 'public, max-age=86400'); // CDN 缓存 1 天，减少重复转发
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(resp.body, { status: 200, headers });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return new Response('上游响应超时', { status: 504 });
    }
    return new Response('代理失败: ' + (err.message || '未知错误'), { status: 502 });
  }
}
