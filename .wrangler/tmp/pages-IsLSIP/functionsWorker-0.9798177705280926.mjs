var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// api/users/[id]/settings.js
async function getAuthUserId(env, request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const session = await env.DB.prepare(
    `SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
  return session ? session.user_id : null;
}
__name(getAuthUserId, "getAuthUserId");
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return "pbkdf2$100000$" + Array.from(salt, (b) => b.toString(16).padStart(2, "0")).join("") + "$" + Array.from(new Uint8Array(derivedBits), (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hashPassword, "hashPassword");
async function onRequestGet(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A\uFF0C\u8BF7\u5728Cloudflare Pages\u8BBE\u7F6E\u4E2D\u7ED1\u5B9AD1\u6570\u636E\u5E93" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const userId = context.params.id;
    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId || authUserId !== userId) {
      return Response.json({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, { status: 403 });
    }
    const user = await env.DB.prepare(
      `SELECT privacy_setting, punished_until, punish_reason FROM users WHERE id = ?`
    ).bind(userId).first();
    if (!user) {
      return Response.json({ success: false, error: "\u7528\u6237\u4E0D\u5B58\u5728" });
    }
    const notifications = [];
    if (user.privacy_setting === "punished_whitelist" && user.punished_until) {
      notifications.push({
        type: "punishment",
        title: "\u8D26\u53F7\u5904\u7F5A\u901A\u77E5",
        message: `\u60A8\u7684\u8D26\u53F7\u56E0${user.punish_reason || "\u88AB\u591A\u6B21\u4E3E\u62A5"}\uFF0C\u5DF2\u88AB\u5F3A\u5236\u5F00\u542F\u767D\u540D\u5355\u6A21\u5F0F\u81F3 ${new Date(user.punished_until).toLocaleDateString("zh-CN")}\u3002\u5728\u6B64\u671F\u95F4\u60A8\u53EA\u80FD\u88AB\u901A\u8FC7\u8C46\u5305\u53F7\u548C\u9080\u8BF7\u7801\u641C\u7D22\u5230\u3002`,
        severity: "warning"
      });
    } else if (user.privacy_setting === "punished_stealth") {
      notifications.push({
        type: "punishment",
        title: "\u8D26\u53F7\u5904\u7F5A\u901A\u77E5",
        message: `\u60A8\u7684\u8D26\u53F7\u56E0${user.punish_reason || "\u88AB\u591A\u6B21\u4E3E\u62A5"}\uFF0C\u5DF2\u88AB\u5F3A\u5236\u5F00\u542F\u9690\u8EAB\u6A21\u5F0F\u3002\u60A8\u5C06\u5B8C\u5168\u4E0D\u53EF\u88AB\u641C\u7D22\u5230\u3002`,
        severity: "error"
      });
    }
    return Response.json({ success: true, data: notifications });
  } catch (e) {
    return Response.json({ success: false, error: "\u670D\u52A1\u5668\u9519\u8BEF\uFF1A" + e.message });
  }
}
__name(onRequestGet, "onRequestGet");
async function onRequestPut(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A\uFF0C\u8BF7\u5728Cloudflare Pages\u8BBE\u7F6E\u4E2D\u7ED1\u5B9AD1\u6570\u636E\u5E93" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const userId = context.params.id;
    const authUserId = await getAuthUserId(env, context.request);
    if (!authUserId || authUserId !== userId) {
      return Response.json({ success: false, error: "\u65E0\u6743\u64CD\u4F5C\uFF0C\u8BF7\u5148\u767B\u5F55" }, { status: 403 });
    }
    const body = await context.request.json().catch(() => ({}));
    const { action, password, invite_code, privacy_setting, avatar } = body;
    if (action === "update_avatar") {
      await env.DB.prepare(`UPDATE users SET avatar = ?, updated_at = datetime('now') WHERE id = ?`).bind(avatar || null, userId).run();
      return Response.json({ success: true, message: "\u5934\u50CF\u66F4\u65B0\u6210\u529F" });
    }
    if (action === "change_password") {
      if (!password || password.length < 6 || password.length > 32) {
        return Response.json({ success: false, error: "\u65B0\u5BC6\u7801\u957F\u5EA6\u5FC5\u987B\u4E3A6-32\u4F4D" });
      }
      const hashedPassword = await hashPassword(password);
      await env.DB.prepare(`UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?`).bind(hashedPassword, userId).run();
      return Response.json({ success: true, message: "\u5BC6\u7801\u4FEE\u6539\u6210\u529F" });
    }
    if (action === "set_invite_code") {
      await env.DB.prepare(`UPDATE users SET invite_code = ?, updated_at = datetime('now') WHERE id = ?`).bind(invite_code || null, userId).run();
      return Response.json({ success: true, message: "\u9080\u8BF7\u7801\u8BBE\u7F6E\u6210\u529F" });
    }
    if (action === "update_pat_suffix") {
      const { pat_suffix } = body;
      await env.DB.prepare("UPDATE users SET pat_suffix = ?, updated_at = datetime('now') WHERE id = ?").bind((pat_suffix || "").slice(0, 10), userId).run();
      return Response.json({ success: true });
    }
    if (action === "set_privacy") {
      const user = await env.DB.prepare(
        `SELECT privacy_setting, punished_until FROM users WHERE id = ?`
      ).bind(userId).first();
      if (user.privacy_setting.startsWith("punished_")) {
        const now = (/* @__PURE__ */ new Date()).toISOString();
        if (user.punished_until && user.punished_until > now) {
          return Response.json({ success: false, error: "\u60A8\u5F53\u524D\u5904\u4E8E\u5904\u7F5A\u671F\uFF0C\u65E0\u6CD5\u4FEE\u6539\u9690\u79C1\u8BBE\u7F6E" });
        }
      }
      if (!["searchable", "whitelist", "stealth"].includes(privacy_setting)) {
        return Response.json({ success: false, error: "\u65E0\u6548\u7684\u9690\u79C1\u8BBE\u7F6E" });
      }
      if (privacy_setting === "whitelist") {
        const currentUser = await env.DB.prepare(
          `SELECT invite_code FROM users WHERE id = ?`
        ).bind(userId).first();
        if (!currentUser.invite_code) {
          await env.DB.prepare(
            `UPDATE users SET privacy_setting = ?, invite_code = '123456', updated_at = datetime('now') WHERE id = ?`
          ).bind(privacy_setting, userId).run();
          return Response.json({ success: true, message: "\u9690\u79C1\u8BBE\u7F6E\u5DF2\u66F4\u65B0\uFF0C\u9080\u8BF7\u7801\u9ED8\u8BA4\u4E3A 123456" });
        }
      }
      await env.DB.prepare(`UPDATE users SET privacy_setting = ?, updated_at = datetime('now') WHERE id = ?`).bind(privacy_setting, userId).run();
      return Response.json({ success: true, message: "\u9690\u79C1\u8BBE\u7F6E\u5DF2\u66F4\u65B0" });
    }
    if (action === "migrate_homepage") {
      const { new_homepage } = body;
      const newUrl = new_homepage ? String(new_homepage).trim() : "";
      if (newUrl) {
        try {
          const u = new URL(newUrl);
          if (u.protocol !== "http:" && u.protocol !== "https:") {
            return Response.json({ success: false, error: "\u4E3B\u9875\u94FE\u63A5\u5FC5\u987B\u4EE5 http:// \u6216 https:// \u5F00\u5934" });
          }
        } catch {
          return Response.json({ success: false, error: "\u4E3B\u9875\u94FE\u63A5\u683C\u5F0F\u4E0D\u6B63\u786E" });
        }
        const occupied = await env.DB.prepare(
          `SELECT id FROM users WHERE agent_url = ? AND id != ?`
        ).bind(newUrl, userId).first();
        if (occupied) {
          return Response.json({ success: false, error: "\u8BE5\u4E3B\u9875\u94FE\u63A5\u5DF2\u88AB\u5176\u4ED6\u7528\u6237\u4F7F\u7528" });
        }
      }
      await env.DB.prepare(
        `UPDATE users SET agent_url = ?, homepage_migrated = 1, updated_at = datetime('now') WHERE id = ?`
      ).bind(newUrl || null, userId).run();
      return Response.json({ success: true, message: "\u4E3B\u9875\u94FE\u63A5\u5DF2\u66F4\u65B0" });
    }
    return Response.json({ success: false, error: "\u672A\u77E5\u64CD\u4F5C" });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
__name(onRequestPut, "onRequestPut");

// api/pages/upload.js
var DEV_IDS = ["470208447", "East_pairs"];
async function isDeveloper(env, userId) {
  if (!userId) return false;
  const user = await env.DB.prepare(`SELECT doubao_id FROM users WHERE id = ?`).bind(userId).first();
  return user && DEV_IDS.includes(user.doubao_id);
}
__name(isDeveloper, "isDeveloper");
function getContentType(filename) {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map = {
    "html": "text/html",
    "css": "text/css",
    "js": "application/javascript",
    "json": "application/json",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "svg": "image/svg+xml",
    "ico": "image/x-icon",
    "mp4": "video/mp4",
    "webm": "video/webm",
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "pdf": "application/pdf",
    "txt": "text/plain",
    "woff": "font/woff",
    "woff2": "font/woff2",
    "ttf": "font/ttf"
  };
  return map[ext] || "application/octet-stream";
}
__name(getContentType, "getContentType");
async function onRequestGet2(context) {
  if (!context.env.DB) {
    return Response.json({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const pageId = url.searchParams.get("id");
    if (!pageId) return Response.json({ success: false, error: "\u7F3A\u5C11\u9875\u9762ID" });
    if (!env.PAGES_BUCKET) {
      return Response.json({ success: true, data: [], r2: false });
    }
    const prefix = `pages/${pageId}/`;
    const listed = await env.PAGES_BUCKET.list({ prefix });
    const files = listed.objects.map((o) => ({
      path: o.key.replace(prefix, ""),
      size: o.size,
      uploaded: o.uploaded
    }));
    return Response.json({ success: true, data: files, r2: true });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
__name(onRequestGet2, "onRequestGet");
async function onRequestPost(context) {
  if (!context.env.DB) {
    return Response.json({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const pageId = url.searchParams.get("id");
    if (!pageId) return Response.json({ success: false, error: "\u7F3A\u5C11\u9875\u9762ID" });
    const formData = await context.request.formData();
    const file = formData.get("file");
    const filePath = formData.get("path") || file?.name || "index.html";
    const userId = formData.get("user_id");
    if (!file) return Response.json({ success: false, error: "\u8BF7\u9009\u62E9\u6587\u4EF6" });
    if (!await isDeveloper(env, userId)) {
      return Response.json({ success: false, error: "\u53EA\u6709\u5F00\u53D1\u8005\u624D\u80FD\u4E0A\u4F20\u6587\u4EF6" });
    }
    if (!env.PAGES_BUCKET) {
      return Response.json({ success: false, error: "R2 \u5B58\u50A8\u6876\u672A\u7ED1\u5B9A" });
    }
    const buffer = await file.arrayBuffer();
    const key = `pages/${pageId}/${filePath}`;
    await env.PAGES_BUCKET.put(key, buffer, {
      httpMetadata: { contentType: file.type || getContentType(filePath) }
    });
    return Response.json({ success: true, data: { path: filePath, size: buffer.byteLength } });
  } catch (e) {
    return Response.json({ success: false, error: "\u4E0A\u4F20\u5931\u8D25\uFF1A" + e.message });
  }
}
__name(onRequestPost, "onRequestPost");
async function onRequestDelete(context) {
  if (!context.env.DB) {
    return Response.json({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const pageId = url.searchParams.get("id");
    const filePath = url.searchParams.get("path");
    const userId = url.searchParams.get("user_id");
    if (!pageId || !filePath) return Response.json({ success: false, error: "\u7F3A\u5C11\u9875\u9762ID\u6216\u6587\u4EF6\u8DEF\u5F84" });
    if (!await isDeveloper(env, userId)) {
      return Response.json({ success: false, error: "\u53EA\u6709\u5F00\u53D1\u8005\u624D\u80FD\u5220\u9664\u6587\u4EF6" });
    }
    if (!env.PAGES_BUCKET) {
      return Response.json({ success: false, error: "R2 \u5B58\u50A8\u6876\u672A\u7ED1\u5B9A" });
    }
    await env.PAGES_BUCKET.delete(`pages/${pageId}/${filePath}`);
    return Response.json({ success: true });
  } catch (e) {
    return Response.json({ success: false, error: "\u5220\u9664\u5931\u8D25\uFF1A" + e.message });
  }
}
__name(onRequestDelete, "onRequestDelete");

// api/users/auto-login.js
async function checkAndUpdatePunishment(env, userId) {
  if (!env.DB) throw new Error("\u6570\u636E\u5E93\u672A\u7ED1\u5B9A");
  const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId).first();
  if (!user) return null;
  if (user.privacy_setting === "punished_whitelist" && user.punished_until) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (user.punished_until < now) {
      await env.DB.prepare(
        `UPDATE users SET privacy_setting = 'searchable', punished_until = NULL, punish_reason = NULL WHERE id = ?`
      ).bind(userId).run();
      user.privacy_setting = "searchable";
    }
  }
  return user;
}
__name(checkAndUpdatePunishment, "checkAndUpdatePunishment");
async function onRequestPost2(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A\uFF0C\u8BF7\u5728Cloudflare Pages\u8BBE\u7F6E\u4E2D\u7ED1\u5B9AD1\u6570\u636E\u5E93" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const body = await context.request.json().catch(() => ({}));
    const { token } = body;
    if (!token) {
      return Response.json({ success: false, error: "\u65E0\u4F1A\u8BDDtoken" });
    }
    const session = await env.DB.prepare(
      `SELECT s.user_id, s.token, s.expires_at, u.* FROM sessions s JOIN users u ON s.user_id = u.id 
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    ).bind(token).first();
    if (!session) {
      return Response.json({ success: false, error: "\u4F1A\u8BDD\u5DF2\u8FC7\u671F" });
    }
    const clientIP = context.request.headers.get("CF-Connecting-IP") || context.request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
    const userAgent = context.request.headers.get("User-Agent") || "";
    await env.DB.prepare(
      `UPDATE users SET last_login_at = datetime('now'), last_login_ip = ?, last_login_ua = ? WHERE id = ?`
    ).bind(clientIP, userAgent, session.user_id).run();
    const user = await checkAndUpdatePunishment(env, session.user_id);
    if (!user) {
      return Response.json({ success: false, error: "\u7528\u6237\u4E0D\u5B58\u5728" });
    }
    const safeUser = {
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      bio: user.bio,
      doubao_id: user.doubao_id,
      agent_url: user.agent_url,
      is_developer: user.is_developer,
      privacy_setting: user.privacy_setting,
      invite_code: user.invite_code,
      created_at: user.created_at,
      updated_at: user.updated_at,
      last_login_at: user.last_login_at,
      last_login_ip: clientIP,
      last_login_ua: userAgent,
      pat_suffix: user.pat_suffix
    };
    return Response.json({ success: true, data: safeUser, token });
  } catch (e) {
    return Response.json({ success: false, error: "\u670D\u52A1\u5668\u9519\u8BEF\uFF1A" + e.message });
  }
}
__name(onRequestPost2, "onRequestPost");

// api/users/login.js
function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(generateToken, "generateToken");
async function hashPassword2(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return "pbkdf2$100000$" + Array.from(salt, (b) => b.toString(16).padStart(2, "0")).join("") + "$" + Array.from(new Uint8Array(derivedBits), (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hashPassword2, "hashPassword");
async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith("pbkdf2$")) {
    return password === stored;
  }
  const parts = stored.split("$");
  const iterations = parseInt(parts[1]);
  const salt = new Uint8Array(parts[2].match(/.{2}/g).map((b) => parseInt(b, 16)));
  const storedHash = parts[3];
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const computedHash = Array.from(new Uint8Array(derivedBits), (b) => b.toString(16).padStart(2, "0")).join("");
  return computedHash === storedHash;
}
__name(verifyPassword, "verifyPassword");
async function checkAndUpdatePunishment2(env, userId) {
  if (!env.DB) throw new Error("\u6570\u636E\u5E93\u672A\u7ED1\u5B9A");
  const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId).first();
  if (!user) return null;
  if (user.privacy_setting === "punished_whitelist" && user.punished_until) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (user.punished_until < now) {
      await env.DB.prepare(
        `UPDATE users SET privacy_setting = 'searchable', punished_until = NULL, punish_reason = NULL WHERE id = ?`
      ).bind(userId).run();
      user.privacy_setting = "searchable";
    }
  }
  return user;
}
__name(checkAndUpdatePunishment2, "checkAndUpdatePunishment");
async function onRequestPost3(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A\uFF0C\u8BF7\u5728Cloudflare Pages\u8BBE\u7F6E\u4E2D\u7ED1\u5B9AD1\u6570\u636E\u5E93" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const body = await context.request.json().catch(() => ({}));
    const { identifier, password } = body;
    if (!identifier || !password) {
      return Response.json({ success: false, error: "\u8BF7\u8F93\u5165\u8D26\u53F7\u548C\u5BC6\u7801" });
    }
    const user = await env.DB.prepare(
      `SELECT * FROM users WHERE (doubao_id = ? OR agent_url = ?)`
    ).bind(identifier, identifier).first();
    if (!user) {
      return Response.json({ success: false, error: "\u8D26\u53F7\u6216\u5BC6\u7801\u9519\u8BEF" });
    }
    const valid = await verifyPassword(password, user.password);
    if (!valid) {
      return Response.json({ success: false, error: "\u8D26\u53F7\u6216\u5BC6\u7801\u9519\u8BEF" });
    }
    if (!user.password || !user.password.startsWith("pbkdf2$")) {
      const hashedPassword = await hashPassword2(password);
      await env.DB.prepare("UPDATE users SET password = ? WHERE id = ?").bind(hashedPassword, user.id).run();
    }
    await checkAndUpdatePunishment2(env, user.id);
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1e3).toISOString();
    await env.DB.prepare(
      `INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)`
    ).bind(user.id, token, expiresAt).run();
    const clientIP = context.request.headers.get("CF-Connecting-IP") || context.request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
    const userAgent = context.request.headers.get("User-Agent") || "";
    await env.DB.prepare(
      `UPDATE users SET last_login_at = datetime('now'), last_login_ip = ?, last_login_ua = ? WHERE id = ?`
    ).bind(clientIP, userAgent, user.id).run();
    const safeUser = {
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      bio: user.bio,
      doubao_id: user.doubao_id,
      agent_url: user.agent_url,
      is_developer: user.is_developer,
      privacy_setting: user.privacy_setting,
      invite_code: user.invite_code,
      created_at: user.created_at,
      updated_at: user.updated_at,
      last_login_at: user.last_login_at,
      last_login_ip: clientIP,
      last_login_ua: userAgent,
      pat_suffix: user.pat_suffix
    };
    return Response.json({ success: true, data: safeUser, token });
  } catch (e) {
    return Response.json({ success: false, error: "\u670D\u52A1\u5668\u9519\u8BEF\uFF1A" + e.message });
  }
}
__name(onRequestPost3, "onRequestPost");

// api/users/[id].js
async function getAuthUserId2(env, request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const session = await env.DB.prepare(
    `SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
  return session ? session.user_id : null;
}
__name(getAuthUserId2, "getAuthUserId");
async function onRequestGet3(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const userId = context.params.id;
    if (!userId) return Response.json({ success: false, error: "\u7528\u6237ID\u4E0D\u80FD\u4E3A\u7A7A" });
    const user = await env.DB.prepare(
      "SELECT id, name, avatar, doubao_id, bio, agent_url, privacy_setting, last_login_at, created_at FROM users WHERE id = ?"
    ).bind(userId).first();
    if (!user) return Response.json({ success: false, error: "\u7528\u6237\u4E0D\u5B58\u5728" });
    return Response.json({ success: true, data: user });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
__name(onRequestGet3, "onRequestGet");
async function onRequestDelete2(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A\uFF0C\u8BF7\u5728Cloudflare Pages\u8BBE\u7F6E\u4E2D\u7ED1\u5B9AD1\u6570\u636E\u5E93" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const userId = context.params.id;
    if (!userId) {
      return Response.json({ success: false, error: "\u7528\u6237ID\u4E0D\u80FD\u4E3A\u7A7A" });
    }
    const authUserId = await getAuthUserId2(env, context.request);
    if (!authUserId || authUserId !== userId) {
      return Response.json({ success: false, error: "\u65E0\u6743\u64CD\u4F5C\uFF0C\u53EA\u80FD\u6CE8\u9500\u81EA\u5DF1\u7684\u8D26\u53F7" }, { status: 403 });
    }
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
    await env.DB.prepare(`DELETE FROM friendships WHERE user_id = ? OR friend_id = ?`).bind(userId, userId).run();
    await env.DB.prepare(`DELETE FROM blocked_users WHERE user_id = ? OR blocked_user_id = ?`).bind(userId, userId).run();
    await env.DB.prepare(`DELETE FROM reports WHERE reporter_id = ? OR reported_id = ?`).bind(userId, userId).run();
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();
    return Response.json({ success: true, message: "\u8D26\u53F7\u5DF2\u6C38\u4E45\u5220\u9664" });
  } catch (e) {
    return Response.json({ success: false, error: "\u6CE8\u9500\u5931\u8D25\uFF1A" + e.message });
  }
}
__name(onRequestDelete2, "onRequestDelete");

// api/announcements.js
async function onRequestGet4(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const results = await env.DB.prepare(
      `SELECT * FROM announcements ORDER BY created_at DESC`
    ).all();
    const data = (results.results || []).map((r) => ({
      ...r,
      created_at: r.created_at ? r.created_at.replace(" ", "T") + "Z" : null,
      is_system: r.is_system === 1 || r.is_system === "1" || r.created_by === "system" ? true : false
    }));
    const sysAnn = data.find((a) => a.created_by === "system");
    if (!sysAnn) {
      data.unshift({
        id: "__system__",
        title: "\u{1F4DC} \u5FC5\u8BFB\u516C\u544A",
        content: '<p>\u6B22\u8FCE\u6765\u5230\u9017\u5305\u7528\u6237\u5E7F\u573A\uFF01\u672C\u5E73\u53F0\u91C7\u7528"\u9632\u541B\u5B50\u4E0D\u9632\u5C0F\u4EBA"\u7684\u539F\u5219\u8FD0\u8425\u3002</p><p>\u8BF7\u9075\u5B88\u4EE5\u4E0B\u57FA\u672C\u89C4\u5219\uFF1A</p><ul><li>\u5C0A\u91CD\u4ED6\u4EBA\uFF0C\u53CB\u5584\u4EA4\u6D41</li><li>\u4E0D\u53D1\u5E03\u8FDD\u6CD5\u6216\u4E0D\u5F53\u5185\u5BB9</li><li>\u4E0D\u6EE5\u7528\u5E73\u53F0\u529F\u80FD</li></ul><p>\u795D\u60A8\u4F7F\u7528\u6109\u5FEB\uFF01</p>',
        created_by: "system",
        created_at: (/* @__PURE__ */ new Date()).toISOString(),
        is_system: true
      });
    }
    return Response.json({ success: true, data });
  } catch (e) {
    return Response.json({ success: false, error: "\u670D\u52A1\u5668\u9519\u8BEF\uFF1A" + e.message });
  }
}
__name(onRequestGet4, "onRequestGet");
async function onRequestPost4(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const body = await context.request.json().catch(() => ({}));
    const { title, content, created_by, is_system } = body;
    if (!title || !content || !created_by) {
      return Response.json({ success: false, error: "\u6807\u9898\u3001\u5185\u5BB9\u548C\u521B\u5EFA\u8005\u4E0D\u80FD\u4E3A\u7A7A" });
    }
    const DEV_IDS3 = ["470208447", "East_pairs"];
    const user = await env.DB.prepare(`SELECT doubao_id FROM users WHERE id = ?`).bind(created_by).first();
    if (!user || !DEV_IDS3.includes(user.doubao_id)) {
      return Response.json({ success: false, error: "\u53EA\u6709\u5F00\u53D1\u8005\u624D\u80FD\u53D1\u5E03\u516C\u544A" });
    }
    let result;
    if (is_system) {
      result = await env.DB.prepare(
        "INSERT INTO announcements (title, content, created_by, is_system) VALUES (?, ?, ?, ?)"
      ).bind(title, content, created_by, 1).run();
    } else {
      result = await env.DB.prepare(
        "INSERT INTO announcements (title, content, created_by) VALUES (?, ?, ?)"
      ).bind(title, content, created_by).run();
    }
    const announcement = await env.DB.prepare(
      `SELECT id, title, content, created_by, created_at, updated_at FROM announcements WHERE id = ?`
    ).bind(result.meta.last_row_id).first();
    if (announcement && announcement.created_at) {
      announcement.created_at = announcement.created_at.replace(" ", "T") + "Z";
    }
    return Response.json({ success: true, data: announcement });
  } catch (e) {
    return Response.json({ success: false, error: "\u53D1\u5E03\u5931\u8D25\uFF1A" + e.message });
  }
}
__name(onRequestPost4, "onRequestPost");
async function onRequestPut2(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const body = await context.request.json().catch(() => ({}));
    const { id, title, content, created_by } = body;
    if (!id) {
      return Response.json({ success: false, error: "\u7F3A\u5C11\u516C\u544AID" });
    }
    if (!title || !content) {
      return Response.json({ success: false, error: "\u6807\u9898\u548C\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A" });
    }
    const DEV_IDS3 = ["470208447", "East_pairs"];
    const user = await env.DB.prepare(`SELECT doubao_id FROM users WHERE id = ?`).bind(created_by).first();
    if (!user || !DEV_IDS3.includes(user.doubao_id)) {
      return Response.json({ success: false, error: "\u53EA\u6709\u5F00\u53D1\u8005\u624D\u80FD\u7F16\u8F91\u516C\u544A" });
    }
    if (id === "__system__") {
      try {
        await env.DB.prepare(
          "INSERT INTO announcements (id, title, content, created_by, is_system) VALUES (?, ?, ?, 'system', 1) ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, updated_at=datetime('now')"
        ).bind("__system__", title, content).run();
      } catch (e) {
        await env.DB.prepare(
          "INSERT INTO announcements (id, title, content, created_by) VALUES (?, ?, ?, 'system') ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, updated_at=datetime('now')"
        ).bind("__system__", title, content).run();
      }
      const announcement2 = await env.DB.prepare(
        `SELECT id, title, content, created_by, created_at, updated_at FROM announcements WHERE id = ?`
      ).bind("__system__").first();
      if (announcement2) {
        if (announcement2.created_at) announcement2.created_at = announcement2.created_at.replace(" ", "T") + "Z";
        if (announcement2.updated_at) announcement2.updated_at = announcement2.updated_at.replace(" ", "T") + "Z";
        announcement2.is_system = true;
      }
      return Response.json({ success: true, data: announcement2 });
    }
    await env.DB.prepare(
      `UPDATE announcements SET title = ?, content = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(title, content, id).run();
    const announcement = await env.DB.prepare(
      `SELECT id, title, content, created_by, created_at, updated_at FROM announcements WHERE id = ?`
    ).bind(id).first();
    if (announcement && announcement.created_at) {
      announcement.created_at = announcement.created_at.replace(" ", "T") + "Z";
    }
    if (announcement && announcement.updated_at) {
      announcement.updated_at = announcement.updated_at.replace(" ", "T") + "Z";
    }
    return Response.json({ success: true, data: announcement });
  } catch (e) {
    return Response.json({ success: false, error: "\u7F16\u8F91\u5931\u8D25\uFF1A" + e.message });
  }
}
__name(onRequestPut2, "onRequestPut");
async function onRequestDelete3(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return Response.json({ success: false, error: "\u7F3A\u5C11\u516C\u544AID" });
    }
    if (id === "__system__") {
      return Response.json({ success: false, error: "\u521D\u59CB\u516C\u544A\u4E0D\u53EF\u5220\u9664" });
    }
    await env.DB.prepare(`DELETE FROM announcements WHERE id = ?`).bind(id).run();
    return Response.json({ success: true });
  } catch (e) {
    return Response.json({ success: false, error: "\u5220\u9664\u5931\u8D25\uFF1A" + e.message });
  }
}
__name(onRequestDelete3, "onRequestDelete");

// api/blocked.js
async function getAuthUserId3(env, request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const session = await env.DB.prepare(
    `SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
  return session ? session.user_id : null;
}
__name(getAuthUserId3, "getAuthUserId");
async function onRequestGet5(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A\uFF0C\u8BF7\u5728Cloudflare Pages\u8BBE\u7F6E\u4E2D\u7ED1\u5B9AD1\u6570\u636E\u5E93" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const userId = url.searchParams.get("user_id");
    if (!userId) {
      return Response.json({ success: false, error: "user_id \u662F\u5FC5\u586B\u53C2\u6570" });
    }
    const authUserId = await getAuthUserId3(env, context.request);
    if (!authUserId || authUserId !== userId) {
      return Response.json({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, { status: 403 });
    }
    const results = await env.DB.prepare(
      `SELECT b.id, b.created_at,
              u.id as blocked_id, u.name as blocked_name, 
              u.avatar as blocked_avatar, u.bio as blocked_bio,
              u.doubao_id as blocked_doubao_id, u.agent_url as blocked_agent_url
       FROM blocked_users b
       JOIN users u ON u.id = b.blocked_user_id
       WHERE b.user_id = ?`
    ).bind(userId).all();
    const blocked = results.results.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      blocked_user: {
        id: r.blocked_id,
        name: r.blocked_name,
        avatar: r.blocked_avatar,
        bio: r.blocked_bio,
        doubao_id: r.blocked_doubao_id,
        agent_url: r.blocked_agent_url
      }
    }));
    return Response.json({ success: true, data: blocked });
  } catch (e) {
    return Response.json({ success: false, error: "\u670D\u52A1\u5668\u9519\u8BEF\uFF1A" + e.message });
  }
}
__name(onRequestGet5, "onRequestGet");
async function onRequestPost5(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A\uFF0C\u8BF7\u5728Cloudflare Pages\u8BBE\u7F6E\u4E2D\u7ED1\u5B9AD1\u6570\u636E\u5E93" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const body = await context.request.json().catch(() => ({}));
    const { user_id, blocked_user_id } = body;
    if (!user_id || !blocked_user_id) {
      return Response.json({ success: false, error: "user_id \u548C blocked_user_id \u662F\u5FC5\u586B\u9879" });
    }
    if (user_id === blocked_user_id) {
      return Response.json({ success: false, error: "\u4E0D\u80FD\u62C9\u9ED1\u81EA\u5DF1" });
    }
    const authUserId = await getAuthUserId3(env, context.request);
    if (!authUserId || authUserId !== user_id) {
      return Response.json({ success: false, error: "\u65E0\u6743\u64CD\u4F5C\uFF0C\u8BF7\u5148\u767B\u5F55" }, { status: 403 });
    }
    const existing = await env.DB.prepare(
      `SELECT * FROM blocked_users WHERE user_id = ? AND blocked_user_id = ?`
    ).bind(user_id, blocked_user_id).first();
    if (existing) {
      return Response.json({ success: false, error: "\u8BE5\u7528\u6237\u5DF2\u5728\u9ED1\u540D\u5355\u4E2D" });
    }
    const result = await env.DB.prepare(
      `INSERT INTO blocked_users (user_id, blocked_user_id) VALUES (?, ?)`
    ).bind(user_id, blocked_user_id).run();
    return Response.json({ success: true, data: { id: result.meta.last_row_id } });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
__name(onRequestPost5, "onRequestPost");
async function onRequestDelete4(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A\uFF0C\u8BF7\u5728Cloudflare Pages\u8BBE\u7F6E\u4E2D\u7ED1\u5B9AD1\u6570\u636E\u5E93" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return Response.json({ success: false, error: "id \u662F\u5FC5\u586B\u53C2\u6570" });
    }
    const authUserId = await getAuthUserId3(env, context.request);
    if (!authUserId) {
      return Response.json({ success: false, error: "\u65E0\u6743\u64CD\u4F5C\uFF0C\u8BF7\u5148\u767B\u5F55" }, { status: 403 });
    }
    const record = await env.DB.prepare(
      `SELECT user_id FROM blocked_users WHERE id = ?`
    ).bind(id).first();
    if (!record || record.user_id !== authUserId) {
      return Response.json({ success: false, error: "\u65E0\u6743\u64CD\u4F5C" }, { status: 403 });
    }
    await env.DB.prepare(`DELETE FROM blocked_users WHERE id = ?`).bind(id).run();
    return Response.json({ success: true, message: "\u5DF2\u79FB\u51FA\u9ED1\u540D\u5355" });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
__name(onRequestDelete4, "onRequestDelete");

// api/custom-pages.js
var DEV_IDS2 = ["470208447", "East_pairs"];
async function isDeveloper2(env, userId) {
  const user = await env.DB.prepare(`SELECT doubao_id FROM users WHERE id = ?`).bind(userId).first();
  return user && DEV_IDS2.includes(user.doubao_id);
}
__name(isDeveloper2, "isDeveloper");
async function getAuthUserId4(env, request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const session = await env.DB.prepare(
    `SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
  return session ? session.user_id : null;
}
__name(getAuthUserId4, "getAuthUserId");
async function onRequestGet6(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const id = url.searchParams.get("id");
    if (id) {
      const page = await env.DB.prepare(
        `SELECT id, title, html_content, created_at, updated_at FROM custom_pages WHERE id = ?`
      ).bind(id).first();
      if (!page) {
        return Response.json({ success: false, error: "\u9875\u9762\u4E0D\u5B58\u5728" });
      }
      return Response.json({ success: true, data: page });
    } else {
      const results = await env.DB.prepare(
        `SELECT id, title, created_at, updated_at FROM custom_pages ORDER BY created_at DESC`
      ).all();
      return Response.json({ success: true, data: results.results });
    }
  } catch (e) {
    return Response.json({ success: false, error: "\u670D\u52A1\u5668\u9519\u8BEF\uFF1A" + e.message });
  }
}
__name(onRequestGet6, "onRequestGet");
async function onRequestPost6(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const body = await context.request.json().catch(() => ({}));
    const { title, html_content, created_by } = body;
    if (!title || !html_content || !created_by) {
      return Response.json({ success: false, error: "\u6807\u9898\u3001\u5185\u5BB9\u548C\u521B\u5EFA\u8005\u4E0D\u80FD\u4E3A\u7A7A" });
    }
    if (!await isDeveloper2(env, created_by)) {
      return Response.json({ success: false, error: "\u53EA\u6709\u5F00\u53D1\u8005\u624D\u80FD\u521B\u5EFA\u9875\u9762" });
    }
    const result = await env.DB.prepare(
      `INSERT INTO custom_pages (title, html_content, created_by) VALUES (?, ?, ?)`
    ).bind(title, html_content, created_by).run();
    const page = await env.DB.prepare(
      `SELECT id, title, created_at, updated_at FROM custom_pages WHERE id = ?`
    ).bind(result.meta.last_row_id).first();
    return Response.json({ success: true, data: page });
  } catch (e) {
    return Response.json({ success: false, error: "\u521B\u5EFA\u5931\u8D25\uFF1A" + e.message });
  }
}
__name(onRequestPost6, "onRequestPost");
async function onRequestPut3(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const id = url.searchParams.get("id");
    const body = await context.request.json().catch(() => ({}));
    const { title, html_content, updated_by } = body;
    if (!id) {
      return Response.json({ success: false, error: "\u7F3A\u5C11\u9875\u9762ID" });
    }
    if (!title || !html_content) {
      return Response.json({ success: false, error: "\u6807\u9898\u548C\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A" });
    }
    const updaterId = updated_by || body.created_by;
    if (!updaterId || !await isDeveloper2(env, updaterId)) {
      return Response.json({ success: false, error: "\u53EA\u6709\u5F00\u53D1\u8005\u624D\u80FD\u66F4\u65B0\u9875\u9762" });
    }
    await env.DB.prepare(
      `UPDATE custom_pages SET title = ?, html_content = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(title, html_content, id).run();
    const page = await env.DB.prepare(
      `SELECT id, title, created_at, updated_at FROM custom_pages WHERE id = ?`
    ).bind(id).first();
    return Response.json({ success: true, data: page });
  } catch (e) {
    return Response.json({ success: false, error: "\u66F4\u65B0\u5931\u8D25\uFF1A" + e.message });
  }
}
__name(onRequestPut3, "onRequestPut");
async function onRequestDelete5(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return Response.json({ success: false, error: "\u7F3A\u5C11\u9875\u9762ID" });
    }
    const authUserId = await getAuthUserId4(env, context.request);
    if (!authUserId) {
      return Response.json({ success: false, error: "\u8BF7\u5148\u767B\u5F55" }, { status: 403 });
    }
    const u = await env.DB.prepare("SELECT doubao_id, is_developer FROM users WHERE id=?").bind(authUserId).first();
    if (!u || u.is_developer !== 1 && !DEV_IDS2.includes(u.doubao_id)) {
      return Response.json({ success: false, error: "\u4EC5\u5F00\u53D1\u8005\u53EF\u5220\u9664\u9875\u9762" }, { status: 403 });
    }
    await env.DB.prepare(`DELETE FROM custom_pages WHERE id = ?`).bind(id).run();
    return Response.json({ success: true });
  } catch (e) {
    return Response.json({ success: false, error: "\u5220\u9664\u5931\u8D25\uFF1A" + e.message });
  }
}
__name(onRequestDelete5, "onRequestDelete");

// api/features.js
async function onRequestGet7(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const results = await env.DB.prepare(
      `SELECT id, title, icon_url, link_url, sort_order, created_by, created_at, updated_at 
       FROM features ORDER BY sort_order ASC, created_at DESC`
    ).all();
    return Response.json({ success: true, data: results.results });
  } catch (e) {
    return Response.json({ success: false, error: "\u670D\u52A1\u5668\u9519\u8BEF\uFF1A" + e.message });
  }
}
__name(onRequestGet7, "onRequestGet");
async function onRequestPost7(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const body = await context.request.json().catch(() => ({}));
    const { title, icon_url, link_url, created_by } = body;
    if (!title || !link_url || !created_by) {
      return Response.json({ success: false, error: "\u6807\u9898\u3001\u94FE\u63A5\u548C\u521B\u5EFA\u8005\u4E0D\u80FD\u4E3A\u7A7A" });
    }
    const DEV_IDS3 = ["470208447", "East_pairs"];
    const user = await env.DB.prepare(`SELECT doubao_id FROM users WHERE id = ?`).bind(created_by).first();
    if (!user || !DEV_IDS3.includes(user.doubao_id)) {
      return Response.json({ success: false, error: "\u53EA\u6709\u5F00\u53D1\u8005\u624D\u80FD\u7BA1\u7406\u529F\u80FD" });
    }
    const maxOrder = await env.DB.prepare(`SELECT MAX(sort_order) as max_order FROM features`).first();
    const sort_order = (maxOrder?.max_order || 0) + 1;
    const result = await env.DB.prepare(
      `INSERT INTO features (title, icon_url, link_url, sort_order, created_by) VALUES (?, ?, ?, ?, ?)`
    ).bind(title, icon_url || null, link_url, sort_order, created_by).run();
    const feature = await env.DB.prepare(
      `SELECT id, title, icon_url, link_url, sort_order, created_by, created_at, updated_at FROM features WHERE id = ?`
    ).bind(result.meta.last_row_id).first();
    return Response.json({ success: true, data: feature });
  } catch (e) {
    return Response.json({ success: false, error: "\u6DFB\u52A0\u5931\u8D25\uFF1A" + e.message });
  }
}
__name(onRequestPost7, "onRequestPost");
async function onRequestPut4(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const id = url.searchParams.get("id");
    const body = await context.request.json().catch(() => ({}));
    const { title, icon_url, link_url, updated_by } = body;
    if (!id) {
      return Response.json({ success: false, error: "\u7F3A\u5C11\u529F\u80FDID" });
    }
    if (!title || !link_url) {
      return Response.json({ success: false, error: "\u6807\u9898\u548C\u94FE\u63A5\u4E0D\u80FD\u4E3A\u7A7A" });
    }
    const updaterId = updated_by || body.created_by;
    if (!updaterId) {
      return Response.json({ success: false, error: "\u7F3A\u5C11\u7528\u6237\u6807\u8BC6" });
    }
    const DEV_IDS3 = ["470208447", "East_pairs"];
    const user = await env.DB.prepare(`SELECT doubao_id FROM users WHERE id = ?`).bind(updaterId).first();
    if (!user || !DEV_IDS3.includes(user.doubao_id)) {
      return Response.json({ success: false, error: "\u53EA\u6709\u5F00\u53D1\u8005\u624D\u80FD\u7BA1\u7406\u529F\u80FD" });
    }
    await env.DB.prepare(
      `UPDATE features SET title = ?, icon_url = ?, link_url = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(title, icon_url || null, link_url, id).run();
    const feature = await env.DB.prepare(
      `SELECT id, title, icon_url, link_url, sort_order, created_by, created_at, updated_at FROM features WHERE id = ?`
    ).bind(id).first();
    return Response.json({ success: true, data: feature });
  } catch (e) {
    return Response.json({ success: false, error: "\u66F4\u65B0\u5931\u8D25\uFF1A" + e.message });
  }
}
__name(onRequestPut4, "onRequestPut");
async function onRequestDelete6(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const id = url.searchParams.get("id");
    const userId = url.searchParams.get("user_id") || context.request.headers.get("X-User-ID") || "";
    if (!id) {
      return Response.json({ success: false, error: "\u7F3A\u5C11\u529F\u80FDID" });
    }
    const DEV_IDS3 = ["470208447", "East_pairs"];
    const user = await env.DB.prepare(`SELECT doubao_id FROM users WHERE id = ?`).bind(userId).first();
    if (!user || !DEV_IDS3.includes(user.doubao_id)) {
      return Response.json({ success: false, error: "\u53EA\u6709\u5F00\u53D1\u8005\u624D\u80FD\u5220\u9664\u529F\u80FD" }, { status: 403 });
    }
    await env.DB.prepare(`DELETE FROM features WHERE id = ?`).bind(id).run();
    return Response.json({ success: true });
  } catch (e) {
    return Response.json({ success: false, error: "\u5220\u9664\u5931\u8D25\uFF1A" + e.message });
  }
}
__name(onRequestDelete6, "onRequestDelete");

// api/friends.js
async function getAuthUserId5(env, request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const session = await env.DB.prepare(
    `SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
  return session ? session.user_id : null;
}
__name(getAuthUserId5, "getAuthUserId");
async function onRequestGet8(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A\uFF0C\u8BF7\u5728Cloudflare Pages\u8BBE\u7F6E\u4E2D\u7ED1\u5B9AD1\u6570\u636E\u5E93" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const userId = url.searchParams.get("user_id");
    const status = url.searchParams.get("status") || "accepted";
    if (!userId) {
      return Response.json({ success: false, error: "user_id \u662F\u5FC5\u586B\u53C2\u6570" });
    }
    const authUserId = await getAuthUserId5(env, context.request);
    if (!authUserId || authUserId !== userId) {
      return Response.json({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, { status: 403 });
    }
    const results = await env.DB.prepare(
      `SELECT f.id, f.user_id, f.friend_id, f.status, f.created_at, f.updated_at,
              u.id as friend_user_id, u.name as friend_name, 
              u.avatar as friend_avatar, u.bio as friend_bio,
              u.doubao_id as friend_doubao_id, u.agent_url as friend_agent_url
       FROM friendships f
       JOIN users u ON (CASE WHEN f.user_id = ? THEN u.id = f.friend_id ELSE u.id = f.user_id END)
       WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = ?
       ORDER BY f.updated_at DESC`
    ).bind(userId, userId, userId, status).all();
    const friendships = results.results.map((r) => ({
      id: r.id,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
      is_outgoing: r.user_id === userId,
      // 是否是我发出的申请
      friend: {
        id: r.friend_user_id,
        name: r.friend_name,
        avatar: r.friend_avatar,
        bio: r.friend_bio,
        doubao_id: r.friend_doubao_id,
        agent_url: r.friend_agent_url
      }
    }));
    return Response.json({ success: true, data: friendships });
  } catch (e) {
    return Response.json({ success: false, error: "\u670D\u52A1\u5668\u9519\u8BEF\uFF1A" + e.message });
  }
}
__name(onRequestGet8, "onRequestGet");
async function onRequestPost8(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A\uFF0C\u8BF7\u5728Cloudflare Pages\u8BBE\u7F6E\u4E2D\u7ED1\u5B9AD1\u6570\u636E\u5E93" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const body = await context.request.json().catch(() => ({}));
    const { user_id, friend_id, invite_code } = body;
    if (!user_id || !friend_id) {
      return Response.json({ success: false, error: "user_id \u548C friend_id \u662F\u5FC5\u586B\u9879" });
    }
    if (user_id === friend_id) {
      return Response.json({ success: false, error: "\u4E0D\u80FD\u6DFB\u52A0\u81EA\u5DF1\u4E3A\u597D\u53CB" });
    }
    const authUserId = await getAuthUserId5(env, context.request);
    if (!authUserId || authUserId !== user_id) {
      return Response.json({ success: false, error: "\u65E0\u6743\u64CD\u4F5C\uFF0C\u8BF7\u5148\u767B\u5F55" }, { status: 403 });
    }
    const friend = await env.DB.prepare("SELECT privacy_setting, invite_code FROM users WHERE id = ?").bind(friend_id).first();
    if (!friend) {
      return Response.json({ success: false, error: "\u7528\u6237\u4E0D\u5B58\u5728" });
    }
    if (friend.privacy_setting === "stealth" || friend.privacy_setting === "punished_stealth") {
      return Response.json({ success: false, error: "\u8BE5\u7528\u6237\u5904\u4E8E\u9690\u8EAB\u6A21\u5F0F\uFF0C\u65E0\u6CD5\u6DFB\u52A0\u597D\u53CB" });
    }
    if (friend.privacy_setting === "whitelist" || friend.privacy_setting === "punished_whitelist") {
      if (!invite_code || invite_code !== friend.invite_code) {
        return Response.json({ success: false, error: "\u9080\u8BF7\u7801\u9519\u8BEF\uFF0C\u65E0\u6CD5\u6DFB\u52A0\u597D\u53CB" });
      }
    }
    const existing = await env.DB.prepare(
      `SELECT * FROM friendships WHERE 
       (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`
    ).bind(user_id, friend_id, friend_id, user_id).first();
    if (existing) {
      if (existing.status === "accepted") {
        return Response.json({ success: false, error: "\u4F60\u4EEC\u5DF2\u7ECF\u662F\u597D\u53CB" });
      } else if (existing.status === "pending") {
        return Response.json({ success: false, error: "\u597D\u53CB\u7533\u8BF7\u5DF2\u53D1\u9001\uFF0C\u7B49\u5F85\u5BF9\u65B9\u5904\u7406" });
      } else if (existing.status === "rejected") {
        await env.DB.prepare(
          `UPDATE friendships SET status = 'pending', user_id = ?, friend_id = ?, updated_at = datetime('now') WHERE id = ?`
        ).bind(user_id, friend_id, existing.id).run();
        return Response.json({ success: true, data: { id: existing.id, status: "pending" } });
      }
    }
    const result = await env.DB.prepare(
      `INSERT INTO friendships (user_id, friend_id, status) VALUES (?, ?, 'pending')`
    ).bind(user_id, friend_id).run();
    return Response.json({ success: true, data: { id: result.meta.last_row_id, status: "pending" } });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
__name(onRequestPost8, "onRequestPost");
async function onRequestPut5(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A\uFF0C\u8BF7\u5728Cloudflare Pages\u8BBE\u7F6E\u4E2D\u7ED1\u5B9AD1\u6570\u636E\u5E93" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const id = url.searchParams.get("id");
    const body = await context.request.json().catch(() => ({}));
    const { action } = body;
    if (!id) {
      return Response.json({ success: false, error: "id \u662F\u5FC5\u586B\u53C2\u6570" });
    }
    if (!["accept", "reject"].includes(action)) {
      return Response.json({ success: false, error: "action \u5FC5\u987B\u662F accept \u6216 reject" });
    }
    const authUserId = await getAuthUserId5(env, context.request);
    if (!authUserId) {
      return Response.json({ success: false, error: "\u65E0\u6743\u64CD\u4F5C\uFF0C\u8BF7\u5148\u767B\u5F55" }, { status: 403 });
    }
    const record = await env.DB.prepare(
      `SELECT user_id, friend_id, status FROM friendships WHERE id = ?`
    ).bind(id).first();
    if (!record) {
      return Response.json({ success: false, error: "\u597D\u53CB\u7533\u8BF7\u4E0D\u5B58\u5728" });
    }
    if (record.friend_id !== authUserId) {
      return Response.json({ success: false, error: "\u65E0\u6743\u5BA1\u6838\u6B64\u597D\u53CB\u7533\u8BF7" }, { status: 403 });
    }
    const newStatus = action === "accept" ? "accepted" : "rejected";
    await env.DB.prepare(
      `UPDATE friendships SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(newStatus, id).run();
    return Response.json({ success: true, message: action === "accept" ? "\u5DF2\u901A\u8FC7\u597D\u53CB\u7533\u8BF7" : "\u5DF2\u62D2\u7EDD\u597D\u53CB\u7533\u8BF7" });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
__name(onRequestPut5, "onRequestPut");
async function onRequestDelete7(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A\uFF0C\u8BF7\u5728Cloudflare Pages\u8BBE\u7F6E\u4E2D\u7ED1\u5B9AD1\u6570\u636E\u5E93" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return Response.json({ success: false, error: "id \u662F\u5FC5\u586B\u53C2\u6570" });
    }
    const authUserId = await getAuthUserId5(env, context.request);
    if (!authUserId) {
      return Response.json({ success: false, error: "\u65E0\u6743\u64CD\u4F5C\uFF0C\u8BF7\u5148\u767B\u5F55" }, { status: 403 });
    }
    const record = await env.DB.prepare(
      `SELECT user_id, friend_id FROM friendships WHERE id = ?`
    ).bind(id).first();
    if (!record) {
      return Response.json({ success: false, error: "\u597D\u53CB\u5173\u7CFB\u4E0D\u5B58\u5728" });
    }
    if (record.user_id !== authUserId && record.friend_id !== authUserId) {
      return Response.json({ success: false, error: "\u65E0\u6743\u64CD\u4F5C" }, { status: 403 });
    }
    await env.DB.prepare(`DELETE FROM friendships WHERE id = ?`).bind(id).run();
    return Response.json({ success: true, message: "\u5DF2\u79FB\u9664\u597D\u53CB" });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
__name(onRequestDelete7, "onRequestDelete");

// api/proxy.js
async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Target-URL, X-Coze-Session, X-Access-Token",
      "Access-Control-Expose-Headers": "X-Set-Session",
      "Access-Control-Max-Age": "86400"
    }
  });
}
__name(onRequestOptions, "onRequestOptions");
async function onRequestPost9(context) {
  const { request } = context;
  const targetUrl = request.headers.get("X-Target-URL");
  if (!targetUrl) {
    return Response.json({ error: "\u7F3A\u5C11 X-Target-URL \u5934" }, { status: 400 });
  }
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== "https:") {
      return Response.json({ error: "\u4EC5\u652F\u6301 HTTPS \u76EE\u6807" }, { status: 400 });
    }
  } catch {
    return Response.json({ error: "\u65E0\u6548\u7684\u76EE\u6807 URL" }, { status: 400 });
  }
  const body = await request.arrayBuffer();
  const forwardHeaders = new Headers();
  const contentType = request.headers.get("Content-Type");
  if (contentType) forwardHeaders.set("Content-Type", contentType);
  const auth = request.headers.get("Authorization");
  if (auth) forwardHeaders.set("Authorization", auth);
  const cozeSession = request.headers.get("X-Coze-Session");
  if (cozeSession) {
    forwardHeaders.set("Cookie", "db_session=" + cozeSession);
  }
  const accessToken = request.headers.get("X-Access-Token");
  if (accessToken) {
    forwardHeaders.set("X-Access-Token", accessToken);
  }
  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: forwardHeaders,
      body
    });
    const respHeaders = new Headers();
    const respContentType = response.headers.get("Content-Type");
    if (respContentType) respHeaders.set("Content-Type", respContentType);
    respHeaders.set("Access-Control-Allow-Origin", "*");
    respHeaders.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    respHeaders.set("Access-Control-Expose-Headers", "X-Set-Session");
    if (respContentType && respContentType.includes("text/event-stream")) {
      respHeaders.set("Cache-Control", "no-cache");
      respHeaders.set("Connection", "keep-alive");
    }
    let setCookieValues = [];
    if (typeof response.headers.getSetCookie === "function") {
      setCookieValues = response.headers.getSetCookie();
    } else {
      const sc = response.headers.get("Set-Cookie");
      if (sc) setCookieValues = [sc];
    }
    for (const sc of setCookieValues) {
      const match2 = sc.match(/db_session=([^;]+)/);
      if (match2) {
        respHeaders.set("X-Set-Session", match2[1]);
        break;
      }
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: respHeaders
    });
  } catch (err) {
    return Response.json({
      error: "\u4EE3\u7406\u8BF7\u6C42\u5931\u8D25: " + (err.message || "\u672A\u77E5\u9519\u8BEF"),
      target: targetUrl.substring(0, 100)
    }, {
      status: 502,
      headers: {
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
}
__name(onRequestPost9, "onRequestPost");
async function onRequestGet9(context) {
  const url = new URL(context.request.url);
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    return Response.json({
      status: "ok",
      message: "CORS \u4EE3\u7406\u8FD0\u884C\u4E2D\u3002\u4F7F\u7528\u65B9\u6CD5\uFF1APOST \u8BF7\u6C42\u5E76\u9644\u5E26 X-Target-URL \u5934\u3002",
      time: (/* @__PURE__ */ new Date()).toISOString()
    }, {
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== "https:") {
      return Response.json({ error: "\u4EC5\u652F\u6301 HTTPS" }, { status: 400 });
    }
    const getHeaders = {};
    const auth = context.request.headers.get("Authorization");
    if (auth) getHeaders["Authorization"] = auth;
    const cozeSession = context.request.headers.get("X-Coze-Session");
    if (cozeSession) {
      getHeaders["Cookie"] = "db_session=" + cozeSession;
    }
    const accessToken = context.request.headers.get("X-Access-Token");
    if (accessToken) {
      getHeaders["X-Access-Token"] = accessToken;
    }
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: getHeaders
    });
    const respHeaders = new Headers();
    const respContentType = response.headers.get("Content-Type");
    if (respContentType) respHeaders.set("Content-Type", respContentType);
    respHeaders.set("Access-Control-Allow-Origin", "*");
    return new Response(response.body, {
      status: response.status,
      headers: respHeaders
    });
  } catch (err) {
    return Response.json({
      error: "\u4EE3\u7406\u8BF7\u6C42\u5931\u8D25: " + (err.message || "\u672A\u77E5\u9519\u8BEF")
    }, {
      status: 502,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }
}
__name(onRequestGet9, "onRequestGet");

// api/reports.js
async function getAuthUserId6(env, request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const session = await env.DB.prepare(
    `SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
  return session ? session.user_id : null;
}
__name(getAuthUserId6, "getAuthUserId");
async function onRequestPost10(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A\uFF0C\u8BF7\u5728Cloudflare Pages\u8BBE\u7F6E\u4E2D\u7ED1\u5B9AD1\u6570\u636E\u5E93" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const body = await context.request.json().catch(() => ({}));
    const { reporter_id, reported_id, reason } = body;
    if (!reporter_id || !reported_id) {
      return Response.json({ success: false, error: "reporter_id \u548C reported_id \u662F\u5FC5\u586B\u9879" });
    }
    if (reporter_id === reported_id) {
      return Response.json({ success: false, error: "\u4E0D\u80FD\u4E3E\u62A5\u81EA\u5DF1" });
    }
    const authUserId = await getAuthUserId6(env, context.request);
    if (!authUserId || authUserId !== reporter_id) {
      return Response.json({ success: false, error: "\u65E0\u6743\u64CD\u4F5C\uFF0C\u8BF7\u5148\u767B\u5F55" }, { status: 403 });
    }
    const existing = await env.DB.prepare(
      `SELECT * FROM reports WHERE reporter_id = ? AND reported_id = ? AND created_at > datetime('now', '-30 days')`
    ).bind(reporter_id, reported_id).first();
    if (existing) {
      return Response.json({ success: false, error: "\u60A8\u5DF2\u4E3E\u62A5\u8FC7\u8BE5\u7528\u6237\uFF0C30\u5929\u5185\u4E0D\u80FD\u91CD\u590D\u4E3E\u62A5" });
    }
    await env.DB.prepare(
      `INSERT INTO reports (reporter_id, reported_id, reason) VALUES (?, ?, ?)`
    ).bind(reporter_id, reported_id, reason || null).run();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1e3).toISOString();
    const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1e3).toISOString();
    const reports30d = await env.DB.prepare(
      `SELECT COUNT(DISTINCT reporter_id) as count FROM reports 
       WHERE reported_id = ? AND created_at > ?`
    ).bind(reported_id, thirtyDaysAgo).first();
    const reports6m = await env.DB.prepare(
      `SELECT COUNT(DISTINCT reporter_id) as count FROM reports 
       WHERE reported_id = ? AND created_at > ?`
    ).bind(reported_id, sixMonthsAgo).first();
    await env.DB.prepare(
      `UPDATE users SET report_count_30d = ?, report_count_6m = ? WHERE id = ?`
    ).bind(reports30d.count, reports6m.count, reported_id).run();
    const reportedUser = await env.DB.prepare(
      `SELECT * FROM users WHERE id = ?`
    ).bind(reported_id).first();
    let punishment = null;
    if (reports30d.count >= 3 && reportedUser.privacy_setting !== "punished_whitelist" && reportedUser.privacy_setting !== "stealth") {
      const punishedUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1e3).toISOString();
      await env.DB.prepare(
        `UPDATE users SET privacy_setting = 'punished_whitelist', punished_until = ?, punish_reason = '\u88AB\u591A\u6B21\u4E3E\u62A5' WHERE id = ?`
      ).bind(punishedUntil, reported_id).run();
      punishment = { type: "punished_whitelist", until: punishedUntil, reason: "\u88AB\u591A\u6B21\u4E3E\u62A5\uFF0C\u5DF2\u5F3A\u5236\u5F00\u542F\u767D\u540D\u5355\u6A21\u5F0F" };
    }
    if (reports6m.count >= 10 && reportedUser.privacy_setting !== "punished_stealth" && reportedUser.privacy_setting !== "stealth") {
      await env.DB.prepare(
        `UPDATE users SET privacy_setting = 'punished_stealth', punish_reason = '\u88AB\u591A\u6B21\u4E3E\u62A5' WHERE id = ?`
      ).bind(reported_id).run();
      punishment = { type: "punished_stealth", reason: "\u88AB\u591A\u6B21\u4E3E\u62A5\uFF0C\u5DF2\u5F3A\u5236\u5F00\u542F\u9690\u8EAB\u6A21\u5F0F" };
    }
    return Response.json({
      success: true,
      message: "\u4E3E\u62A5\u6210\u529F",
      punishment
    });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
__name(onRequestPost10, "onRequestPost");

// api/site-settings.js
async function getAuthUserId7(env, request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const session = await env.DB.prepare(
    `SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
  return session ? session.user_id : null;
}
__name(getAuthUserId7, "getAuthUserId");
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
__name(getSetting, "getSetting");
async function onRequestGet10(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const maintenanceMode = await getSetting(env, "maintenance_mode", "off");
    const migrationMode = await getSetting(env, "migration_mode", "off");
    return Response.json({
      success: true,
      data: {
        maintenance_mode: maintenanceMode,
        // 'on' | 'off'
        migration_mode: migrationMode
        // 'on' | 'off'
      }
    });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
__name(onRequestGet10, "onRequestGet");
async function onRequestPut6(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const authUserId = await getAuthUserId7(env, context.request);
    if (!authUserId) {
      return Response.json({ success: false, error: "\u8BF7\u5148\u767B\u5F55" }, { status: 403 });
    }
    const user = await env.DB.prepare(
      `SELECT is_developer FROM users WHERE id = ?`
    ).bind(authUserId).first();
    if (!user || user.is_developer !== 1) {
      return Response.json({ success: false, error: "\u65E0\u6743\u64CD\u4F5C\uFF0C\u4EC5\u5F00\u53D1\u8005\u53EF\u4FEE\u6539\u7AD9\u70B9\u8BBE\u7F6E" }, { status: 403 });
    }
    const body = await context.request.json().catch(() => ({}));
    const { maintenance_mode, migration_mode } = body;
    const updates = [];
    if (maintenance_mode !== void 0) {
      if (!["on", "off"].includes(maintenance_mode)) {
        return Response.json({ success: false, error: "maintenance_mode \u5FC5\u987B\u662F on \u6216 off" });
      }
      updates.push(["maintenance_mode", maintenance_mode]);
    }
    if (migration_mode !== void 0) {
      if (!["on", "off"].includes(migration_mode)) {
        return Response.json({ success: false, error: "migration_mode \u5FC5\u987B\u662F on \u6216 off" });
      }
      updates.push(["migration_mode", migration_mode]);
    }
    for (const [key, value] of updates) {
      await env.DB.prepare(
        `INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      ).bind(key, value).run();
    }
    return Response.json({ success: true, message: "\u7AD9\u70B9\u8BBE\u7F6E\u5DF2\u66F4\u65B0" });
  } catch (e) {
    return Response.json({ success: false, error: e.message });
  }
}
__name(onRequestPut6, "onRequestPut");

// api/users.js
function isValidHttpUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
__name(isValidHttpUrl, "isValidHttpUrl");
function generateToken2() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(generateToken2, "generateToken");
async function hashPassword3(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return "pbkdf2$100000$" + Array.from(salt, (b) => b.toString(16).padStart(2, "0")).join("") + "$" + Array.from(new Uint8Array(derivedBits), (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hashPassword3, "hashPassword");
async function onRequestGet11(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A\uFF0C\u8BF7\u5728Cloudflare Pages\u8BBE\u7F6E\u4E2D\u7ED1\u5B9AD1\u6570\u636E\u5E93" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const url = new URL(context.request.url);
    const search = url.searchParams.get("search") || "";
    const doubaoId = url.searchParams.get("doubao_id") || "";
    const inviteCode = url.searchParams.get("invite_code") || "";
    const currentUserId = url.searchParams.get("current_user") || "";
    let whereClause = "WHERE 1=1";
    const params = [];
    if (currentUserId) {
      const [currentUser, blockedByMe, blockedMe] = await Promise.all([
        env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(currentUserId).first(),
        env.DB.prepare(`SELECT blocked_user_id FROM blocked_users WHERE user_id = ?`).bind(currentUserId).all(),
        env.DB.prepare(`SELECT user_id FROM blocked_users WHERE blocked_user_id = ?`).bind(currentUserId).all()
      ]);
      if (!currentUser) {
        return Response.json({ success: false, error: "\u5F53\u524D\u7528\u6237\u4E0D\u5B58\u5728" });
      }
      const blockedIds = /* @__PURE__ */ new Set([
        ...(blockedByMe.results || []).map((r) => r.blocked_user_id),
        ...(blockedMe.results || []).map((r) => r.user_id)
      ]);
      if (blockedIds.size > 0) {
        whereClause += ` AND id NOT IN (${Array.from(blockedIds).map(() => "?").join(",")})`;
        params.push(...Array.from(blockedIds));
      }
      whereClause += ` AND id != ?`;
      params.push(currentUserId);
      whereClause += ` AND privacy_setting NOT IN ('stealth', 'punished_stealth')`;
      if (!doubaoId || !inviteCode) {
        whereClause += ` AND privacy_setting NOT IN ('whitelist', 'punished_whitelist')`;
      }
      if (search) {
        whereClause += ` AND (name LIKE ? OR bio LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`);
      }
      if (doubaoId) {
        whereClause += ` AND doubao_id = ?`;
        params.push(doubaoId);
      }
      if (inviteCode) {
        whereClause += ` AND invite_code = ?`;
        params.push(inviteCode);
      }
    } else {
      whereClause += ` AND privacy_setting = 'searchable'`;
      if (search) {
        whereClause += ` AND (name LIKE ? OR bio LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`);
      }
    }
    const results = await env.DB.prepare(
      `SELECT id, name, avatar, bio, doubao_id, agent_url, pat_suffix, privacy_setting, created_at 
       FROM users ${whereClause} ORDER BY created_at DESC`
    ).bind(...params).all();
    return Response.json({ success: true, data: results.results });
  } catch (e) {
    return Response.json({ success: false, error: "\u670D\u52A1\u5668\u9519\u8BEF\uFF1A" + e.message });
  }
}
__name(onRequestGet11, "onRequestGet");
async function onRequestPost11(context) {
  if (!context.env.DB) {
    return new Response(JSON.stringify({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A\uFF0C\u8BF7\u5728Cloudflare Pages\u8BBE\u7F6E\u4E2D\u7ED1\u5B9AD1\u6570\u636E\u5E93" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const { env } = context;
    const body = await context.request.json().catch(() => ({}));
    const { name, password, doubao_id, agent_url, avatar, bio, device_fingerprint } = body;
    if (!name || !password) {
      return Response.json({ success: false, error: "\u59D3\u540D\u548C\u5BC6\u7801\u662F\u5FC5\u586B\u9879" });
    }
    if (!password || password.length < 6 || password.length > 32) {
      return Response.json({ success: false, error: "\u5BC6\u7801\u957F\u5EA6\u5FC5\u987B\u4E3A6-32\u4F4D" });
    }
    if (!doubao_id) {
      return Response.json({ success: false, error: "\u8C46\u5305\u53F7\u662F\u5FC5\u586B\u9879" });
    }
    const homepageUrl = agent_url ? String(agent_url).trim() : "";
    if (homepageUrl && !isValidHttpUrl(homepageUrl)) {
      return Response.json({ success: false, error: "\u4E3B\u9875\u94FE\u63A5\u683C\u5F0F\u4E0D\u6B63\u786E\uFF0C\u8BF7\u586B\u5199\u4EE5 http:// \u6216 https:// \u5F00\u5934\u7684\u94FE\u63A5" });
    }
    const clientIP = context.request.headers.get("CF-Connecting-IP") || context.request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
    const recentRegs = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM users WHERE registered_ip = ? AND created_at > datetime('now', '-1 hour')`
    ).bind(clientIP).first();
    if (recentRegs && recentRegs.cnt >= 5) {
      return Response.json({ success: false, error: "\u8BE5\u7F51\u7EDC\u6CE8\u518C\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7 1 \u5C0F\u65F6\u540E\u518D\u8BD5" });
    }
    if (device_fingerprint) {
      const existingDevice = await env.DB.prepare(
        `SELECT id FROM users WHERE device_fingerprint = ?`
      ).bind(device_fingerprint).first();
      if (existingDevice) {
        return Response.json({ success: false, error: "\u8BE5\u8BBE\u5907/\u6D4F\u89C8\u5668\u5DF2\u6CE8\u518C\u8FC7\u8D26\u53F7\uFF0C\u6BCF\u4E2A\u8BBE\u5907\u53EA\u80FD\u6CE8\u518C\u4E00\u4E2A\u8D26\u53F7" });
      }
    }
    const existingDoubaoId = await env.DB.prepare(`SELECT id FROM users WHERE doubao_id = ?`).bind(doubao_id).first();
    if (existingDoubaoId) return Response.json({ success: false, error: "\u8BE5\u8C46\u5305\u53F7\u5DF2\u88AB\u6CE8\u518C" });
    if (homepageUrl) {
      const existingAgentUrl = await env.DB.prepare(`SELECT id FROM users WHERE agent_url = ?`).bind(homepageUrl).first();
      if (existingAgentUrl) return Response.json({ success: false, error: "\u8BE5\u4E3B\u9875\u94FE\u63A5\u5DF2\u88AB\u5176\u4ED6\u7528\u6237\u4F7F\u7528" });
    }
    const regIP = context.request.headers.get("CF-Connecting-IP") || context.request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
    const regUA = context.request.headers.get("User-Agent") || "";
    const hashedPassword = await hashPassword3(password);
    await env.DB.prepare(
      `INSERT INTO users (name, password, doubao_id, agent_url, device_fingerprint, avatar, bio, registered_ip, last_login_ip, last_login_ua) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(name, hashedPassword, doubao_id, homepageUrl || null, device_fingerprint || null, avatar || null, bio || null, regIP, regIP, regUA).run();
    const user = await env.DB.prepare(
      `SELECT id, name, avatar, bio, doubao_id, agent_url, privacy_setting, created_at, last_login_ip, pat_suffix 
       FROM users WHERE doubao_id = ?`
    ).bind(doubao_id).first();
    const token = generateToken2();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1e3).toISOString();
    await env.DB.prepare(
      `INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)`
    ).bind(user.id, token, expiresAt).run();
    return Response.json({ success: true, data: user, token });
  } catch (e) {
    return Response.json({ success: false, error: "\u6CE8\u518C\u5931\u8D25\uFF1A" + e.message });
  }
}
__name(onRequestPost11, "onRequestPost");

// api/chat/index.js
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
__name(json, "json");
async function ensureTables(env) {
  const stmts = [
    "CREATE TABLE IF NOT EXISTS chat_rooms (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), matrix_room_id TEXT, type TEXT NOT NULL DEFAULT 'private', name TEXT, created_by TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))",
    "CREATE TABLE IF NOT EXISTS chat_room_members (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), room_id TEXT NOT NULL, user_id TEXT NOT NULL, matrix_user_id TEXT, joined_at TEXT DEFAULT (datetime('now')), UNIQUE(room_id, user_id))",
    "CREATE TABLE IF NOT EXISTS chat_stranger_limits (room_id TEXT NOT NULL, user_id TEXT NOT NULL, messages_sent INTEGER DEFAULT 1, UNIQUE(room_id, user_id))",
    "CREATE TABLE IF NOT EXISTS chat_unread (room_id TEXT NOT NULL, user_id TEXT NOT NULL, last_event_id TEXT, count INTEGER DEFAULT 0, UNIQUE(room_id, user_id))",
    "CREATE TABLE IF NOT EXISTS chat_muted (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL, muted_by TEXT NOT NULL, muted_until TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(room_id, user_id))",
    "CREATE TABLE IF NOT EXISTS chat_channel_settings (room_id TEXT PRIMARY KEY, created_by TEXT NOT NULL, admission TEXT DEFAULT 'open', topic TEXT DEFAULT '', avatar_url TEXT, created_at TEXT DEFAULT (datetime('now')))",
    "CREATE TABLE IF NOT EXISTS chat_banned (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL, banned_by TEXT NOT NULL, reason TEXT DEFAULT '', permanent INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), UNIQUE(room_id, user_id))",
    "CREATE TABLE IF NOT EXISTS chat_admins (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, user_id TEXT NOT NULL, set_by TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), UNIQUE(room_id, user_id))"
  ];
  for (const sql of stmts) {
    try {
      await env.DB.prepare(sql).raw();
    } catch (e) {
      try {
        await env.DB.prepare(sql).run();
      } catch (e2) {
      }
    }
  }
  await env.DB.prepare("ALTER TABLE chat_channel_settings ADD COLUMN avatar_url TEXT").run().catch(function() {
  });
  await env.DB.prepare("ALTER TABLE users ADD COLUMN pat_suffix TEXT").run().catch(function() {
  });
}
__name(ensureTables, "ensureTables");
async function isAdminOrCreator(env, room_id, user_id) {
  const room = await env.DB.prepare("SELECT created_by FROM chat_rooms WHERE id=?").bind(room_id).first();
  if (!room) return false;
  if (room.created_by === user_id) return "creator";
  const admin = await env.DB.prepare("SELECT id FROM chat_admins WHERE room_id=? AND user_id=?").bind(room_id, user_id).first();
  return admin ? "admin" : false;
}
__name(isAdminOrCreator, "isAdminOrCreator");
function sanitize(u) {
  if (!u) return null;
  const { password, device_fingerprint, registered_ip, ...safe } = u;
  return safe;
}
__name(sanitize, "sanitize");
async function onRequest(context) {
  const { env, request } = context;
  env._request = request;
  if (!env.DB) return json({ error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" }, 500);
  await ensureTables(env);
  const url = new URL(request.url);
  const method = request.method;
  const action = url.searchParams.get("action") || "";
  try {
    const body = method === "POST" || method === "PUT" ? await request.json().catch(() => ({})) : {};
    env._body = body;
    const resolvedAction = action || body.action || "";
    if (method === "GET" && resolvedAction === "channel-members") return await handleChannelMembers(env, url);
    if (method === "POST" && resolvedAction === "kick-member") return await handleKickMember(env, body);
    if (method === "POST" && resolvedAction === "delete-conversation") return await handleDeleteConversation(env, body);
    if (method === "POST" && resolvedAction === "cleanup-messages") return await handleCleanupMessages(env, body);
    return json({ error: "\u672A\u77E5\u64CD\u4F5C" }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
__name(onRequest, "onRequest");
async function handleChannelMembers(env, url) {
  const room_id = url.searchParams.get("room_id");
  if (!room_id) return json({ error: "room_id \u5FC5\u586B" });
  const members = await env.DB.prepare(
    "SELECT u.id, u.name, u.avatar, u.doubao_id, u.is_developer, m.joined_at, (SELECT 1 FROM chat_muted cm WHERE cm.room_id=m.room_id AND cm.user_id=m.user_id AND (cm.muted_until IS NULL OR cm.muted_until > datetime('now'))) as is_muted, (SELECT cm.muted_until FROM chat_muted cm WHERE cm.room_id=m.room_id AND cm.user_id=m.user_id) as muted_until, (SELECT 1 FROM chat_admins ca WHERE ca.room_id=m.room_id AND ca.user_id=m.user_id) as is_admin FROM chat_room_members m JOIN users u ON u.id=m.user_id WHERE m.room_id=? ORDER BY m.joined_at ASC"
  ).bind(room_id).all();
  return json({ members: members.results.map(sanitize) });
}
__name(handleChannelMembers, "handleChannelMembers");
async function handleKickMember(env, body) {
  const { user_id, room_id, target_user_id } = body;
  if (!user_id || !room_id || !target_user_id) return json({ error: "\u53C2\u6570\u4E0D\u5B8C\u6574" });
  const role = await isAdminOrCreator(env, room_id, user_id);
  if (!role) return json({ error: "\u53EA\u6709\u9891\u9053\u521B\u5EFA\u8005\u548C\u7BA1\u7406\u5458\u53EF\u4EE5\u8E22\u4EBA" });
  const room = await env.DB.prepare("SELECT created_by FROM chat_rooms WHERE id=?").bind(room_id).first();
  if (!room) return json({ error: "\u9891\u9053\u4E0D\u5B58\u5728" });
  if (target_user_id === room.created_by) return json({ error: "\u4E0D\u80FD\u8E22\u51FA\u9891\u9053\u521B\u5EFA\u8005" });
  if (role === "admin") {
    const targetAdmin = await env.DB.prepare("SELECT id FROM chat_admins WHERE room_id=? AND user_id=?").bind(room_id, target_user_id).first();
    if (targetAdmin) return json({ error: "\u7BA1\u7406\u5458\u4E0D\u80FD\u8E22\u51FA\u5176\u4ED6\u7BA1\u7406\u5458" });
  }
  await env.DB.prepare("DELETE FROM chat_room_members WHERE room_id=? AND user_id=?").bind(room_id, target_user_id).run();
  await env.DB.prepare("DELETE FROM chat_unread WHERE room_id=? AND user_id=?").bind(room_id, target_user_id).run();
  return json({ success: true });
}
__name(handleKickMember, "handleKickMember");
async function handleDeleteConversation(env, body) {
  const { user_id, room_id } = body;
  if (!user_id || !room_id) return json({ error: "\u53C2\u6570\u4E0D\u5B8C\u6574" });
  const room = await env.DB.prepare("SELECT * FROM chat_rooms WHERE id=?").bind(room_id).first();
  if (!room) return json({ error: "\u623F\u95F4\u4E0D\u5B58\u5728" });
  const member = await env.DB.prepare("SELECT id FROM chat_room_members WHERE room_id=? AND user_id=?").bind(room_id, user_id).first();
  if (!member) return json({ error: "\u60A8\u4E0D\u662F\u623F\u95F4\u6210\u5458" });
  if (room.type === "channel") {
    const role = await isAdminOrCreator(env, room_id, user_id);
    if (!role) return json({ error: "\u53EA\u6709\u9891\u9053\u521B\u5EFA\u8005\u548C\u7BA1\u7406\u5458\u53EF\u4EE5\u5220\u9664\u9891\u9053" });
    await env.DB.prepare("DELETE FROM chat_unread WHERE room_id=?").bind(room_id).run();
    await env.DB.prepare("DELETE FROM chat_stranger_limits WHERE room_id=?").bind(room_id).run();
    await env.DB.prepare("DELETE FROM chat_room_members WHERE room_id=?").bind(room_id).run();
    await env.DB.prepare("DELETE FROM chat_rooms WHERE id=?").bind(room_id).run();
    return json({ success: true, deleted: true });
  }
  await env.DB.prepare("DELETE FROM chat_unread WHERE room_id=? AND user_id=?").bind(room_id, user_id).run();
  await env.DB.prepare("DELETE FROM chat_room_members WHERE room_id=? AND user_id=?").bind(room_id, user_id).run();
  return json({ success: true, deleted: false });
}
__name(handleDeleteConversation, "handleDeleteConversation");
async function handleCleanupMessages(env, body) {
  try {
    const cutOff = new Date(Date.now() - 48 * 36e5).toISOString();
    let delMuted = 0, delBanned = 0;
    try {
      const muteRes = await env.DB.prepare("DELETE FROM chat_muted WHERE muted_until IS NOT NULL AND muted_until < datetime('now')").run();
      delMuted = muteRes.meta?.changes || 0;
    } catch (e) {
    }
    try {
      const banRes = await env.DB.prepare("DELETE FROM chat_banned WHERE permanent=0 AND created_at < ?").bind(cutOff).run();
      delBanned = banRes.meta?.changes || 0;
    } catch (e) {
    }
    return json({ success: true, deleted_muted: delMuted, deleted_banned: delBanned });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
__name(handleCleanupMessages, "handleCleanupMessages");

// chat/[[id]].js
async function onRequestGet12(context) {
  let fullPath = context.params.id || "";
  if (Array.isArray(fullPath)) {
    fullPath = fullPath.join("/");
  }
  fullPath = String(fullPath);
  const roomId = fullPath.split("/").filter(Boolean)[0] || "";
  if (!roomId) {
    return Response.redirect(
      new URL("/", context.request.url).toString(),
      302
    );
  }
  const targetUrl = new URL("/", context.request.url);
  targetUrl.searchParams.set("chat", roomId);
  return Response.redirect(targetUrl.toString(), 302);
}
__name(onRequestGet12, "onRequestGet");

// pages/[[id]].js
function loginWallHead() {
  return '<script id="hp-login">(function(){var t=typeof localStorage!="undefined"?localStorage.getItem("dp_token"):null;if(t){window._hpToken=t;}else{document.open();document.write("<!DOCTYPE html><html lang=\\"zh-CN\\"><head><meta charset=\\"UTF-8\\"><meta name=\\"viewport\\" content=\\"width=device-width,initial-scale=1\\"><title>\\u8BF7\\u5148\\u767B\\u5F55</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#F7F8FC;font-family:-apple-system,BlinkMacSystemFont,\\"PingFang SC\\",\\"Microsoft YaHei\\",sans-serif;text-align:center}.hp-c{padding:32px}.hp-i{font-size:64px;margin-bottom:24px}.hp-h{font-size:24px;font-weight:700;color:#1a1a2e;margin-bottom:12px}.hp-p{color:#9ca3af;margin-bottom:28px;font-size:14px;line-height:1.6}.hp-a{display:inline-flex;align-items:center;gap:6px;padding:12px 32px;border-radius:12px;background:linear-gradient(135deg,#FF6B35,#FF8F5E);color:#fff;text-decoration:none;font-size:15px;font-weight:600;transition:all .25s}.hp-a:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(255,107,53,.35)}</style></head><body><div class=\\"hp-c\\"><div class=\\"hp-i\\">\\uD83D\\uDD12</div><div class=\\"hp-h\\">\\u8BF7\\u5148\\u767B\\u5F55</div><div class=\\"hp-p\\">\\u8BBF\\u95EE\\u6B64\\u9875\\u9762\\u9700\\u8981\\u767B\\u5F55\\u9017\\u5305\\u7528\\u6237\\u5E7F\\u573A\\u8D26\\u53F7</div><a href=\\"\\" class=\\"hp-a\\">\\uD83C\\uDFE0 \\u524D\\u5F80\\u4E3B\\u9875\\u767B\\u5F55</a></div></body></html>");document.close();}})();<\/script>';
}
__name(loginWallHead, "loginWallHead");
function injectIntoHTML(html, block) {
  var hMatch = html.match(/<head[\s>]/i);
  if (hMatch) {
    var idx = hMatch.index;
    var tagEnd = html.indexOf(">", idx);
    if (tagEnd !== -1) {
      return html.slice(0, tagEnd + 1) + block + html.slice(tagEnd + 1);
    }
  }
  var hIdx = html.indexOf("</head>");
  if (hIdx === -1) hIdx = html.indexOf("</HEAD>");
  if (hIdx !== -1) {
    return html.slice(0, hIdx) + block + html.slice(hIdx);
  }
  return block + html;
}
__name(injectIntoHTML, "injectIntoHTML");
function getContentType2(filename) {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map = {
    "html": "text/html",
    "css": "text/css",
    "js": "application/javascript",
    "json": "application/json",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "svg": "image/svg+xml",
    "ico": "image/x-icon",
    "mp4": "video/mp4",
    "webm": "video/webm",
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "pdf": "application/pdf",
    "txt": "text/plain",
    "woff": "font/woff",
    "woff2": "font/woff2",
    "ttf": "font/ttf"
  };
  return map[ext] || "application/octet-stream";
}
__name(getContentType2, "getContentType");
async function onRequestGet13(context) {
  try {
    const { env, params } = context;
    let fullPath = params && params.id || "";
    if (Array.isArray(fullPath)) {
      fullPath = fullPath.join("/");
    }
    fullPath = String(fullPath);
    const parts = fullPath.split("/").filter(Boolean);
    const pageId = parts[0] || "";
    const filePath = parts.slice(1).join("/") || "index.html";
    if (!pageId) {
      return notFoundResponse("\u9875\u9762\u4E0D\u5B58\u5728");
    }
    if (env && env.PAGES_BUCKET) {
      try {
        const r2Key = `pages/${pageId}/${filePath}`;
        const obj = await env.PAGES_BUCKET.get(r2Key);
        if (obj) {
          const ct = obj.httpMetadata?.contentType || getContentType2(filePath);
          if (ct === "text/html") {
            const html = await new Response(obj.body).text();
            return new Response(injectIntoHTML(html, loginWallHead()), {
              headers: { "Content-Type": ct, "Cache-Control": "public, max-age=86400" }
            });
          }
          return new Response(obj.body, {
            headers: {
              "Content-Type": ct,
              "Cache-Control": "public, max-age=86400"
            }
          });
        }
      } catch (e) {
      }
    }
    if (filePath === "index.html" && env && env.DB) {
      try {
        const page = await env.DB.prepare(
          `SELECT title, html_content FROM custom_pages WHERE id = ?`
        ).bind(pageId).first();
        if (page) {
          return new Response(injectIntoHTML(page.html_content, loginWallHead()), {
            headers: { "Content-Type": "text/html" }
          });
        }
      } catch (e) {
      }
    }
    return notFoundResponse("\u6587\u4EF6\u4E0D\u5B58\u5728");
  } catch (e) {
    console.error("pages/[[id]] error:", e);
    return notFoundResponse("\u670D\u52A1\u5668\u9519\u8BEF");
  }
}
__name(onRequestGet13, "onRequestGet");
function notFoundResponse(msg) {
  return new Response('<!DOCTYPE html><html><head><title>404</title><meta charset="utf-8"></head><body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif"><div style="text-align:center"><h1>404</h1><p>' + msg + '</p><a href="/" style="color:#FF6B35">\u8FD4\u56DE\u9996\u9875</a></div></body></html>', {
    status: 404,
    headers: { "Content-Type": "text/html" }
  });
}
__name(notFoundResponse, "notFoundResponse");

// ../.wrangler/tmp/pages-IsLSIP/functionsRoutes-0.20288994686907502.mjs
var routes = [
  {
    routePath: "/api/users/:id/settings",
    mountPath: "/api/users/:id",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet]
  },
  {
    routePath: "/api/users/:id/settings",
    mountPath: "/api/users/:id",
    method: "PUT",
    middlewares: [],
    modules: [onRequestPut]
  },
  {
    routePath: "/api/pages/upload",
    mountPath: "/api/pages",
    method: "DELETE",
    middlewares: [],
    modules: [onRequestDelete]
  },
  {
    routePath: "/api/pages/upload",
    mountPath: "/api/pages",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet2]
  },
  {
    routePath: "/api/pages/upload",
    mountPath: "/api/pages",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost]
  },
  {
    routePath: "/api/users/auto-login",
    mountPath: "/api/users",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost2]
  },
  {
    routePath: "/api/users/login",
    mountPath: "/api/users",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost3]
  },
  {
    routePath: "/api/users/:id",
    mountPath: "/api/users",
    method: "DELETE",
    middlewares: [],
    modules: [onRequestDelete2]
  },
  {
    routePath: "/api/users/:id",
    mountPath: "/api/users",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet3]
  },
  {
    routePath: "/api/announcements",
    mountPath: "/api",
    method: "DELETE",
    middlewares: [],
    modules: [onRequestDelete3]
  },
  {
    routePath: "/api/announcements",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet4]
  },
  {
    routePath: "/api/announcements",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost4]
  },
  {
    routePath: "/api/announcements",
    mountPath: "/api",
    method: "PUT",
    middlewares: [],
    modules: [onRequestPut2]
  },
  {
    routePath: "/api/blocked",
    mountPath: "/api",
    method: "DELETE",
    middlewares: [],
    modules: [onRequestDelete4]
  },
  {
    routePath: "/api/blocked",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet5]
  },
  {
    routePath: "/api/blocked",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost5]
  },
  {
    routePath: "/api/custom-pages",
    mountPath: "/api",
    method: "DELETE",
    middlewares: [],
    modules: [onRequestDelete5]
  },
  {
    routePath: "/api/custom-pages",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet6]
  },
  {
    routePath: "/api/custom-pages",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost6]
  },
  {
    routePath: "/api/custom-pages",
    mountPath: "/api",
    method: "PUT",
    middlewares: [],
    modules: [onRequestPut3]
  },
  {
    routePath: "/api/features",
    mountPath: "/api",
    method: "DELETE",
    middlewares: [],
    modules: [onRequestDelete6]
  },
  {
    routePath: "/api/features",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet7]
  },
  {
    routePath: "/api/features",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost7]
  },
  {
    routePath: "/api/features",
    mountPath: "/api",
    method: "PUT",
    middlewares: [],
    modules: [onRequestPut4]
  },
  {
    routePath: "/api/friends",
    mountPath: "/api",
    method: "DELETE",
    middlewares: [],
    modules: [onRequestDelete7]
  },
  {
    routePath: "/api/friends",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet8]
  },
  {
    routePath: "/api/friends",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost8]
  },
  {
    routePath: "/api/friends",
    mountPath: "/api",
    method: "PUT",
    middlewares: [],
    modules: [onRequestPut5]
  },
  {
    routePath: "/api/proxy",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet9]
  },
  {
    routePath: "/api/proxy",
    mountPath: "/api",
    method: "OPTIONS",
    middlewares: [],
    modules: [onRequestOptions]
  },
  {
    routePath: "/api/proxy",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost9]
  },
  {
    routePath: "/api/reports",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost10]
  },
  {
    routePath: "/api/site-settings",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet10]
  },
  {
    routePath: "/api/site-settings",
    mountPath: "/api",
    method: "PUT",
    middlewares: [],
    modules: [onRequestPut6]
  },
  {
    routePath: "/api/users",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet11]
  },
  {
    routePath: "/api/users",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost11]
  },
  {
    routePath: "/api/chat",
    mountPath: "/api/chat",
    method: "",
    middlewares: [],
    modules: [onRequest]
  },
  {
    routePath: "/chat/:id*",
    mountPath: "/chat",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet12]
  },
  {
    routePath: "/pages/:id*",
    mountPath: "/pages",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet13]
  }
];

// ../../../../../../../opencode/npm-cache/_npx/32026684e21afda6/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../../../../../../../opencode/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");

// ../../../../../../../opencode/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../../../../opencode/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// ../.wrangler/tmp/bundle-4b7XXi/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = pages_template_worker_default;

// ../../../../../../../opencode/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// ../.wrangler/tmp/bundle-4b7XXi/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=functionsWorker-0.9798177705280926.mjs.map
