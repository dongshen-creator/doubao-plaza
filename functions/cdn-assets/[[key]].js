// Cloudflare Pages Function - Serve CDN assets from R2
// [[key]].js captures /cdn-assets/{key} and /cdn-assets/{key}/sub-path
// Serves files from R2 under the "chat-assets/" prefix

function getContentType(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  const map = {
    'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
    'gif': 'image/gif', 'webp': 'image/webp', 'svg': 'image/svg+xml',
    'ico': 'image/x-icon', 'mp4': 'video/mp4', 'webm': 'video/webm',
    'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'pdf': 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = 'chat-assets/' + url.pathname.replace('/cdn-assets/', '');

  if (!env.PAGES_BUCKET) {
    return new Response('R2 storage not configured', { status: 503 });
  }

  const object = await env.PAGES_BUCKET.get(key);
  if (!object) {
    return new Response('Not Found', { status: 404 });
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || getContentType(key));
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Access-Control-Allow-Origin', '*');

  return new Response(object.body, { headers });
}

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
