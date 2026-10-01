// Cloudflare Pages Function - 真实客户端 IP 解析（V9.1 反向代理配套）
//
// 背景：cf.gallopingroad.top 反代 Worker（doubao-plaza-front）把 alias 流量转发到
//   doubao-plaza.pages.dev。子请求进入 pages.dev 边缘时 CF-Connecting-IP 会被重写为
//   Worker 出口的 Cloudflare 任意播地址（实测 2a06:98c0:3600::103），Worker 显式回写
//   CF-Connecting-IP 无效（边缘无条件覆盖该头）。
// 约定：
//   1) Worker 读取 alias 边缘的 CF-Connecting-IP（真实客户端 IP）并无条件覆盖写入
//      X-DP-Real-IP 头再转发（客户端注入的同名头一律被覆盖/丢弃）。
//   2) 本模块：边缘 CF-Connecting-IP 属 Cloudflare 官方网段 → 判定经反代转发，
//      信任 X-DP-Real-IP；否则（直连 pages.dev）→ 用 CF-Connecting-IP，忽略
//      X-DP-Real-IP（直连伪造无效）。
//   残余风险（记录于 CHANGELOG v9.1）：从 Cloudflare 网段内直连的请求（WARP /
//   自有 zone 中转）可伪造 X-DP-Real-IP，影响面仅限按 IP 限流与审计粒度，不涉及
//   鉴权。反代出口 IP 若不在官方段则回退边缘 IP（与反代上线前行为一致，无回归）。

// Cloudflare 官方网段（https://www.cloudflare.com/ips-v4 与 ips-v6，2026-10-01 抓取）
const CF_V4_CIDRS = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CF_V6_CIDRS = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

// IPv4 点分十进制 → uint32；非法返回 null
function parseV4(str) {
  const parts = str.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = ((n << 8) | v) >>> 0;
  }
  return n >>> 0;
}

// IPv6 → 16 字节（支持单个 "::" 压缩）；非法返回 null
function parseV6(str) {
  if (typeof str !== 'string' || str.indexOf(':') < 0) return null;
  let groups;
  const dbl = str.indexOf('::');
  if (dbl >= 0) {
    if (str.indexOf('::', dbl + 1) >= 0) return null; // 只允许一个 "::"
    const head = str.slice(0, dbl) ? str.slice(0, dbl).split(':') : [];
    const tail = str.slice(dbl + 2) ? str.slice(dbl + 2).split(':') : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = head.concat(new Array(fill).fill('0'), tail);
  } else {
    groups = str.split(':');
    if (groups.length !== 8) return null;
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    const v = parseInt(groups[i], 16);
    bytes[i * 2] = (v >> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}

function validIp(str) {
  if (typeof str !== 'string' || !str || str.length > 45) return false;
  return str.indexOf(':') >= 0 ? parseV6(str) !== null : parseV4(str) !== null;
}

// 模块加载期一次性解析 CIDR（每请求仅做整数/字节比较）
const CF_V4 = CF_V4_CIDRS.map((c) => {
  const [ip, bits] = c.split('/');
  const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return { net: (parseV4(ip) & mask) >>> 0, mask };
});
const CF_V6 = CF_V6_CIDRS.map((c) => {
  const [ip, bits] = c.split('/');
  return { bytes: parseV6(ip), bits: Number(bits) };
});

function inCfV4(ip) {
  const n = parseV4(ip);
  if (n === null) return false;
  return CF_V4.some((c) => (n & c.mask) >>> 0 === c.net);
}

function inCfV6(ip) {
  const bytes = parseV6(ip);
  if (!bytes) return false;
  return CF_V6.some((c) => {
    const full = c.bits >> 3;
    const rem = c.bits & 7;
    for (let i = 0; i < full; i++) {
      if (bytes[i] !== c.bytes[i]) return false;
    }
    if (rem) {
      const m = (0xff << (8 - rem)) & 0xff;
      if ((bytes[full] & m) !== (c.bytes[full] & m)) return false;
    }
    return true;
  });
}

// 该 IP 是否落在 Cloudflare 官方网段（反代 Worker 出口判定依据）
export function isCloudflareEgress(ip) {
  if (!validIp(ip)) return false;
  return ip.indexOf(':') >= 0 ? inCfV6(ip) : inCfV4(ip);
}

// Functions 侧统一取真实客户端 IP：
//   经反代（边缘 IP ∈ CF 官方网段）→ 信任 Worker 覆盖写入的 X-DP-Real-IP；
//   直连 pages.dev → CF-Connecting-IP（任何 X-DP-Real-IP 均被忽略，伪造无效）。
//   均缺失返回 ''，调用方按原口径兜底（'' 或 'unknown'）。
export function resolveClientIp(request) {
  const edge = request.headers.get('CF-Connecting-IP') || '';
  const forwarded = request.headers.get('X-DP-Real-IP') || '';
  if (forwarded && validIp(forwarded) && isCloudflareEgress(edge)) {
    return forwarded;
  }
  return edge;
}
