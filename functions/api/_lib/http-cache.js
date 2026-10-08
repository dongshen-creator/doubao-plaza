// V10.5 读放大防护：边缘响应缓存共享工具（D1 免费版日读配额治理，详见 CHANGELOG v10.5）
// 沿用 v7.3 announcements 已上线验证的 Cache API 模式（caches.default.match/put/delete）。
// 约定：
//   - pathKey：响应与 query 无关时用（如 features 列表）；
//   - urlKey：响应依赖 query 参数时用（users 搜索、blog 分页、custom-pages?id=）；
//   - 只缓存成功响应；错误/404/429 一律回源直返，不入缓存；
//   - 写路径必须调用 purgeKey 主动失效（仅当前边缘节点立即失效，
//     其余节点靠响应头 max-age 自然过期兜底——与 announcements v7.3 语义一致）；
//   - X-DP-Cache: HIT|MISS 响应头供线上排障与部署验证（旧版本无此头，见到即新版已部署）。

// 路径级缓存键：丢弃 query（响应与参数无关时）
export function pathKey(request) {
  const u = new URL(request.url);
  u.search = '';
  u.hash = '';
  return new Request(u.toString(), { method: 'GET' });
}

// 完整 URL 缓存键：保留 query（响应依赖参数时，按参数隔离）
export function urlKey(request) {
  const u = new URL(request.url);
  u.hash = '';
  return new Request(u.toString(), { method: 'GET' });
}

// 查缓存；缓存不可用返回 null 回源，不影响主流程
export async function cacheMatch(key) {
  try {
    return await caches.default.match(key);
  } catch (e) {
    return null;
  }
}

// 把源站响应写入边缘缓存：本次返回的响应打 MISS 头，
// 存入缓存的副本打 HIT 头（命中时回传给客户端即可区分来源）。
// 异步写入（waitUntil），失败不影响本次响应。
export function cachePut(context, key, response, maxAgeSec) {
  try {
    response.headers.set('X-DP-Cache', 'MISS');
    response.headers.set('Cache-Control', `public, max-age=${maxAgeSec}`);
    const stored = response.clone();
    stored.headers.set('X-DP-Cache', 'HIT');
    context.waitUntil(caches.default.put(key, stored));
  } catch (e) { /* 缓存写失败不影响本次响应 */ }
  return response;
}

// 写路径主动失效当前边缘节点缓存；失败等 max-age 过期兜底
export function purgeKey(context, key) {
  try {
    context.waitUntil(caches.default.delete(key));
  } catch (e) { /* 失效失败不影响主流程 */ }
}
