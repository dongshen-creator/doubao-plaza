// Cloudflare Pages Function - 注册防滥用挑战（V5.13 新增）
// GET /api/users/register-challenge - 签发注册工作量证明（PoW）挑战
//
// 流程：前端注册前请求本接口 → 拿到 {token, challenge, difficulty} →
//       本地计算 nonce 使 SHA-256(challenge:nonce) 有 difficulty 个前导零位 →
//       注册请求（POST /api/users）携带 pow_token + pow_nonce，服务端验证。
// 目的：批量注册每号需支付真实算力成本，与 IP 无关，抗 Tor/代理 IP 轮换。
// 兼容：register_challenges 表未创建时返回 { data: { disabled: true } }，前端跳过。

import { issueChallenge } from '../_lib/pow.js';

export async function onRequestGet(context) {
  if (!context.env || !context.env.DB) {
    return Response.json({ success: false, error: '数据库未绑定' }, { status: 500 });
  }
  try {
    const result = await issueChallenge(context.env);
    if (!result.ok) {
      return Response.json({ success: false, error: '获取验证挑战失败' }, { status: 500 });
    }
    if (result.disabled) {
      return Response.json({ success: true, data: { disabled: true } });
    }
    return Response.json({ success: true, data: result.data });
  } catch (e) {
    // 异常时降级：返回 disabled 让前端跳过 PoW，不阻塞注册
    console.error('[register-challenge] 签发失败:', e.message);
    return Response.json({ success: true, data: { disabled: true } });
  }
}
