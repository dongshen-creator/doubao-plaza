// Cloudflare Pages Function - picgo.net 图床上传 API
// POST /api/upload/picgo - 上传图片到 picgo.net (Chevereto API)
//
// 鉴权：任意已登录用户（需 user_id 参数）
// 上传目标：picgo.net (Chevereto API v1)
// 限制：仅图片类型，最大 25MB（picgo.net 限制）

const PICGO_API_KEY = 'chv_kyCSl_10248ff7e66129adec1f4ce1d55192dbd1238271e943638de688e6262bdd6033_68d8a3764e5564c490c6ad9471ee875fddaeda2a5cb5e3a9d64473a9b5733835';
const PICGO_UPLOAD_URL = 'https://www.picgo.net/api/1/upload';
const MAX_SIZE = 25 * 1024 * 1024; // 25MB (picgo.net 限制)
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml'];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost(context) {
  const { request } = context;

  try {
    // 1. 解析表单
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file) {
      return json({ success: false, error: '请选择要上传的图片' }, 400);
    }

    // 2. 校验文件类型（仅图片）
    const contentType = (file.type || '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      return json({ success: false, error: 'picgo.net 仅支持图片上传，请使用文件上传功能' }, 400);
    }

    // 3. 校验文件大小
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength === 0) {
      return json({ success: false, error: '文件为空' }, 400);
    }
    if (buffer.byteLength > MAX_SIZE) {
      return json({ success: false, error: '图片大小超过 25MB 限制' }, 413);
    }

    // 4. 构建发送到 picgo.net 的 FormData
    // Chevereto API: POST /api/1/upload?key=xxx&format=json
    // FormData 字段: source=图片文件
    const picgoForm = new FormData();
    picgoForm.append('source', new Blob([buffer], { type: contentType }), file.name || 'image.png');
    picgoForm.append('format', 'json');

    // 5. 发送请求到 picgo.net（服务端请求，无 CORS 问题）
    const uploadUrl = PICGO_UPLOAD_URL + '?key=' + PICGO_API_KEY + '&format=json';
    const response = await fetch(uploadUrl, {
      method: 'POST',
      body: picgoForm,
    });

    // 6. 解析响应
    const respText = await response.text();
    let respData;
    try {
      respData = JSON.parse(respText);
    } catch (e) {
      return json({ success: false, error: 'picgo.net 返回非 JSON 响应', status: response.status, body: respText.substring(0, 500) }, 502);
    }

    // 7. 检查上传结果
    // Chevereto 成功响应: { image: { url: "...", ... }, success: { message: "..." } }
    // Chevereto 错误响应: { error: { message: "...", code: ... }, status_code: 400 }
    if (respData.image && respData.image.url) {
      return json({ success: true, url: respData.image.url });
    } else if (respData.image && respData.image.image && respData.image.image.url) {
      // 某些版本的嵌套格式
      return json({ success: true, url: respData.image.image.url });
    } else if (respData.error && respData.error.message) {
      return json({ success: false, error: 'picgo.net: ' + respData.error.message, code: respData.error.code || respData.status_code }, 502);
    } else {
      return json({ success: false, error: 'picgo.net: 响应无 URL 字段', response: JSON.stringify(respData).substring(0, 300) }, 502);
    }
  } catch (e) {
    return json({ success: false, error: '上传失败：' + (e.message || '未知错误') }, 500);
  }
}
