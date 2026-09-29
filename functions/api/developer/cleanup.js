// Cloudflare Pages Function - Developer 历史账号清理（备份→预演→阈值→分批软删→可恢复）
// GET  /api/developer/cleanup                 - 最近运行列表（预演/执行摘要）
// POST /api/developer/cleanup
//   { action:'dry_run',  inactive_days }      - 预演：冻结候选名单+cutoff，落 cleanup_runs（名单即备份清单）
//   { action:'execute',  run_id, confirm }    - 执行：confirm 必须等于预演总数；每次最多 50 条，UI 循环调用
//   { action:'restore',  run_id }              - 恢复：按执行名单回滚软删（deactivated_at/purge_after 清空）
// 全部要求 step-up；软删只打标不删行（purge_after 仅标记，最终清除为后续独立流程）
// 安全阀：开发者/隔离/已软删账号永不入候选；执行时二次校验活跃度，活跃账号自动跳过
import { requireDeveloper, devJson, devErr } from '../_lib/devauth.js';
import { writeAdminAudit } from '../_lib/audit.js';
import { logRiskEvent, getClientIp, cfMeta } from '../_lib/device.js';

const BATCH_MAX = 50;          // 单次 execute 软删上限（分批执行，UI 循环至完成）
const CANDIDATE_MAX = 5000;    // 预演名单上限（防御性；当前总量远低于此）
const MIN_DAYS = 30;           // 不活跃阈值下限（防误伤）
const MAX_DAYS = 3650;

function parseReport(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

// ── 预演 ──
async function dryRun(env, gate, inactiveDays) {
  const days = Math.floor(Number(inactiveDays));
  if (!Number.isFinite(days) || days < MIN_DAYS || days > MAX_DAYS) {
    return devErr(`不活跃阈值需在 ${MIN_DAYS}-${MAX_DAYS} 天之间`, 400);
  }

  // cutoff 直接用 SQL 计算，避免 JS/SQLite 时间漂移
  const cut = await env.DB.prepare(
    `SELECT datetime('now', ?) AS cutoff`
  ).bind(`-${days} days`).first();
  const cutoff = cut.cutoff;

  const cand = await env.DB.prepare(
    `SELECT id, name, doubao_id, created_at,
            COALESCE(last_active_at, last_login_at, created_at) AS last_seen
     FROM users
     WHERE deactivated_at IS NULL
       AND quarantined_at IS NULL
       AND is_developer = 0
       AND COALESCE(last_active_at, last_login_at, created_at) <= ?
     ORDER BY last_seen ASC
     LIMIT ?`
  ).bind(cutoff, CANDIDATE_MAX + 1).all();
  const rows = (cand && cand.results) || [];
  const truncated = rows.length > CANDIDATE_MAX;
  const candidates = rows.slice(0, CANDIDATE_MAX);

  // 排除统计（透明化：让操作者知道谁没被算进去、为什么）
  const excl = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN deactivated_at IS NOT NULL THEN 1 ELSE 0 END) AS already_softdeleted,
       SUM(CASE WHEN quarantined_at IS NOT NULL THEN 1 ELSE 0 END) AS quarantined,
       SUM(CASE WHEN is_developer = 1 THEN 1 ELSE 0 END) AS developers,
       COUNT(*) AS total
     FROM users`
  ).first();

  const report = {
    kind: 'dry_run',
    threshold_days: days,
    cutoff,
    total: candidates.length,
    truncated,
    excluded: {
      already_softdeleted: (excl && excl.already_softdeleted) || 0,
      quarantined: (excl && excl.quarantined) || 0,
      developers: (excl && excl.developers) || 0,
    },
    // 名单 = 备份清单：软删不删行，本快照用于执行前核对与事后恢复对照
    candidates,
    created_by: gate.userId,
    generated_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };

  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  await env.DB.prepare(
    `INSERT INTO cleanup_runs (id, mode, report, finished_at) VALUES (?, 'dry_run', ?, datetime('now'))`
  ).bind(runId, JSON.stringify(report)).run();

  await writeAdminAudit(env, {
    actorId: gate.userId, action: 'cleanup_dryrun', target: runId,
    detail: { threshold_days: days, total: candidates.length },
  });

  return devJson({ success: true, data: { run_id: runId, report } });
}

// ── 执行（分批） ──
async function execute(env, gate, request, runId, confirm) {
  const src = await env.DB.prepare(
    `SELECT id, mode, report FROM cleanup_runs WHERE id = ?`
  ).bind(String(runId || '').slice(0, 64)).first();
  if (!src || src.mode !== 'dry_run') return devErr('预演记录不存在', 404);

  const report = parseReport(src.report);
  if (!report || !Array.isArray(report.candidates)) return devErr('预演报告损坏', 500);

  // 阈值确认：确认数必须与预演总数完全一致（防拿旧名单误执行）
  const confirmNum = Math.floor(Number(confirm));
  if (!Number.isFinite(confirmNum) || confirmNum !== report.total) {
    return devErr(`确认数不符：请输入预演报告总数 ${report.total}`, 400, {
      expected: report.total,
    });
  }
  if (report.total === 0) return devErr('预演候选为空，无需执行', 400);

  // 取执行进度（execute 运行记录，无则创建）
  let ex = await env.DB.prepare(
    `SELECT id, report FROM cleanup_runs WHERE mode = 'execute' AND json_extract(report, '$.source_run_id') = ?`
  ).bind(report.run_id || src.id).first();
  let exReport;
  if (ex) {
    exReport = parseReport(ex.report) || {};
  } else {
    ex = { id: crypto.randomUUID().replace(/-/g, '').slice(0, 32) };
    exReport = {
      kind: 'execute',
      source_run_id: src.id,
      total: report.total,
      processed: [],
      skipped: [],
      batches: 0,
      done: false,
      created_by: gate.userId,
    };
  }

  const doneSet = new Set(exReport.processed || []);
  const skipSet = new Set(exReport.skipped || []);
  // 本轮候选：冻结名单中尚未处理的，单批 ≤ BATCH_MAX
  const pending = report.candidates
    .filter((c) => !doneSet.has(c.id) && !skipSet.has(c.id))
    .slice(0, BATCH_MAX);

  if (!pending.length) {
    exReport.done = true;
    exReport.finished_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await env.DB.prepare(
      `UPDATE cleanup_runs SET report = ?, finished_at = datetime('now') WHERE id = ?`
    ).bind(JSON.stringify(exReport), ex.id).run();
    return devJson({
      success: true,
      data: { run_id: ex.id, processed_total: (exReport.processed || []).length,
              skipped_total: (exReport.skipped || []).length, remaining: 0, done: true },
    });
  }

  const ids = pending.map((p) => p.id);
  const placeholders = ids.map(() => '?').join(',');

  // 二次资格校验（活跃度可能已更新）→ 得到本轮真正可软删的 id
  const elig = await env.DB.prepare(
    `SELECT id FROM users
     WHERE id IN (${placeholders})
       AND deactivated_at IS NULL
       AND quarantined_at IS NULL
       AND is_developer = 0
       AND COALESCE(last_active_at, last_login_at, created_at) <= ?`
  ).bind(...ids, report.cutoff).all();
  const eligibleIds = ((elig && elig.results) || []).map((r) => r.id);
  const skippedNow = ids.filter((id) => eligibleIds.indexOf(id) === -1);

  if (eligibleIds.length) {
    const ph2 = eligibleIds.map(() => '?').join(',');
    // 三步原子批量：软删打标 + 撤销会话 + 释放设备绑定
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE users
         SET deactivated_at = datetime('now'),
             purge_after = datetime('now', '+30 days')
         WHERE id IN (${ph2}) AND deactivated_at IS NULL`
      ).bind(...eligibleIds),
      env.DB.prepare(`DELETE FROM sessions WHERE user_id IN (${ph2})`).bind(...eligibleIds),
      env.DB.prepare(
        `UPDATE device_accounts SET status = 'released', released_at = datetime('now'),
         release_reason = 'cleanup'
         WHERE user_id IN (${ph2}) AND status = 'active'`
      ).bind(...eligibleIds),
    ]);
    exReport.processed = (exReport.processed || []).concat(eligibleIds);
  }
  if (skippedNow.length) {
    exReport.skipped = (exReport.skipped || []).concat(skippedNow);
  }
  exReport.batches = (exReport.batches || 0) + 1;

  const remaining = report.total -
    ((exReport.processed || []).length + (exReport.skipped || []).length);

  await env.DB.prepare(
    `INSERT INTO cleanup_runs (id, mode, report, finished_at)
     VALUES (?, 'execute', ?, CASE WHEN ? <= 0 THEN datetime('now') ELSE NULL END)
     ON CONFLICT(id) DO UPDATE SET report = excluded.report,
       finished_at = CASE WHEN ? <= 0 THEN datetime('now') ELSE cleanup_runs.finished_at END`
  ).bind(ex.id, JSON.stringify(exReport), remaining, remaining).run();

  await writeAdminAudit(env, {
    actorId: gate.userId, action: 'cleanup_execute', target: ex.id,
    detail: { batch: exReport.batches, just_processed: eligibleIds.length,
              just_skipped: skippedNow.length, remaining },
  });

  if (remaining <= 0) {
    exReport.done = true;
    await env.DB.prepare(
      `UPDATE cleanup_runs SET report = ? WHERE id = ?`
    ).bind(JSON.stringify(exReport), ex.id).run();
    const ip = getClientIp(request);
    const cmeta = cfMeta(request);
    await logRiskEvent(env, {
      event_type: 'cleanup', user_id: gate.userId, ip, ...cmeta,
      ua: request.headers.get('User-Agent') || '',
      action: 'allowed', risk_score: 0,
      detail: { source_run: src.id, processed: (exReport.processed || []).length,
                skipped: (exReport.skipped || []).length },
    });
  }

  return devJson({
    success: true,
    data: {
      run_id: ex.id,
      processed_total: (exReport.processed || []).length,
      skipped_total: (exReport.skipped || []).length,
      remaining: Math.max(0, remaining),
      done: remaining <= 0,
    },
  });
}

// ── 恢复（按执行名单回滚软删） ──
async function restore(env, gate, runId) {
  const ex = await env.DB.prepare(
    `SELECT id, report FROM cleanup_runs WHERE id = ? AND mode = 'execute'`
  ).bind(String(runId || '').slice(0, 64)).first();
  if (!ex) return devErr('执行记录不存在', 404);
  const report = parseReport(ex.report);
  const ids = (report && Array.isArray(report.processed)) ? report.processed : [];
  if (!ids.length) return devErr('该运行没有已软删账号', 400);

  // 分片恢复（每片 200，防 SQL 参数上限）
  let restored = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const ph = slice.map(() => '?').join(',');
    const r = await env.DB.prepare(
      `UPDATE users SET deactivated_at = NULL, purge_after = NULL
       WHERE id IN (${ph}) AND deactivated_at IS NOT NULL`
    ).bind(...slice).run();
    restored += (r && r.meta && r.meta.changes) || 0;
  }

  await writeAdminAudit(env, {
    actorId: gate.userId, action: 'cleanup_restore', target: ex.id,
    detail: { requested: ids.length, restored },
  });
  return devJson({ success: true, data: { run_id: ex.id, restored, requested: ids.length } });
}

// ── GET：运行列表 ──
export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return devErr('数据库未绑定', 500);
  try {
    const gate = await requireDeveloper(env, request, { stepup: true });
    if (!gate.ok) return gate.response;

    const rows = await env.DB.prepare(
      `SELECT id, mode, started_at, finished_at, report FROM cleanup_runs
       ORDER BY started_at DESC LIMIT 20`
    ).all();
    const runs = ((rows && rows.results) || []).map((r) => {
      const rp = parseReport(r.report) || {};
      return {
        id: r.id,
        mode: r.mode,
        started_at: r.started_at,
        finished_at: r.finished_at,
        source_run_id: rp.source_run_id || null,
        threshold_days: rp.threshold_days || null,
        cutoff: rp.cutoff || null,
        total: rp.total != null ? rp.total : (rp.processed ? rp.processed.length + (rp.skipped || []).length : null),
        processed: Array.isArray(rp.processed) ? rp.processed.length : null,
        skipped: Array.isArray(rp.skipped) ? rp.skipped.length : null,
        done: rp.done != null ? rp.done : (r.mode === 'dry_run' ? true : !!r.finished_at),
      };
    });
    return devJson({ success: true, data: { runs } });
  } catch (e) {
    console.error('[DEV-CLEANUP] GET error:', e.message);
    return devErr('服务器错误', 500);
  }
}

// ── POST：dry_run / execute / restore ──
export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return devErr('数据库未绑定', 500);
  try {
    const gate = await requireDeveloper(env, request, { stepup: true });
    if (!gate.ok) return gate.response;

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '');

    if (action === 'dry_run') return dryRun(env, gate, body.inactive_days);
    if (action === 'execute') {
      return execute(env, gate, request, body.run_id, body.confirm);
    }
    if (action === 'restore') return restore(env, gate, body.run_id);

    return devErr('未知操作', 400);
  } catch (e) {
    console.error('[DEV-CLEANUP] POST error:', e.message);
    return devErr('服务器错误', 500);
  }
}
