export async function onRequest(context) {
  const url = new URL(context.request.url);
  const target = url.pathname.replace('/element', '') + url.search;
  const hs = 'https://solitary-firefly-7c0f.luohy2024.workers.dev/element';
  const resp = await fetch(hs + target, { method: context.request.method, headers: context.request.headers, body: context.request.method !== 'GET' && context.request.method !== 'HEAD' ? context.request.body : undefined });
  const body = await resp.text();
  return new Response(body, { headers: { 'Content-Type': resp.headers.get('Content-Type') || 'text/html' } });
}
