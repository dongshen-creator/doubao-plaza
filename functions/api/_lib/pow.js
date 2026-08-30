// V5.13 新增：注册防滥用核心库（工作量证明 PoW + 蜜罐辅助 + Tor 出口节点拦截）
//
// 设计目标：防批量注册，尤其抗 Tor / 动态代理 IP（换 IP 无效）：
// 1. PoW（核心）：注册前客户端必须完成 SHA-256 工作量证明（默认 20 个前导零位，约 1~3 秒/次），
//    批量注册者每注册一个账号都要支付真实算力成本，与 IP 无关，天然抗洋葱/代理轮换。
// 2. 挑战单次有效 + 有效期 + 最短填写时间（D1 register_challenges 表记录签发时间）：
//    秒回提交的脚本直接拒绝，同一挑战无法复用。
// 3. Tor 出口节点拦截：对照 torproject 官方出口 IP 列表（D1 缓存 6 小时，拉取失败时降级放行）。
// 4. 蜜罐字段：隐藏输入框，机器人自动填表会暴露。
//
// 兼容性：register_challenges 表未创建（未重跑 schema.sql）时整体自动降级为不拦截（fail-open），
// 不影响正常注册；重跑 schema.sql 后立即生效。

import { generateToken } from './jwt.js';

const POW_DEFAULT_DIFFICULTY = 20;   // 前导零位数（2^20 ≈ 100 万次哈希期望）
const POW_MAX_DIFFICULTY = 22;       // 上限，防止误配置导致手机端无法注册
const POW_MIN_AGE_SECONDS = 2;       // 挑战签发到提交的最短间隔（真人填表远大于此，脚本秒回即拒）
const POW_MAX_AGE_SECONDS = 900;     // 挑战有效期 15 分钟
const TOR_LIST_TTL_MS = 6 * 3600 * 1000; // Tor 出口列表缓存 6 小时

// 获取 PoW HMAC 密钥：优先环境变量，否则自动生成并持久化到 site_settings（多 isolate 间共享）
async function getPoWSecret(env) {
  if (env.REGISTER_POW_SECRET) return env.REGISTER_POW_SECRET;
  try {
    const row = await env.DB.prepare(
      `SELECT value FROM site_settings WHERE key = 'register_pow_secret'`
    ).first();
    if (row && row.value) return row.value;
    const secret = generateToken();
    await env.DB.prepare(
      `INSERT INTO site_settings (key, value, updated_at) VALUES ('register_pow_secret', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).bind(secret).run();
    return secret;
  } catch (e) {
    console.warn('[POW] 读取/生成密钥失败:', e.message);
    return null;
  }
}

function base64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

// register_challenges 表是否存在/自动创建（V5.13：沿用项目 ensureTables 模式，首次调用自动建表，
// 无需手动执行 schema.sql 即可启用 PoW 防护；每个 isolate 只尝试一次，失败后下次请求重试）
let _tablesReadyPromise = null;
async function ensurePoWTables(env) {
  if (!_tablesReadyPromise) {
    _tablesReadyPromise = (async () => {
      try {
        await env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS site_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
          )`
        ).run();
        await env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS register_challenges (
            id TEXT PRIMARY KEY,
            used INTEGER DEFAULT 0,
            issued_at TEXT DEFAULT (datetime('now'))
          )`
        ).run();
        await env.DB.prepare(
          `CREATE INDEX IF NOT EXISTS idx_register_challenges_issued ON register_challenges(issued_at)`
        ).run();
        return true;
      } catch (e) {
        console.warn('[POW] 数据表自动创建失败:', e.message);
        _tablesReadyPromise = null; // 失败不缓存，下次请求重试
        return false;
      }
    })();
  }
  return _tablesReadyPromise;
}

// 签发挑战：返回 { ok, data } 或 { ok:false, disabled:true }（表未就绪时降级）
export async function issueChallenge(env) {
  const ready = await ensurePoWTables(env);
  if (!ready) {
    console.warn('[POW] register_challenges 表不存在，PoW 防护已降级（请重跑 schema.sql）');
    return { ok: true, disabled: true };
  }
  const secret = await getPoWSecret(env);
  if (!secret) return { ok: true, disabled: true };

  let difficulty = parseInt(env.REGISTER_POW_DIFFICULTY || '', 10);
  if (isNaN(difficulty) || difficulty < 16) difficulty = POW_DEFAULT_DIFFICULTY;
  if (difficulty > POW_MAX_DIFFICULTY) difficulty = POW_MAX_DIFFICULTY;

  const id = generateToken().slice(0, 24);
  const challenge = generateToken().slice(0, 32); // 随机 128bit 挑战串
  const expires = Date.now() + POW_MAX_AGE_SECONDS * 1000;

  // 记录签发时间：用于单次有效 + 最短填写时间校验
  await env.DB.prepare(
    `INSERT INTO register_challenges (id, issued_at) VALUES (?, datetime('now'))`
  ).bind(id).run();

  // 顺带清理 1 天前的过期挑战（10% 概率触发，避免表膨胀）
  if (Math.random() < 0.1) {
    env.DB.prepare(
      `DELETE FROM register_challenges WHERE CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', issued_at) AS INTEGER) > 86400`
    ).run().catch(() => {});
  }

  const payload = base64urlEncode(JSON.stringify({ i: id, c: challenge, d: difficulty, e: expires }));
  const sig = await hmacHex(secret, payload);
  return { ok: true, data: { token: payload + '.' + sig, challenge, difficulty } };
}

// 校验挑战（只读，不消耗；消耗由 consumeChallenge 在注册落库前原子执行）
// 返回 { ok: true } 或 { ok: false, error }
export async function verifyChallenge(env, token, nonce) {
  const ready = await ensurePoWTables(env);
  if (!ready) return { ok: true, skipped: true }; // 表未就绪 → 降级放行
  if (!token || !nonce) return { ok: false, error: '注册验证未完成，请刷新页面重试' };

  const dot = String(token).lastIndexOf('.');
  if (dot <= 0) return { ok: false, error: '注册验证参数无效' };
  const payloadB64 = String(token).slice(0, dot);
  const sig = String(token).slice(dot + 1);

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64));
  } catch (e) {
    return { ok: false, error: '注册验证参数无效' };
  }
  if (!payload || !payload.i || !payload.c || !payload.d || !payload.e) {
    return { ok: false, error: '注册验证参数无效' };
  }

  // HMAC 校验（使用提交的 payload 原文验签，防止篡改难度/过期时间/挑战内容）
  const secret = await getPoWSecret(env);
  if (!secret) return { ok: true, skipped: true };
  const expectSig = await hmacHex(secret, payloadB64);
  if (sig !== expectSig) return { ok: false, error: '注册验证参数无效' };

  // 过期校验
  if (Date.now() > payload.e) return { ok: false, error: '注册验证已过期，请刷新页面重试' };

  // 最短填写时间校验（签发后至少 POW_MIN_AGE_SECONDS 秒才能提交，脚本秒回直接拒绝）
  try {
    const row = await env.DB.prepare(
      `SELECT CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', issued_at) AS INTEGER) AS age
       FROM register_challenges WHERE id = ? AND used = 0`
    ).bind(payload.i).first();
    if (!row) return { ok: false, error: '注册验证已失效，请刷新页面重试' };
    if (row.age < POW_MIN_AGE_SECONDS) return { ok: false, error: '操作过快，请稍候 2 秒后再提交' };
    if (row.age > POW_MAX_AGE_SECONDS) return { ok: false, error: '注册验证已过期，请刷新页面重试' };
  } catch (e) {
    console.warn('[POW] 挑战记录校验失败（降级放行）:', e.message);
    return { ok: true, skipped: true };
  }

  // 工作量证明校验：SHA-256(challenge:nonce) 需有 payload.d 个前导零位
  try {
    const data = new TextEncoder().encode(payload.c + ':' + String(nonce));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    if (leadingZeroBits(digest) < payload.d) {
      return { ok: false, error: '注册验证未通过，请刷新页面重试' };
    }
  } catch (e) {
    return { ok: false, error: '注册验证失败，请重试' };
  }
  return { ok: true, id: payload.i };
}

// 消耗挑战（原子单次有效；必须在所有其他校验通过、即将写入用户前调用）
export async function consumeChallenge(env, id) {
  if (!id) return false;
  try {
    const result = await env.DB.prepare(
      `UPDATE register_challenges SET used = 1 WHERE id = ? AND used = 0`
    ).bind(id).run();
    return result && result.meta && result.meta.changes === 1;
  } catch (e) {
    console.warn('[POW] 挑战消耗失败（降级放行）:', e.message);
    return true; // 表异常时不阻塞注册
  }
}

// 统计前导零位数
function leadingZeroBits(u8) {
  let bits = 0;
  for (let i = 0; i < u8.length; i++) {
    const b = u8[i];
    if (b === 0) { bits += 8; continue; }
    for (let j = 7; j >= 0; j--) {
      if (b & (1 << j)) return bits;
      bits++;
    }
  }
  return bits;
}

// 获取 Tor 出口节点 IP 集合（D1 缓存 6 小时；拉取失败时回退旧缓存；完全不可用返回 null → 放行）
async function getTorExitSet(env) {
  let stale = null;
  try {
    const row = await env.DB.prepare(
      `SELECT value FROM site_settings WHERE key = 'tor_exit_list_cache'`
    ).first();
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      if (parsed && Array.isArray(parsed.l)) {
        if (parsed.t && Date.now() - parsed.t < TOR_LIST_TTL_MS) return new Set(parsed.l);
        stale = new Set(parsed.l);
      }
    }
  } catch (e) { /* 缓存读取失败忽略 */ }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch('https://check.torproject.org/torbulkexitlist', { signal: ctrl.signal });
    clearTimeout(timer);
    if (resp.ok) {
      const text = await resp.text();
      const list = text.split('\n').map(s => s.trim()).filter(s => /^\d+\.\d+\.\d+\.\d+$/.test(s));
      if (list.length > 0) {
        try {
          await env.DB.prepare(
            `INSERT INTO site_settings (key, value, updated_at) VALUES ('tor_exit_list_cache', ?, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
          ).bind(JSON.stringify({ t: Date.now(), l: list })).run();
        } catch (e) { /* 缓存写入失败不影响本次判断 */ }
        return new Set(list);
      }
    }
  } catch (e) { /* 拉取失败回退旧缓存 */ }
  return stale;
}

// 检查客户端 IP 是否为 Tor 出口节点（env.BLOCK_TOR_REGISTRATION = 'off' 可关闭）
export async function isTorExitIP(env, clientIP) {
  if (env.BLOCK_TOR_REGISTRATION === 'off') return false;
  if (!clientIP || clientIP === 'unknown') return false;
  const set = await getTorExitSet(env);
  if (!set) return false; // 列表不可用 → 放行（fail-open），不阻塞正常注册
  return set.has(clientIP);
}
