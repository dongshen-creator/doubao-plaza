// Cloudflare Pages Function - tmpfile.link 文件上传 API
// POST /api/upload/tmpfile - 上传文件到 tmpfile.link
//
// 鉴权：无（匿名上传，文件 7 天后自动删除）
// 上传目标：tmpfile.link
// 限制：最大 100MB，支持所有文件类型
// 文档：https://tmpfile.link（API Documentation 部分）

const MAX_SIZE = 100 * 1024 * 1024; // 100MB

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
      return json({ success: false, error: '请选择要上传的文件' }, 400);
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
    // 根据官方 API 文档 (https://tmpfile.link):
    //   POST https://tmpfile.link/api/upload
    //   FormData 字段: file=文件（直接使用 File 对象）
    // 注意：直接用原始 File 对象，不包装成 Blob（兼容性更好）
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
    // 响应: { fileName, downloadLink, downloadLinkEncoded, size, type, uploadedTo }
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
