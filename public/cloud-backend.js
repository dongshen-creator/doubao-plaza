/* ═══════════════════════════════════════════════════════════
   V13.1 · WorkBuddy 云服务账号 + 主站会话桥
   ---------------------------------------------------------------
   认证在 WorkBuddy 云服务（Database + RPC）完成，不依赖会被平台回收的
   沙箱 node 进程；但业务接口仍由常驻的 Cloudflare Pages Functions 承载。
   因此云登录成功后，必须再调用主站 /api/users/cloud-bridge，用“有效云令牌”
   换取 D1 会话令牌，前端最终保存的 dp_token 仍是主站令牌。

   包装 window.fetch，只拦截：
     · POST /api/users/login  → 云 RPC 校验 → 主站会话桥
     · POST /api/users        → 云 RPC 注册 → 主站会话桥
   /api/users/auto-login 不再拦截：主站令牌本来就能走主站自动登录。

   密码安全：PBKDF2-SHA256/100000 轮在客户端 WebCrypto 完成，格式与主站
   完全一致（pbkdf2$100000$<salt>$<hash>），用户密码永不明文离开浏览器。

   依赖：cloud-service.js 暴露的 window.DPCloud.getClient()（同一 SDK 实例）。
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__dpCloudBackendPatched) return;

  // 只有 WorkBuddy 发布域（非主站）才启用云服务账号；主站用自己的 Pages Functions
  var HOST_OK = /\.app\.workbuddy\.host$/.test(location.hostname) ||
                /\.workbuddy\.link$/.test(location.hostname);
  if (!HOST_OK) return;

  var ITER = 100000;

  function client() {
    return window.DPCloud && typeof window.DPCloud.getClient === 'function'
      ? window.DPCloud.getClient() : null;
  }

  function enc(s) { return new TextEncoder().encode(s); }
  function hex(buf) {
    var b = new Uint8Array(buf), out = '';
    for (var i = 0; i < b.length; i++) out += ('0' + b[i].toString(16)).slice(-2);
    return out;
  }
  function fromHex(s) {
    var out = new Uint8Array(s.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  // 用给定 salt 算 PBKDF2-SHA256，返回与服务端一致的哈希串
  async function derive(password, saltHex) {
    var salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
    var key = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
    var bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: salt, iterations: ITER, hash: 'SHA-256' }, key, 256);
    return 'pbkdf2$' + ITER + '$' + hex(salt) + '$' + hex(bits);
  }

  function jsonResponse(obj, status) {
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  function deviceId() {
    try {
      var k = 'dp_cloud_device';
      var v = localStorage.getItem(k);
      if (!v) { v = crypto.randomUUID ? crypto.randomUUID() : hex(crypto.getRandomValues(new Uint8Array(16))); localStorage.setItem(k, v); }
      return v;
    } catch (e) { return 'unknown'; }
  }
  function clientIp() { return ''; } // 浏览器拿不到真实 IP；RPC 记录留空，不影响鉴权

  async function rpc(fn, params) {
    var c = client();
    if (!c || !c.database || typeof c.database.rpc !== 'function') {
      throw new Error('云服务尚未就绪，请刷新页面重试');
    }
    var out = await c.database.rpc(fn, params);
    if (out && out.error) throw new Error(out.error.message || '云服务调用失败');
    return (out && out.data) || [];
  }

  // 云令牌只在本地换一次主站会话；主站接口会再次用 dp_auth_session 校验，
  // 因此这里失败一律明确报错，绝不把云 token 直接写进 dp_token。
  async function bridge(cloudToken, hash, profile, evidence) {
    var res = await origFetch('/api/users/cloud-bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({
        token: cloudToken,
        hash: hash || '',
        evidence: evidence || {},
      }, profile || {})),
    });
    var text = await res.text().catch(function () { return ''; });
    var data = null;
    try { data = JSON.parse(text); } catch (e) {}
    if (!res.ok || !data || !data.success) {
      throw new Error((data && data.error) || '主站会话桥接失败，请稍后重试');
    }
    try { localStorage.setItem('dp_cloud_token', cloudToken); } catch (e) {}
    return data;
  }

  async function handleLogin(body) {
    var identifier = String(body.identifier || '').trim();
    var password = String(body.password || '');
    if (!identifier || !password) return jsonResponse({ success: false, error: '请输入账号和密码' });
    var rows = await rpc('dp_auth_lookup', { p_identifier: identifier });
    if (!rows.length) {
      // 云端没有该账号：历史用户在主站注册过。走一次主站登录做迁移校验。
      var migrated = await migrateFromShared(identifier, password, body);
      if (!migrated.ok) return jsonResponse({ success: false, error: migrated.error || '账号或密码错误' });
      return jsonResponse(migrated.result);
    }
    var salt = rows[0].salt || '';
    var hash = await derive(password, salt);
    var lr = await rpc('dp_auth_login', {
      p_identifier: identifier, p_hash: hash,
      p_device: deviceId(), p_ip: clientIp(),
    });
    if (!lr.length || !lr[0].ok) return jsonResponse({ success: false, error: '账号或密码错误' });
    return jsonResponse(await bridge(lr[0].token, hash, null, body));
  }

  // 历史账号迁移：用主站登录接口校验（密码不入库、不落日志），成功后在云端建档。
  // 主站 Cloudflare 后端常驻；此步骤只对“云端尚无账号”的用户发生一次。
  async function migrateFromShared(identifier, password, evidence) {
    try {
      // 必须走 origFetch（外层已打过 patch，会把相对路径改写回共享主站）。
      // 这里若再调用 window.fetch 会命中本文件的 handleLogin，形成无限递归。
      var res = await origFetch('/api/users/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: identifier, password: password }),
      });
      var data = await res.json();
      if (!res.ok || !data.success) return { ok: false, error: data.error || '账号或密码错误' };
      // 迁移成功：把已验证的密码哈希写入云端账号表（哈希由密码本地重算）
      var hash = await derive(password, null);
      var name = (data.data && data.data.name) || identifier;
      var doubao = (data.data && data.data.doubao_id) || '';
      var reg = await rpc('dp_auth_register', {
        p_name: name, p_hash: hash, p_doubao: doubao || null,
        p_agent: null, p_device: deviceId(), p_ip: clientIp(),
      });
      if (!reg.length || !reg[0].ok) {
        // 并发迁移导致昵称已存在：再走一次本地登录
        var lr = await rpc('dp_auth_login', {
          p_identifier: name, p_hash: hash, p_device: deviceId(), p_ip: clientIp(),
        });
        if (lr.length && lr[0].ok) {
          return { ok: true, result: await bridge(lr[0].token, hash, {
            doubao_id: doubao, agent_url: null,
          }, evidence) };
        }
        return { ok: false, error: (reg[0] && reg[0].reason) || '迁移失败，请重试' };
      }
      return { ok: true, result: await bridge(reg[0].token, hash, {
        doubao_id: doubao, agent_url: null,
      }, evidence) };
    } catch (e) {
      return { ok: false, error: '账号校验暂不可用，请稍后重试' };
    }
  }

  async function handleRegister(body) {
    var name = String(body.name || '').trim();
    var password = String(body.password || '');
    var doubao = String(body.doubao_id || '').trim();
    var agent = String(body.agent_url || '').trim();
    if (!name || !password || !doubao) return jsonResponse({ success: false, error: '姓名、密码、豆包号必填' });
    var hash = await derive(password, null);
    var reg = await rpc('dp_auth_register', {
      p_name: name, p_hash: hash, p_doubao: doubao || null,
      p_agent: agent || null, p_device: deviceId(), p_ip: clientIp(),
    });
    if (!reg.length || !reg[0].ok) return jsonResponse({ success: false, error: (reg[0] && reg[0].reason) || '注册失败' });
    return jsonResponse(await bridge(reg[0].token, hash, {
      doubao_id: doubao, agent_url: agent || null,
      avatar: body.avatar || '', bio: body.bio || '',
    }, body));
  }

  function parseBody(init) {
    try {
      if (init && init.body && typeof init.body === 'string') return JSON.parse(init.body);
    } catch (e) {}
    return {};
  }

  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var p = String(url);
    var method = ((init && init.method) || 'GET').toUpperCase();
    var path = '';
    try { path = new URL(p, location.href).pathname; } catch (e) {}

    var handler = null;
    if (path === '/api/users/login' && method === 'POST') handler = handleLogin;
    else if (path === '/api/users' && method === 'POST') handler = handleRegister;

    if (handler) {
      return Promise.resolve()
        .then(function () { return handler(parseBody(init)); })
        .then(function (r) { return r; })
        .catch(function (e) {
          return jsonResponse({ success: false, error: e && e.message ? e.message : '云服务暂不可用' });
        });
    }
    return origFetch(input, init);
  };
  window.__dpCloudBackendPatched = true;
  window.__DP_CLOUD_BACKEND__ = true;
})();
