// 网易云音乐搜索工具 - 后端代理（V14.0）
// GET /api/tools/music?action=search&keyword=关键词&limit=20  搜索歌曲
// GET /api/tools/music?action=url&id=歌曲ID                    获取播放直链
// GET /api/tools/music?action=hot                             热门推荐（可选）
//
// 上游为公开的 NeteaseCloudMusicApi 实例（多上游 fallback）。Cloudflare Edge 出口
// 与用户浏览器出口不同，风控表现不同，故统一由本端点代理；http 直链升级为 https
// 以满足站点 CSP（upgrade-insecure-requests + media-src https:）。

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-DP-Client',
  'Cache-Control': 'no-store',
};

// 优先使用实测可用的实例；按顺序 fallback
const UPSTREAMS = [
  'https://api.neteasemusic.davidblackcn.online',
  'https://api-enhanced-plum-five.vercel.app',
  'https://apis.netstart.cn/music',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function fetchJson(url, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://music.163.com/' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function toHttps(u) {
  if (!u || typeof u !== 'string') return '';
  return u.replace(/^http:\/\//, 'https://');
}

// 兼容新版(ar/al)与旧版(artists/album)字段
function normalizeSong(s) {
  if (!s) return null;
  const artists = s.ar || s.artists || [];
  const album = s.al || s.album || {};
  return {
    id: s.id,
    name: s.name || '未知歌曲',
    artists: (Array.isArray(artists) ? artists : []).map((a) => a && a.name).filter(Boolean).join(' / '),
    album: album.name || '',
    picUrl: toHttps(album.picUrl || (s.album && s.album.picUrl) || ''),
    duration: Number(s.dt || s.duration || 0),
    mvId: s.mv || 0,
    // fee=0 免费可播；>0 为会员/付费歌（可能无法在线播放），前端据此标注 VIP
    fee: Number((s.privilege && s.privilege.fee) != null ? s.privilege.fee : (s.fee != null ? s.fee : 0)),
  };
}

// 依次尝试上游，返回第一个有效结果
async function tryUpstreams(buildPaths, validate) {
  let lastErr = '无可用音乐服务';
  for (const base of UPSTREAMS) {
    const paths = buildPaths(base);
    for (const p of paths) {
      try {
        const data = await fetchJson(p);
        const ok = validate(data);
        if (ok) return { data, up: base };
        if (data && (data.code === -460 || data.message)) lastErr = data.message || lastErr;
      } catch (e) {
        lastErr = (e && e.message) || lastErr;
      }
    }
  }
  throw new Error(lastErr);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const action = (url.searchParams.get('action') || 'search').toLowerCase();

  try {
    if (action === 'search') {
      const keyword = (url.searchParams.get('keyword') || url.searchParams.get('keywords') || '').trim();
      if (!keyword) return json({ success: false, error: '请输入搜索关键词' }, 400);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 60);
      const q = encodeURIComponent(keyword);

      const { data, up } = await tryUpstreams(
        (base) => [
          `${base}/cloudsearch?keywords=${q}&limit=${limit}&type=1`,
          `${base}/search?keywords=${q}&limit=${limit}&type=1`,
        ],
        (d) => d && d.result && Array.isArray(d.result.songs)
      );

      const songs = data.result.songs.map(normalizeSong).filter((s) => s && s.id);
      return json({
        success: true,
        data: { songs, count: data.result.songCount || songs.length, keyword, upstream: up },
      });
    }

    if (action === 'url') {
      const id = (url.searchParams.get('id') || '').trim();
      if (!id || !/^\d+$/.test(id)) return json({ success: false, error: '歌曲 ID 无效' }, 400);

      const { data } = await tryUpstreams(
        (base) => [
          `${base}/song/url?id=${id}`,
          `${base}/song/url/v1?id=${id}&level=standard`,
        ],
        (d) => d && d.code === 200 && Array.isArray(d.data) && d.data.length > 0
      );

      const item = data.data[0] || {};
      const playUrl = toHttps(item.url);
      if (!playUrl) {
        return json({ success: false, error: '该歌曲暂无免费播放源，可能是会员/版权歌曲' }, 404);
      }
      return json({
        success: true,
        data: {
          id: item.id || Number(id),
          url: playUrl,
          bitrate: item.br || 0,
          size: item.size || 0,
          format: item.type || 'mp3',
        },
      });
    }

    return json({ success: false, error: '不支持的操作: ' + action }, 400);
  } catch (e) {
    const msg = (e && e.message) || '音乐服务暂时不可用';
    return json({ success: false, error: '音乐服务暂时不可用：' + msg }, 502);
  }
}
