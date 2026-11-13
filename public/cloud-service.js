/* ═══════════════════════════════════════════════════════════
   V12.0 · 统一服务客户端（两个域名共享同一套服务）
   ---------------------------------------------------------------
   · 唯一事实来源：doubao-plaza.pages.dev 的 Pages Functions + D1 + Supabase
   · 无论从本站还是 WorkBuddy 发布域打开，业务 API 都指向同一套服务
   · 云服务（云数据库）只承担：共享增量水位、同步审计、跨端偏好，
     不再各自复制一份业务数据
   · publicConfig 来自 workbuddy_cloud_service activate 的返回值，仅含公开值
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // 由 workbuddy_cloud_service 的 activate 结果提供；这三个值都是可下发到前端的公开配置
  var publicConfig = {
    endpoint: 'https://doubao-plaza-v11.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_5ErsgrS7fNKfn4IKKmMoat_77tZNn7eYNwZZq6t39KuJgumtRUYXHZ3'
  };

  // 共享服务唯一入口。本站同源直接用相对路径，另一域名用绝对地址，最终落到同一个 D1/Supabase。
  var SHARED_ORIGIN = 'https://doubao-plaza.pages.dev';
  var PREF_KEYS = [
    'dp_theme', 'dp_theme_color', 'dp_shader', 'dp_chat_bg', 'dp_chat_keyboard_lift',
    'dp_notif', 'dp_mute_channel', 'dp_mute_private', 'dp_hidden_features',
    'dp_collapsed_friends', 'dp_collapsed_announcements', 'dp_collapsed_features',
    'blog_card_mode', 'blog_view_mode', 'blog_search_history',
    'chat_channel_groups', 'chat_friend_groups', 'chat_pinned', 'chat_hidden'
  ];

  var client = null;
  var initTried = false;
  var pendingOtp = null;      // { email, verificationId, isExistingUser }
  var session = null;
  var busy = false;
  var bridgeToken = '';       // 仅存内存，绝不写入 localStorage / 代码

  function $(id) { return document.getElementById(id); }
  function el(id) { return $(id); }

  function sharedBase() {
    return location.origin === SHARED_ORIGIN ? '' : SHARED_ORIGIN;
  }
  function serviceUrl(path) { return sharedBase() + path; }

  function originOk() {
    try { return location.origin === new URL(publicConfig.endpoint).origin; }
    catch (e) { return false; }
  }

  function initClient() {
    if (client || initTried) return client;
    initTried = true;
    if (!window.WorkBuddyCloud || typeof window.WorkBuddyCloud.createWorkBuddyCloud !== 'function') {
      return null;   // CDN 未加载 / 被拦截，交由 render() 明确提示
    }
    try {
      client = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: publicConfig.endpoint,
        oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
        publishableKey: publicConfig.publishableKey
      });
    } catch (e) {
      client = null;
    }
    return client;
  }

  function log(msg, kind) {
    var box = el('dpCloudLog');
    if (!box) return;
    var line = document.createElement('div');
    var color = kind === 'error' ? 'var(--danger)' : kind === 'ok' ? 'var(--success)' : 'var(--text-muted)';
    line.style.cssText = 'font-size:12px;line-height:1.6;color:' + color + ';border-top:1px solid var(--border-color);padding:5px 0';
    var d = new Date();
    var ts = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    line.textContent = '[' + ts + '] ' + msg;
    box.insertBefore(line, box.firstChild);
    while (box.childNodes.length > 30) box.removeChild(box.lastChild);
  }

  function status(html, kind) {
    var box = el('dpCloudStatus');
    if (!box) return;
    var bg = kind === 'error' ? 'var(--danger-bg)' : kind === 'ok' ? 'var(--success-bg)' : 'var(--accent-bg)';
    var bd = kind === 'error' ? 'var(--danger-border)' : kind === 'ok' ? 'var(--success-border)' : 'var(--border-color)';
    box.style.cssText = 'padding:10px 12px;border-radius:10px;border:1px solid ' + bd + ';background:' + bg +
      ';font-size:12.5px;line-height:1.6;color:var(--text-secondary);margin-bottom:12px';
    box.innerHTML = html;
  }

  function setBusy(on) {
    busy = !!on;
    var nodes = document.querySelectorAll('#cloudsyncModal [data-dp-busy]');
    for (var i = 0; i < nodes.length; i++) nodes[i].disabled = !!on;
  }

  function describeError(error) {
    if (!error) return '';
    var code = error.code || '';
    var msg = String(error.message || error || '未知错误');
    if (code === '42501' || /permission|rls/i.test(msg)) return '没有权限：请先完成云服务登录，或该记录不属于当前账号（42501）';
    if (code === '42P01') return '云数据表尚未创建，请联系管理员初始化（42P01）';
    if (code === '23505') return '记录已存在（唯一键冲突 23505）';
    if (/401|origin|publishable|credential/i.test(msg))
      return '云服务拒绝了当前来源。请在发布域 ' + publicConfig.endpoint + ' 打开本页面（服务端校验精确来源）。';
    return msg.slice(0, 160);
  }

  function fail(stage, error) {
    var text = describeError(error) || '请求失败';
    log(stage + '：' + text, 'error');
    status('<strong>操作未完成</strong><br>' + text.replace(/</g, '&lt;'), 'error');
  }

  // ── 云服务身份（邮箱验证码） ─────────────────────────────────
  async function refreshSession() {
    var c = initClient();
    if (!c) { session = null; return null; }
    try {
      var r = await c.auth.getSession();
      session = (!r.error && r.data) ? r.data : null;
    } catch (e) { session = null; }
    return session;
  }

  async function sendCode() {
    var c = initClient();
    if (!c) { fail('发送验证码', { message: '云服务 SDK 未加载' }); return; }
    var email = String((el('dpCloudEmail') || {}).value || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      fail('发送验证码', { message: '请输入有效的邮箱地址' }); return;
    }
    setBusy(true);
    try {
      var sent = await c.auth.sendOtp({ email: email });
      if (sent.error) { fail('发送验证码', sent.error); return; }
      pendingOtp = { email: email, verificationId: sent.data.verificationId, isExistingUser: sent.data.isExistingUser };
      log('验证码已发送到 ' + email + '，请在下方输入', 'ok');
      status('验证码已发送，输入 6 位验证码后点「登录 / 注册」。', 'ok');
    } catch (e) { fail('发送验证码', e); }
    finally { setBusy(false); }
  }

  async function verifyCode() {
    var c = initClient();
    if (!c) { fail('登录', { message: '云服务 SDK 未加载' }); return; }
    var token = String((el('dpCloudCode') || {}).value || '').trim();
    if (!pendingOtp) { fail('登录', { message: '请先点击「获取验证码」' }); return; }
    if (!token) { fail('登录', { message: '请输入验证码' }); return; }
    setBusy(true);
    try {
      var done = await c.auth.verifyOtp({
        email: pendingOtp.email,
        verificationId: pendingOtp.verificationId,
        isExistingUser: pendingOtp.isExistingUser,
        token: token
      });
      if (done.error) { fail('登录', done.error); return; }
      pendingOtp = null;
      await refreshSession();
      if (!session) { fail('登录', { message: '验证通过但未建立会话，请重试' }); return; }
      log('云服务登录成功，共享数据已解锁', 'ok');
      render();
    } catch (e) { fail('登录', e); }
    finally { setBusy(false); }
  }

  async function signOut() {
    var c = initClient();
    if (!c) return;
    try { await c.auth.signOut(); } catch (e) {}
    session = null;
    pendingOtp = null;
    log('已退出云服务登录', 'ok');
    render();
  }

  // 所有用户级数据操作前必须过这道门
  async function gate() {
    var s = await refreshSession();
    if (!s) {
      status('需要先用云服务账号登录，才能读写共享数据。账号由本站统一提供，两个域名用的是同一套服务。', 'error');
      return null;
    }
    if (!originOk()) {
      status('当前域名不是云服务发布域。请从 <strong>' + publicConfig.endpoint +
        '</strong> 打开本页面；服务端会校验精确来源，其他域名的云数据请求会被拒绝。', 'error');
      return null;
    }
    return s;
  }

  // ── 现有功能：本机偏好 ↔ 云（跨域名一致） ─────────────────────
  function collectPrefs() {
    var out = {};
    for (var i = 0; i < PREF_KEYS.length; i++) {
      var k = PREF_KEYS[i];
      try { var v = localStorage.getItem(k); if (v !== null) out[k] = v; } catch (e) {}
    }
    return { keys: out, saved_at: new Date().toISOString() };
  }

  async function uploadPrefs() {
    var c = initClient(); if (!(await gate())) return;
    var prefs = collectPrefs();
    setBusy(true);
    try {
      // 用「先查后写」而不是 on_conflict=owner_id,... ：
      // owner_id 由数据库 DEFAULT auth.uid() 填充，不出现在客户端 payload 里，
      // 不同 PostgREST 版本对「冲突列不在 payload」的行为不一致，显式分支最稳。
      var existing = await c.database.from('dp_cloud_prefs')
        .select('id').eq('pref_key', 'ui_preferences').maybeSingle();
      if (existing.error) { fail('上传偏好', existing.error); return; }
      var r = existing.data
        ? await c.database.from('dp_cloud_prefs')
            .update({ pref_value: prefs, updated_at: new Date().toISOString() })
            .eq('id', existing.data.id).select()
        : await c.database.from('dp_cloud_prefs')
            .insert({ pref_key: 'ui_preferences', pref_value: prefs }).select();
      if (r.error) { fail('上传偏好', r.error); return; }
      if (!r.data || r.data.length === 0) { fail('上传偏好', { message: '写入被 RLS 拒绝（返回空结果）' }); return; }
      log('已上传 ' + Object.keys(prefs.keys).length + ' 项本机偏好到云', 'ok');
      status('偏好已保存到云。在另一个域名登录同一云服务账号后点「从云端恢复」即可一致。', 'ok');
    } catch (e) { fail('上传偏好', e); }
    finally { setBusy(false); }
  }

  async function restorePrefs() {
    var c = initClient(); if (!(await gate())) return;
    setBusy(true);
    try {
      var r = await c.database.from('dp_cloud_prefs').select('pref_value').eq('pref_key', 'ui_preferences').maybeSingle();
      if (r.error) { fail('恢复偏好', r.error); return; }
      if (!r.data || !r.data.pref_value || !r.data.pref_value.keys) {
        fail('恢复偏好', { message: '云端还没有保存过偏好，请先上传一次' }); return;
      }
      var keys = r.data.pref_value.keys;
      var n = 0;
      for (var k in keys) {
        if (!Object.prototype.hasOwnProperty.call(keys, k)) continue;
        if (PREF_KEYS.indexOf(k) < 0) continue;   // 只恢复白名单键，杜绝注入任意键
        try { localStorage.setItem(k, String(keys[k])); n++; } catch (e) {}
      }
      // 立即应用主题，其余偏好刷新后生效
      try {
        if (keys.dp_theme === 'dark') document.body.classList.add('dark');
        else document.body.classList.remove('dark');
        if (keys.dp_theme_color && typeof window.applyThemeColor === 'function') window.applyThemeColor(String(keys.dp_theme_color));
      } catch (e) {}
      log('已从云端恢复 ' + n + ' 项偏好', 'ok');
      status('已恢复 ' + n + ' 项偏好，主题已即时生效；其余偏好刷新页面后生效。', 'ok');
    } catch (e) { fail('恢复偏好', e); }
    finally { setBusy(false); }
  }

  // ── 共享增量水位：读取所有操作者写入的水位取最大值，避免各域名各跑一份 ──
  async function readWatermark(c, source, table) {
    try {
      var w = await c.database.from('dp_sync_watermarks')
        .select('last_value').eq('source', source).eq('table_name', table)
        .order('last_value', { ascending: false }).limit(1).maybeSingle();
      return (!w.error && w.data && w.data.last_value) ? String(w.data.last_value) : '';
    } catch (e) { return ''; }
  }

  async function writeWatermark(c, source, table, value) {
    if (!value) return;
    try {
      // 共享读策略让所有已登录用户看得到全部水位；这里只更新「自己那一行」，
      // 因此读侧取最大值即可形成全局单调水位，写侧仍保持 owner-only 安全边界。
      var all = await c.database.from('dp_sync_watermarks')
        .select('id,owner_id').eq('source', source).eq('table_name', table);
      if (all.error) { log('水位查询失败：' + describeError(all.error), 'error'); return; }
      // 共享读会看到所有操作者的水位行；更新只能作用于自己那一行（RLS 会拒绝其他行）
      var uid = session && session.user && session.user.id ? String(session.user.id) : '';
      var rows = Array.isArray(all.data) ? all.data : [];
      var own = uid ? rows.filter(function (r) { return String(r.owner_id) === uid; })[0] : null;
      var payload = { last_value: value, updated_at: new Date().toISOString() };
      if (own) {
        var u = await c.database.from('dp_sync_watermarks').update(payload).eq('id', own.id).select();
        if (u.error || !u.data || !u.data.length) log('水位更新被拒绝：' + describeError(u.error), 'error');
      } else {
        var i = await c.database.from('dp_sync_watermarks')
          .insert({ source: source, table_name: table, last_value: value }).select();
        if (i.error || !i.data || !i.data.length) log('水位新建被拒绝：' + describeError(i.error), 'error');
      }
    } catch (e) { log('水位写入失败（不影响本次同步）：' + describeError(e), 'error'); }
  }

  // ── 主同步：共享服务(D1 + Supabase) → 云库共享镜像 ────────────
  async function pullShared() {
    var c = initClient(); if (!(await gate())) return;
    var since = await readWatermark(c, 'shared', 'export');
    setBusy(true);
    var startedAt = new Date().toISOString();
    var rowsRead = 0, rowsWritten = 0, degraded = [];
    try {
      var url = serviceUrl('/api/sync/export?limit=100') + (since ? '&since=' + encodeURIComponent(since) : '');
      var res;
      try {
        res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      } catch (e) {
        fail('拉取共享服务', { message: '网络不可达：' + SHARED_ORIGIN + ' 暂时无法连接' }); return;
      }
      if (!res.ok) { fail('拉取共享服务', { message: '共享服务返回 HTTP ' + res.status }); return; }
      var payload = await res.json();
      if (!payload.success) { fail('拉取共享服务', { message: payload.error || '导出端返回失败' }); return; }
      var records = Array.isArray(payload.records) ? payload.records : [];
      rowsRead = records.length;
      for (var src in payload.sources || {}) {
        if (payload.sources[src] && payload.sources[src].status === 'degraded') {
          degraded.push(src + '：' + (payload.sources[src].error || '部分表不可用'));
        }
      }

      // 分批 upsert，避免单次请求过大
      for (var i = 0; i < records.length; i += 25) {
        var chunk = records.slice(i, i + 25).map(function (r) {
          return {
            source: String(r.source),
            table_name: String(r.table_name),
            record_key: String(r.record_key).slice(0, 128),
            payload: r.payload || {},
            source_updated_at: r.updated_at || null,
            synced_at: new Date().toISOString()
          };
        });
        // 全局唯一键（source,table_name,record_key）：两个域名、任何操作者
        // 都刷新同一行，不会各自生成一份副本；冲突列全部出现在 payload 中，
        // 不依赖数据库 DEFAULT 填充的 owner_id，PostgREST 行为稳定。
        var up = await c.database.from('dp_sync_records').upsert(
          chunk, { onConflict: 'source,table_name,record_key' }
        ).select();
        if (up.error) { fail('写入共享镜像', up.error); return; }
        rowsWritten += (up.data || []).length;
      }

      // 幂等水位 + 审计（审计表对已登录用户共享可读，两个域名看到同一份运行记录）
      var nextSince = payload.watermark || since;
      await writeWatermark(c, 'shared', 'export', nextSince);
      try {
        await c.database.from('dp_sync_runs').insert({
          direction: 'pull',
          sources: ['d1', 'supabase'],
          rows_read: rowsRead,
          rows_written: rowsWritten,
          status: degraded.length ? 'partial' : 'ok',
          message: degraded.length ? degraded.join(' / ').slice(0, 300) : '共享服务增量同步完成',
          started_at: startedAt,
          finished_at: new Date().toISOString()
        }).select();
      } catch (e) { log('审计写入失败：' + describeError(e), 'error'); }

      log('共享服务同步完成：读取 ' + rowsRead + ' 条，写入 ' + rowsWritten + ' 条', 'ok');
      var msg = '同步完成：读取 <strong>' + rowsRead + '</strong> 条，写入 <strong>' + rowsWritten +
        '</strong> 条。两个域名读的是同一份共享镜像。';
      if (degraded.length) msg += '<br>部分来源降级：' + degraded.join('；').replace(/</g, '&lt;');
      if (payload.truncated) msg += '<br>本批可能未拉完，请再次点击继续。';
      status(msg, degraded.length ? 'error' : 'ok');
    } catch (e) { fail('同步', e); }
    finally { setBusy(false); }
  }

  async function inspectShared() {
    var c = initClient(); if (!(await gate())) return;
    setBusy(true);
    try {
      var r = await c.database.from('dp_sync_records').select('source,table_name', { count: 'exact', head: true });
      if (r.error) { fail('读取共享镜像', r.error); return; }
      var runs = await c.database.from('dp_sync_runs').select('direction,status,rows_read,rows_written,started_at')
        .order('started_at', { ascending: false }).limit(5);
      var n = typeof r.count === 'number' ? r.count : '未知';
      var lines = (runs.data || []).map(function (x) {
        return x.started_at + ' · ' + x.direction + ' · ' + x.status + ' · ' + x.rows_read + '/' + x.rows_written;
      });
      log('共享镜像当前记录数：' + n, 'ok');
      status('共享镜像共 <strong>' + n + '</strong> 条记录。<br>最近同步：<br>' +
        (lines.length ? lines.join('<br>') : '暂无运行记录'), 'ok');
    } catch (e) { fail('读取共享镜像', e); }
    finally { setBusy(false); }
  }

  // ── 反向：云库 → 共享服务的回写收件箱 ────────────────────────
  async function pushShared() {
    var c = initClient(); if (!(await gate())) return;
    var token = String((el('dpCloudBridgeToken') || {}).value || '').trim();
    if (!token) { fail('回写', { message: '请先填写回写令牌（SYNC_BRIDGE_TOKEN）' }); return; }
    bridgeToken = token;   // 只在内存里，用完即清
    setBusy(true);
    try {
      var r = await c.database.from('dp_cloud_prefs').select('pref_key,pref_value,updated_at').limit(100);
      if (r.error) { fail('读取云端记录', r.error); return; }
      var records = (r.data || []).map(function (row, idx) {
        return {
          source: 'cloud',
          table_name: 'dp_cloud_prefs',
          record_key: String(row.pref_key || ('row_' + idx)),
          payload: row.pref_value || {},
          updated_at: row.updated_at || new Date().toISOString()
        };
      });
      if (!records.length) { fail('回写', { message: '云端暂无可回写的记录' }); return; }
      var res;
      try {
        res = await fetch(serviceUrl('/api/sync/import'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sync-Token': bridgeToken },
          body: JSON.stringify({ records: records })
        });
      } catch (e) { fail('回写', { message: '网络不可达：' + SHARED_ORIGIN }); return; }
      var out = await res.json().catch(function () { return {}; });
      if (res.status === 503) { fail('回写', { message: out.error || '回写通道未启用（未配置 SYNC_BRIDGE_TOKEN）' }); return; }
      if (res.status === 401) { fail('回写', { message: '回写令牌无效' }); return; }
      if (!res.ok) { fail('回写', { message: out.error || ('共享服务返回 HTTP ' + res.status) }); return; }
      log('回写完成：成功 ' + (out.processed || 0) + ' 条，跳过 ' + (out.skipped || 0) + ' 条', 'ok');
      status('已写入共享服务 D1 的 <strong>cloud_sync_inbox</strong> 收件箱：成功 ' +
        (out.processed || 0) + ' 条。管理员复核后再决定是否落到业务表。', 'ok');
    } catch (e) { fail('回写', e); }
    finally {
      bridgeToken = '';
      var t = el('dpCloudBridgeToken'); if (t) t.value = '';
      setBusy(false);
    }
  }

  // ── 面板渲染 ─────────────────────────────────────────────────
  async function render() {
    var c = initClient();
    var authBox = el('dpCloudAuth');
    var bodyBox = el('dpCloudBody');
    if (!authBox || !bodyBox) return;

    if (!c) {
      status('<strong>云服务 SDK 未加载</strong><br>请检查网络或 CSP 是否允许 cdn.jsdelivr.net，刷新页面后重试。', 'error');
      authBox.style.display = 'none';
      bodyBox.style.display = 'none';
      return;
    }
    if (!originOk()) {
      status('当前域名：<strong>' + location.origin + '</strong><br>云服务发布域：<strong>' + publicConfig.endpoint +
        '</strong><br>两个域名共用 ' + SHARED_ORIGIN + ' 的同一套业务服务；但云数据面校验精确来源，' +
        '云端读写需在发布域打开本页。', 'error');
    } else {
      status('已连接统一服务：业务数据来自 <strong>' + SHARED_ORIGIN +
        '</strong>（D1 + Supabase），云能力来自本应用。两个域名读同一份数据。', 'ok');
    }

    await refreshSession();
    if (!session) {
      authBox.style.display = '';
      bodyBox.style.display = 'none';
      log('等待云服务登录', '');
      return;
    }
    authBox.style.display = 'none';
    bodyBox.style.display = '';
    var who = el('dpCloudWho');
    if (who) {
      var name = (session.user && session.user.name) || (session.user && session.user.email) || '已登录用户';
      who.textContent = String(name).slice(0, 60);
    }
    log('云服务会话就绪', 'ok');
  }

  function bind() {
    var map = {
      dpCloudSendCode: sendCode,
      dpCloudVerify: verifyCode,
      dpCloudSignOut: signOut,
      dpCloudUploadPrefs: uploadPrefs,
      dpCloudRestorePrefs: restorePrefs,
      dpCloudPull: pullShared,
      dpCloudInspect: inspectShared,
      dpCloudPush: pushShared
    };
    for (var id in map) {
      if (!Object.prototype.hasOwnProperty.call(map, id)) continue;
      (function (node, fn) { if (node) node.addEventListener('click', function () { if (!busy) fn(); }); })($(id), map[id]);
    }
    var codeInput = el('dpCloudCode');
    if (codeInput) codeInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); if (!busy) verifyCode(); }
    });
  }

  window.DPCloud = {
    render: render,
    publicConfig: publicConfig,
    sharedOrigin: SHARED_ORIGIN
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bind(); render(); });
  } else {
    bind(); render();
  }
})();
