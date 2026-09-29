// V8.0 Cloudflare Turnstile 人机验证（共享实现）
// 未配置 TURNSTILE_SECRET 时跳过验证（向后兼容，与原 users.js 行为一致）

export async function verifyTurnstile(token, env, remoteIP) {
  // 如果未配置 Turnstile 密钥，跳过验证（向后兼容）
  if (!env.TURNSTILE_SECRET) return { success: true, skipped: true };
  if (!token) return { success: false, error: '请完成人机验证' };
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip: remoteIP || '',
      }),
    });
    const data = await resp.json();
    if (data.success) return { success: true };
    return { success: false, error: '人机验证失败，请重试' };
  } catch (e) {
    return { success: false, error: '人机验证服务异常' };
  }
}
