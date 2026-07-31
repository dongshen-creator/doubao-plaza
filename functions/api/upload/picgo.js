// Cloudflare Pages Function - picgo.net 图床上传 API
// POST /api/upload/picgo - 上传图片到 picgo.net (Chevereto API v1)
//
// 鉴权：需 Bearer token（V7 修复）
// 上传方式：二进制 Blob（source 字段，Cloudflare Workers 兼容）
// 上传目标：picgo.net (Chevereto API v1)
// 限制：仅图片类型，最大 25MB，屏蔽 SVG

import { getAuthUserId } from '../_lib/jwt.js';

const PICGO_API_KEY = 'chv_kyCSl_10248ff7e66129adec1f4ce1d55192dbd1238271e943638de688e6262bdd6033_68d8a3764e5564c490c6ad9471ee875fddaeda2a5cb5e3a9d64473a9b5733835';
const PICGO_UPLOAD_URL = 'https://www.picgo.net/api/1/upload';
const MAX_SIZE = 25 * 1024 * 1024; // 25MB

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
      return json({ success: false, error: '请选择要上传的图片' }, 400);
    }

    // 2. 校验文件类型（仅图片，屏蔽 SVG）
    const contentType = (file.type || '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      return json({ success: false, error: 'picgo.net 仅支持图片上传，请使用文件上传功能' }, 400);
    }
    // V7 修复：屏蔽 SVG（XSS 载体）
    if (contentType === 'image/svg+xml') {
      return json({ success: false, error: '不支持上传 SVG 图片' }, 400);
    }
    const ext = (file.name || '').split('.').pop()?.toLowerCase();
    if (ext === 'svg') {
      return json({ success: false, error: '不支持上传 SVG 图片' }, 400);
    }

    // 3. 校验文件大小
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength === 0) {
      return json({ success: false, error: '文件为空' }, 400);
    }
    if (buffer.byteLength > MAX_SIZE) {
      return json({ success: false, error: '图片大小超过 25MB 限制' }, 413);
    }

    // 4. 从文件名推断扩展名
    const fileName = file.name || 'image.png';

    // 5. 构建发送到 picgo.net 的 FormData
    const blob = new Blob([buffer], { type: contentType });
    const picgoForm = new FormData();
    picgoForm.append('source', blob, fileName);
    picgoForm.append('type', 'file');

    // 6. 发送请求到 picgo.net
    const uploadUrl = PICGO_UPLOAD_URL + '?key=' + PICGO_API_KEY + '&format=json';
    const response = await fetch(uploadUrl, {
      method: 'POST',
      body: picgoForm,
    });

    // 7. 解析响应
    const respText = await response.text();
    let respData;
    try {
      respData = JSON.parse(respText);
    } catch (e) {
      let htmlError = '';
      try {
        const titleMatch = respText.match(/<title>(.*?)<\/title>/i);
        if (titleMatch) htmlError = titleMatch[1];
      } catch(_) {}
      return json({
        success: false,
        error: 'picgo.net 返回非 JSON 响应' + (htmlError ? '（' + htmlError + '）' : ''),
        status: response.status,
        body: respText.substring(0, 500)
      }, 502);
    }

    // 8. 检查上传结果
    if (respData.image && respData.image.url) {
      return json({ success: true, url: respData.image.url });
    } else if (respData.error && respData.error.message) {
      return json({
        success: false,
        error: 'picgo.net: ' + respData.error.message,
        code: respData.error.code || respData.status_code
      }, 502);
    } else if (respData.status_code && respData.status_code >= 400) {
      const errMsg = respData.error && typeof respData.error === 'string'
        ? respData.error
        : (respData.message || '上传被拒绝');
      return json({
        success: false,
        error: 'picgo.net: ' + errMsg,
        status_code: respData.status_code
      }, 502);
    } else {
      return json({
        success: false,
        error: 'picgo.net: 响应无 URL 字段',
        response: JSON.stringify(respData).substring(0, 300)
      }, 502);
    }
  } catch (e) {
    return json({ success: false, error: '上传失败：' + (e.message || '未知错误') }, 500);
  }
}
