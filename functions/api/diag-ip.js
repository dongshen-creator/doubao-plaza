// 临时诊断端点（V12.3 排查用，验证完即删除）
// 复现 issueDevice 的 INSERT，把真实异常文本暴露出来（issueDevice 内部只 console.warn）
import { resolveClientIp } from './_lib/clientip.js';

const HEX = 'abcdef0123456789';
function rand(n) { let s = ''; for (let i = 0; i < n; i++) s += HEX[Math.floor(Math.random() * 16)]; return s; }

export async function onRequest(context) {
  const { request, env } = context;
  const ip = resolveClientIp(request, env) || 'unknown';
  const out = { ok: true, ip };

  try {
    const st = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM devices WHERE created_ip = ? AND created_at > datetime('now','-1 hour')) AS h,
              (SELECT COUNT(*) FROM devices WHERE created_ip = ? AND created_at > datetime('now','-24 hours')) AS d`
    ).bind(ip, ip).first();
    out.counts = st;
  } catch (e) { out.countsError = e.message; }

  try {
    await env.DB.prepare(
      `INSERT INTO devices (id, token_hash, claim_count, created_ip, last_seen_at, last_claim_at)
       VALUES (?, ?, 1, ?, datetime('now'), datetime('now'))`
    ).bind(rand(32), rand(64), ip).run();
    out.insert = 'ok';
  } catch (e) { out.insertError = e.message; }

  try {
    const cols = await env.DB.prepare(`PRAGMA table_info(devices)`).all();
    out.columns = (cols.results || []).map((c) => `${c.name}${c.notnull ? '!' : ''}${c.dflt_value != null ? '=' + c.dflt_value : ''}`);
  } catch (e) { out.columnsError = e.message; }

  return Response.json(out, { headers: { 'Cache-Control': 'no-store' } });
}
