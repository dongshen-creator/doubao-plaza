// Cloudflare Pages Function - Site Settings API
// GET /api/site-settings  - 公开，返回站点公开设置（维护/迁移模式 + v9.2 全局设置五栏）
// PUT /api/site-settings  - 仅开发者/全局管理员可修改（严格白名单 + 逐键校验）
// v9.2 扩展：站点信息(site_name/site_slogan/site_logo_url/site_icp)、页脚(footer_text/footer_links)、
//   SEO(seo_title/seo_description/seo_keywords)、社交(social_links)、其他(liuyan_enabled/liuyan_exclude)
// 所有 GET 键均为公开可见内容（页脚/SEO 本就面向公众），无敏感信息。

// 统一鉴权：从 Authorization 头取 token，校验会话有效性，返回 user_id 或 null
async function getAuthUserId(env, request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const session = await env.DB.prepare(
    `SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
  return session ? session.user_id : null;
}

// 公开设置白名单与默认值（GET 未命中/表缺失时全部回退默认值）
const PUBLIC_DEFAULTS = {
  maintenance_mode: 'off',   // 'on' | 'off'
  migration_mode: 'off',     // 'on' | 'off'
  // 站点信息
  site_name: '',
  site_slogan: '',
  site_logo_url: '',
  site_icp: '',
  // 页脚
  footer_text: '',
  footer_links: '[]',        // JSON: [{label,url}]
  // SEO
  seo_title: '',
  seo_description: '',
  seo_keywords: '',
  // 社交
  social_links: '[]',        // JSON: [{icon,label,url}]
  // 其他：liuyan.coze.site 内容分类聚合（v9.2）
  liuyan_enabled: 'on',
  liuyan_exclude: '宠物,娱乐,AI',
};

// 读取单个站点设置（不存在则返回默认值；表未创建时也返回默认值）
async function getSetting(env, key, defaultValue) {
  try {
    const row = await env.DB.prepare(
      `SELECT value FROM site_settings WHERE key = ?`
    ).bind(key).first();
    return row ? row.value : defaultValue;
  } catch (e) {
    return defaultValue;
  }
}

// ── PUT 校验规则 ──
function onOffRule(v) {
  if (v !== 'on' && v !== 'off') return '必须是 on 或 off';
  return null;
}
function strRule(max) {
  return (v) => {
    if (typeof v !== 'string') return '必须是字符串';
    if (v.length > max) return `长度不能超过 ${max}`;
    return null;
  };
}
function linkOk(url) {
  return typeof url === 'string' && url.length > 0 && url.length <= 300 &&
    (/^https?:\/\//i.test(url) || url.charAt(0) === '/');
}
function footerLinksRule(v) {
  let arr = v;
  if (typeof v === 'string') { try { arr = JSON.parse(v); } catch (e) { return 'JSON 格式无效'; } }
  if (!Array.isArray(arr)) return '必须是数组';
  if (arr.length > 10) return '最多 10 条';
  for (const it of arr) {
    if (!it || typeof it !== 'object') return '数组项必须是对象';
    if (typeof it.label !== 'string' || !it.label || it.label.length > 40) return 'label 需为 1-40 字符';
    if (!linkOk(it.url)) return 'url 需为 http(s):// 或 / 开头且不超 300 字';
  }
  return null;
}
function socialLinksRule(v) {
  let arr = v;
  if (typeof v === 'string') { try { arr = JSON.parse(v); } catch (e) { return 'JSON 格式无效'; } }
  if (!Array.isArray(arr)) return '必须是数组';
  if (arr.length > 8) return '最多 8 条';
  for (const it of arr) {
    if (!it || typeof it !== 'object') return '数组项必须是对象';
    if (it.icon !== undefined && it.icon !== '' && (typeof it.icon !== 'string' || it.icon.length > 60)) return 'icon 不超 60 字符';
    if (typeof it.label !== 'string' || !it.label || it.label.length > 20) return 'label 需为 1-20 字符';
    if (!linkOk(it.url)) return 'url 需为 http(s):// 或 / 开头且不超 300 字';
  }
  return null;
}

const PUT_RULES = {
  maintenance_mode: onOffRule,
  migration_mode: onOffRule,
  liuyan_enabled: onOffRule,
  site_name: strRule(50),
  site_slogan: strRule(120),
  site_logo_url: strRule(300),
  site_icp: strRule(60),
  footer_text: strRule(1000),
  seo_title: strRule(70),
  seo_description: strRule(200),
  seo_keywords: strRule(200),
  liuyan_exclude: strRule(100),
  footer_links: footerLinksRule,
  social_links: socialLinksRule,
};

// 数组键在写入前规范化为 JSON 字符串
const JSON_KEYS = ['footer_links', 'social_links'];

export async function onRequestGet(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  try {
    const { env } = context;
    const keys = Object.keys(PUBLIC_DEFAULTS);
    const data = Object.assign({}, PUBLIC_DEFAULTS);
    try {
      const rows = await env.DB.prepare(
        `SELECT key, value FROM site_settings WHERE key IN (${keys.map(() => '?').join(',')})`
      ).bind(...keys).all();
      for (const row of (rows.results || [])) {
        if (row && Object.prototype.hasOwnProperty.call(PUBLIC_DEFAULTS, row.key) && row.value != null) {
          data[row.key] = row.value;
        }
      }
    } catch (e) {
      // 表不存在等异常：全部回退默认值
    }
    return Response.json({ success: true, data });
  } catch (e) {
    console.error('[site-settings.js]', e); return Response.json({ success: false, error: '服务器内部错误' });
  }
}

// 检查用户是否为站务管理员（开发者或全局管理员，兼容 D1 返回的整数/字符串/布尔值）
function checkIsDeveloper(user) {
  if (!user) return false;
  var dev = user.is_developer;
  var ga = user.is_global_admin;
  return dev === 1 || dev === '1' || dev === true || ga === 1 || ga === '1' || ga === true;
}

export async function onRequestPut(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: '数据库未绑定' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  try {
    const { env } = context;
    // 鉴权：仅开发者/全局管理员可修改站点设置
    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId) {
      return Response.json({ success: false, error: '请先登录' }, { status: 403 });
    }
    const user = await env.DB.prepare(
      `SELECT is_developer, is_global_admin, doubao_id FROM users WHERE id = ?`
    ).bind(authUserId).first();
    if (!checkIsDeveloper(user)) {
      return Response.json({ success: false, error: '无权操作，仅开发者可修改站点设置' }, { status: 403 });
    }

    const body = await context.request.json().catch(() => ({}));
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ success: false, error: '请求体必须是 JSON 对象' });
    }

    // 严格白名单：未知键直接拒绝（防止误写无效配置）
    const unknown = Object.keys(body).filter((k) => !Object.prototype.hasOwnProperty.call(PUT_RULES, k));
    if (unknown.length > 0) {
      return Response.json({ success: false, error: `未知设置项: ${unknown.join(', ')}` });
    }

    // 先整体校验，全部通过才写入（避免部分更新）
    const updates = [];
    for (const [key, value] of Object.entries(body)) {
      const rule = PUT_RULES[key];
      const err = rule(value);
      if (err) {
        return Response.json({ success: false, error: `${key} 校验失败: ${err}` });
      }
      let stored = value;
      if (JSON_KEYS.includes(key)) {
        // 规范化：对象数组 → JSON 字符串
        stored = typeof value === 'string' ? value : JSON.stringify(value);
      }
      updates.push([key, stored]);
    }
    if (updates.length === 0) {
      return Response.json({ success: false, error: '没有可更新的设置项' });
    }

    for (const [key, value] of updates) {
      // INSERT OR REPLACE 实现 upsert
      await env.DB.prepare(
        `INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      ).bind(key, value).run();
    }

    return Response.json({ success: true, message: '站点设置已更新' });
  } catch (e) {
    console.error('[site-settings.js]', e); return Response.json({ success: false, error: '服务器内部错误' });
  }
}
