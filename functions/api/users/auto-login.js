// Cloudflare Pages Function - Auto Login
// POST /api/users/auto-login
// V11.0：会话轮换前必须确认设备。Cookie 被清除时通过多维历史信号恢复原设备；
// 强信号不足或设备被封禁时拒绝续期并要求密码重新登录，避免仅清 Cookie / 换代理绕过处置。

import { signSupabaseJWT, generateToken } from '../_lib/jwt.js';
import { resolveClientIp } from '../_lib/clientip.js';
import {
  ensureDeviceSignalSchema,
  resolveAuthDevice,
  observeDeviceSignals,
  logRiskEvent,
  cfMeta,
} from '../_lib/device.js';

// 统一 no-store JSON 响应：含 token 的响应禁止任何缓存
function jsonNoStore(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(init.headers || {}),
    },
  });
}

async function checkAndUpdatePunishment(env, userId) {
  if (!env.DB) throw new Error('数据库未绑定');
  const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId).first();
  if (!user) return null;
  if (user.privacy_setting === 'punished_whitelist' && user.punished_until) {
    const now = new Date().toISOString();
    if (user.punished_until < now) {
      await env.DB.prepare(
        `UPDATE users SET privacy_setting = 'searchable', punished_until = NULL, punish_reason = NULL WHERE id = ?`
      ).bind(userId).run();
      user.privacy_setting = 'searchable';
    }
  }
  return user;
}

function deviceHeaders(devRes) {
  return devRes && devRes.header ? { 'Set-Cookie': devRes.header } : {};
}

export async function onRequestPost(context) {
  if (!context.env.DB) {
    return jsonNoStore({ success: false, error: '数据库未绑定，请在Cloudflare Pages设置中绑定D1数据库' }, { status: 500 });
  }

  try {
    const { env, request } = context;
    const body = await request.json().catch(() => ({}));
    const token = String(body.token || '');
    if (!token) return jsonNoStore({ success: false, error: '无会话token' });

    // 运行时幂等补列，避免未执行迁移脚本时旧库查询失败。
    try { await ensureDeviceSignalSchema(env); } catch (error) {
      console.warn('[auto-login] schema migration failed:', error.message);
    }

    const session = await env.DB.prepare(
      `SELECT s.user_id AS session_user_id, s.token, s.expires_at, s.device_id AS session_device_id, u.*
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')`
    ).bind(token).first();

    if (!session) return jsonNoStore({ success: false, error: '会话已过期' });
    const userId = session.session_user_id;

    // V8.0 惩罚性隐身：隔离 / 停用账号的旧会话一律按「过期」处理并撤销全部会话。
    if (session.quarantined_at || session.deactivated_at) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM stepup_tokens WHERE user_id = ?').bind(userId),
      ]);
      return jsonNoStore({ success: false, error: '会话已过期' });
    }

    const ip = resolveClientIp(request) || 'unknown';
    const meta = cfMeta(request);
    const ua = request.headers.get('User-Agent') || '';
    const devRes = await resolveAuthDevice(env, request, ip, body);

    if (devRes.banned) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM stepup_tokens WHERE user_id = ?').bind(userId),
      ]);
      await logRiskEvent(env, {
        event_type: 'auto_login', user_id: userId, device_id: devRes.device && devRes.device.id,
        ip, ...meta, ua, action: 'blocked', risk_score: 90,
        detail: { reason: 'banned_device', recovered: !!devRes.recovered },
      });
      return jsonNoStore(
        { success: false, need_reauth: true, error: '设备环境需要重新确认，请重新登录' },
        { status: 403, headers: deviceHeaders(devRes) }
      );
    }

    // 无设备凭据或设备已绑定其他账号，均不得用长期会话自动给自己补新设备。
    if (!devRes.device || (devRes.bindingUserId && devRes.bindingUserId !== userId)) {
      await logRiskEvent(env, {
        event_type: 'auto_login', user_id: userId, device_id: devRes.device && devRes.device.id,
        ip, ...meta, ua, action: 'blocked', risk_score: 70,
        detail: { reason: devRes.device ? 'device_bound_to_other' : 'device_unverified', recovered: !!devRes.recovered },
      });
      return jsonNoStore(
        { success: false, need_reauth: true, error: '设备环境需要重新确认，请重新登录' },
        { status: 403, headers: deviceHeaders(devRes) }
      );
    }

    let trusted = !!devRes.bindingUserId || session.session_device_id === devRes.device.id;
    if (!trusted) {
      const history = await env.DB.prepare(
        `SELECT 1 AS found FROM risk_events
         WHERE user_id = ? AND device_id = ? AND action = 'allowed'
           AND event_type IN ('register', 'login_ok', 'auto_login', 'device_rebind')
         LIMIT 1`
      ).bind(userId, devRes.device.id).first();
      trusted = !!history && (!!devRes.recovered || devRes.matchScore >= 100);
    }
    if (!trusted) {
      await logRiskEvent(env, {
        event_type: 'auto_login', user_id: userId, device_id: devRes.device.id,
        ip, ...meta, ua, action: 'blocked', risk_score: 55,
        detail: { reason: 'device_not_trusted_for_session', match_score: devRes.matchScore || 0 },
      });
      return jsonNoStore(
        { success: false, need_reauth: true, error: '设备环境需要重新确认，请重新登录' },
        { status: 403, headers: deviceHeaders(devRes) }
      );
    }

    // Token 轮换：旧会话删除与新会话签发在同一批次内提交，防止并发请求产生多个有效会话。
    const newToken = generateToken();
    const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token),
      env.DB.prepare(
        `INSERT INTO sessions (user_id, token, expires_at, device_id, created_ip, last_seen_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`
      ).bind(userId, newToken, newExpiresAt, devRes.device.id, ip),
      env.DB.prepare(
        `UPDATE users SET last_login_at = datetime('now'), last_active_at = datetime('now'),
         last_login_ip = ?, last_login_ua = ? WHERE id = ?`
      ).bind(ip, ua, userId),
    ]);

    // 签发 Supabase JWT（用于 RLS 鉴权）
    const supabaseToken = await signSupabaseJWT(userId, env);
    const user = await checkAndUpdatePunishment(env, userId);
    if (!user) return jsonNoStore({ success: false, error: '用户不存在' });

    await observeDeviceSignals(env, devRes.device.id, body, request, ip);
    await logRiskEvent(env, {
      event_type: 'auto_login', user_id: userId, device_id: devRes.device.id,
      ip, ...meta, ua, action: 'allowed',
      risk_score: devRes.recovered ? 20 : 0,
      detail: {
        recovered_device: !!devRes.recovered,
        match_score: devRes.matchScore || 0,
        matched_signals: devRes.matchedSignals || [],
      },
    });

    const safeUser = {
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      bio: user.bio,
      doubao_id: user.doubao_id,
      agent_url: user.agent_url,
      is_developer: user.is_developer,
      is_global_admin: user.is_global_admin || 0,
      privacy_setting: user.privacy_setting,
      invite_code: user.invite_code,
      created_at: user.created_at,
      updated_at: user.updated_at,
      last_login_at: user.last_login_at,
      last_active_at: user.last_active_at,
      last_login_ip: ip,
      last_login_ua: ua,
      pat_suffix: user.pat_suffix,
    };

    return jsonNoStore(
      { success: true, data: safeUser, token: newToken, supabase_token: supabaseToken },
      { headers: deviceHeaders(devRes) }
    );
  } catch (e) {
    console.error('[auto-login] 服务器错误:', e);
    return jsonNoStore({ success: false, error: '服务器错误，请稍后再试' });
  }
}
