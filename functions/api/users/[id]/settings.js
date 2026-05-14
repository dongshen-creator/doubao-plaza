// Cloudflare Pages Function - User Settings
// PUT /api/users/[id]/settings

export async function onRequestPut(context) {
  const { env } = context;
  const userId = context.params.id;
  const body = await context.request.json();
  const { action, password, invite_code, privacy_setting } = body;

  try {
    if (action === 'change_password') {
      if (!password || password.length !== 6) {
        return Response.json({ success: false, error: '新密码必须为6位' });
      }
      await env.DB.prepare(`UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(password, userId).run();
      return Response.json({ success: true, message: '密码修改成功' });
    }

    if (action === 'set_invite_code') {
      await env.DB.prepare(`UPDATE users SET invite_code = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(invite_code || null, userId).run();
      return Response.json({ success: true, message: '邀请码设置成功' });
    }

    if (action === 'set_privacy') {
      if (!['searchable', 'whitelist', 'stealth'].includes(privacy_setting)) {
        return Response.json({ success: false, error: '无效的隐私设置' });
      }
      await env.DB.prepare(`UPDATE users SET privacy_setting = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(privacy_setting, userId).run();
      return Response.json({ success: true, message: '隐私设置已更新' });
    }

    return Response.json({ success: false, error: '未知操作' });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
