// AI 工具端点 - 统一处理所有 AI 类工具
// POST /api/tools/ai — AI工具统一入口
// Body: { tool_id, message, history?, stream? }

import { findTool } from './registry.js';

// 简易速率限制（基于 D1 site_settings 表，每用户每小时 30 次）
async function checkRateLimit(env, userId) {
  const hourKey = `ai_rl_${userId}_${Math.floor(Date.now() / 3600000)}`;
  try {
    const row = await env.DB.prepare(
      `SELECT value FROM site_settings WHERE key = ?`
    ).bind(hourKey).first();
    const count = row ? parseInt(row.value) : 0;
    if (count >= 30) return false;
    await env.DB.prepare(
      `INSERT INTO site_settings (key, value, updated_at) VALUES (?, '1', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = datetime('now')`
    ).bind(hourKey).run();
    return true;
  } catch (e) {
    // site_settings 表可能不存在，放行
    return true;
  }
}

// 从请求头获取用户 ID
async function getAuthUserId(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const session = await env.DB.prepare(
      `SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`
    ).bind(token).first();
    return session ? session.user_id : null;
  } catch (e) {
    return null;
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;

  // 检查 AI 绑定是否存在
  if (!env.AI) {
    return Response.json(
      { success: false, error: 'AI 服务未绑定。请在 Cloudflare Dashboard → Settings → Functions → AI bindings 中配置绑定（变量名 AI）。' },
      { status: 503, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }

  try {
    const body = await request.json();
    const { tool_id, message, history, stream } = body;

    // 查找工具定义
    const tool = findTool(tool_id);
    if (!tool) {
      return Response.json({ success: false, error: '未知工具: ' + tool_id }, { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    // 鉴权
    const userId = await getAuthUserId(env, request);
    if (!userId) {
      return Response.json({ success: false, error: '请先登录后使用 AI 工具' }, { status: 401, headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    // 速率限制
    const allowed = await checkRateLimit(env, userId);
    if (!allowed) {
      return Response.json({ success: false, error: 'AI 调用频率超限（每小时30次），请稍后再试' }, { status: 429, headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    // === AI 文本对话（ai_chat）===
    if (tool.api_type === 'ai_chat') {
      const userContent = message || body.text || '';
      if (!userContent) {
        return Response.json({ success: false, error: '消息不能为空' }, { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
      }

      const messages = [
        { role: 'system', content: tool.system_prompt || '你是逗包用户广场的AI助手。' },
        ...(Array.isArray(history) ? history : []),
        { role: 'user', content: userContent }
      ];

      if (stream !== false) {
        // 流式输出
        const aiStream = await env.AI.run(tool.model, {
          messages,
          stream: true,
          max_tokens: tool.max_tokens || 512
        });

        // 将 Workers AI 的 ReadableStream 包装为标准 SSE 格式
        const { readable, writable } = new TransformStream({
          transform(chunk, controller) {
            let text = '';
            if (typeof chunk === 'string') {
              text = chunk;
            } else if (chunk && typeof chunk === 'object') {
              text = chunk.response || chunk.text || chunk.content || '';
            }
            if (text) {
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify({ text })}\n\n`)
              );
            }
          },
          flush(controller) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          }
        });

        // pipeTo 需要 await 但不阻塞 Response 返回
        aiStream.pipeTo(writable).catch(() => {});

        return new Response(readable, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } else {
        // 非流式
        const response = await env.AI.run(tool.model, {
          messages,
          max_tokens: tool.max_tokens || 512
        });
        const text = typeof response === 'string' ? response : (response.response || response.text || '');
        return Response.json({ success: true, data: { text } }, { headers: { 'Access-Control-Allow-Origin': '*' } });
      }
    }

    // === AI 图片生成（ai_image）===
    if (tool.api_type === 'ai_image') {
      const prompt = message || body.prompt || '';
      if (!prompt) {
        return Response.json({ success: false, error: '图片描述不能为空' }, { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
      }

      const response = await env.AI.run(tool.model, { prompt });

      // flux 返回 { image: Uint8Array } 或直接返回二进制
      let imageBytes = null;
      if (response instanceof Uint8Array || response instanceof ArrayBuffer) {
        imageBytes = response;
      } else if (response && response.image) {
        imageBytes = response.image;
      } else if (response instanceof ReadableStream) {
        imageBytes = new Uint8Array(await new Response(response).arrayBuffer());
      }

      if (!imageBytes) {
        return Response.json({ success: false, error: '图片生成失败，未返回有效数据' }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
      }

      return new Response(imageBytes, {
        headers: {
          'Content-Type': 'image/png',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    return Response.json({ success: false, error: '不支持的工具类型: ' + tool.api_type }, { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
  } catch (e) {
    return Response.json(
      { success: false, error: 'AI 服务错误：' + (e.message || String(e)) },
      { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } }
    );
  }
}
