// Chat file upload - any authenticated user can upload, no developer check
// POST /api/chat/upload - upload a file
// Body: FormData with 'file' and 'user_id'

export async function onRequestPost(context) {
  try {
    const { env } = context;
    const formData = await context.request.formData();
    const file = formData.get('file');
    const userId = formData.get('user_id');
    
    if (!file) return Response.json({ success: false, error: '请选择文件' });
    if (!userId) return Response.json({ success: false, error: '缺少用户ID' });
    
    const user = await env.DB.prepare("SELECT id FROM users WHERE id=?").bind(userId).first();
    if (!user) return Response.json({ success: false, error: '用户不存在' });
    
    if (!env.PAGES_BUCKET) return Response.json({ success: false, error: 'R2 存储桶未绑定' });
    
    const path = formData.get('path') || Date.now().toString(36) + '_' + (file.name || 'file');
    const buffer = await file.arrayBuffer();
    const key = 'pages/chat/' + path;
    await env.PAGES_BUCKET.put(key, buffer, {
      httpMetadata: { contentType: file.type || 'application/octet-stream' },
    });
    
    return Response.json({ success: true, data: { path: 'chat/' + path, size: buffer.byteLength } });
  } catch (e) {
    return Response.json({ success: false, error: '上传失败：' + e.message });
  }
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return Response.json({ success: false, error: '仅支持 POST' }, { status: 405 });
}
