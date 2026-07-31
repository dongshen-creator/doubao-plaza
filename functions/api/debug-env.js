// 临时调试端点 - 检查环境变量是否可用
export async function onRequestGet(context) {
  const env = context.env;
  return Response.json({
    has_supabase_edge: !!env.SUPABASE_EDGE_FUNCTION_URL,
    has_proxy_secret: !!env.EDGE_PROXY_SECRET,
    has_supabase_url: !!env.SUPABASE_URL,
    has_supabase_anon: !!env.SUPABASE_ANON_KEY,
    has_db: !!env.DB,
    edge_url_prefix: env.SUPABASE_EDGE_FUNCTION_URL ? env.SUPABASE_EDGE_FUNCTION_URL.substring(0, 30) + '...' : 'NOT SET',
    proxy_secret_set: env.EDGE_PROXY_SECRET ? 'YES (length=' + env.EDGE_PROXY_SECRET.length + ')' : 'NOT SET'
  });
}
