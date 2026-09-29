// Cloudflare Pages Function - Developer 审计日志查询
// GET /api/developer/audit?limit=100&action=stepup
// 高危只读通道：要求 step-up；查询行为本身也写审计
import { requireDeveloper, devJson, devErr } from '../_lib/devauth.js';
import { writeAdminAudit } from '../_lib/audit.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return devErr('数据库未绑定', 500);
  try {
    const gate = await requireDeveloper(env, request, { stepup: true });
    if (!gate.ok) return gate.response;

    const url = new URL(request.url);
    let limit = parseInt(url.searchParams.get('limit') || '100', 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 100;
    if (limit > 200) limit = 200;
    const action = (url.searchParams.get('action') || '').trim().slice(0, 50);

    let rows;
    if (action) {
      rows = await env.DB.prepare(
        `SELECT id, actor_id, action, target, detail, created_at FROM admin_audit_log
         WHERE action = ? ORDER BY created_at DESC LIMIT ?`
      ).bind(action, limit).all();
    } else {
      rows = await env.DB.prepare(
        `SELECT id, actor_id, action, target, detail, created_at FROM admin_audit_log
         ORDER BY created_at DESC LIMIT ?`
      ).bind(limit).all();
    }

    await writeAdminAudit(env, {
      actorId: gate.userId, action: 'audit_view',
      detail: { filter: action || 'all', limit },
    });

    return devJson({ success: true, data: (rows && rows.results) || [] });
  } catch (e) {
    console.error('[DEV-AUDIT] error:', e.message);
    return devErr('服务器错误', 500);
  }
}
