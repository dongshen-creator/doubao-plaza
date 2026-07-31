// Cloudflare Pages Function - tmpfile.link 文件上传 API
// POST /api/upload/tmpfile - 上传文件到 tmpfile.link
//
// 鉴权：需 Bearer token（V7 修复）
// 上传目标：tmpfile.link
// 限制：最大 100MB，屏蔽危险类型（SVG/HTML/可执行文件）

import { getAuthUserId } from '../_lib/jwt.js';

const MAX_SIZE = 100 * 1024 * 1024; // 100MB
// V7 修复：屏蔽危险文件类型
const BLOCKED_TYPES = ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml'];
const BLOCKED_EXTS = ['svg', 'html', 'htm', 'xhtml', 'xml', 'js', 'exe', 'bat', 'cmd', 'sh', 'php', 'jsp', 'asp', 'aspx'];

// V6c 修复：收紧 CORS（仅同源请求）
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204 });
}

export async function onRequestPost(context) {
  const { env, request } = context;

  // V7 修复：Token 鉴权
  if (!env.DB) {
    return json({ success: false, error: '数据库未绑定' }, 500);
  }
  const authUserId = await getAuthUserId(env, request);
  if (!authUserId) {
    return json({ success: false, error: '请先登录' }, 401);
  }

  try {
    // 1. 解析表单
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file) {
      return json({ success: false, error: '请选择要上传的文件' }, 400);
    }

    // V7 修复：屏蔽危险文件类型
    const ct = (file.type || '').toLowerCase();
    const ext = (file.name || '').split('.').pop()?.toLowerCase();
    if (BLOCKED_TYPES.includes(ct) || (ext && BLOCKED_EXTS.includes(ext))) {
      return json({ success: false, error: '不支持上传此类型文件（SVG/HTML/可执行文件等被禁止）' }, 400);
    }

    // 2. 校验文件大小
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength === 0) {
      return json({ success: false, error: '文件为空' }, 400);
    }
    if (buffer.byteLength > MAX_SIZE) {
      return json({ success: false, error: '文件大小超过 100MB 限制' }, 413);
    }

    // 3. 构建发送到 tmpfile.link 的 FormData
    const tmpForm = new FormData();
    tmpForm.append('file', file, file.name || 'file');

    // 4. 发送请求到 tmpfile.link（服务端请求，无 CORS 问题）
    const response = await fetch('https://tmpfile.link/api/upload', {
      method: 'POST',
      body: tmpForm,
    });

    // 5. 解析响应
    const respText = await response.text();
    let respData;
    try {
      respData = JSON.parse(respText);
    } catch (e) {
      return json({ success: false, error: 'tmpfile.link 返回非 JSON 响应', status: response.status, body: respText.substring(0, 500) }, 502);
    }

    // 6. 检查上传结果
    if (respData.downloadLink) {
      return json({
        success: true,
        url: respData.downloadLinkEncoded || respData.downloadLink,
        downloadLink: respData.downloadLink,
        fileName: respData.fileName,
        size: respData.size,
        type: respData.type
      });
    } else if (respData.error) {
      return json({ success: false, error: 'tmpfile.link: ' + (respData.error.message || respData.error) }, 502);
    } else {
      return json({ success: false, error: 'tmpfile.link: 响应无 downloadLink 字段', response: JSON.stringify(respData).substring(0, 300) }, 502);
    }
  } catch (e) {
    return json({ success: false, error: '上传失败：' + (e.message || '未知错误') }, 500);
  }
}
