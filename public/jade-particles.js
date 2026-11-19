/* ═══════════════════════════════════════════════════════════
   V14.1 青碧指针粒子（网站集成版）
   ---------------------------------------------------------------
   把「指针点击/拖动发光粒子」作为独立 canvas 层集成进网站：
     · 仅在青碧色主题（body.theme-cyan）+ 着色器开启(dp_shader≠off)时启用
     · 颜色跟随青碧色系（--accent，默认 #06B6D4 / #22D3EE）
     · position:fixed; inset:0; z-index:-1; pointer-events:none —— 不遮挡正文
     · 与 fluid-canvas 同属背景层，插在 .noise-overlay 之前（噪点仍压其上）
     · MutationObserver 监听 body.class，主题/明暗切换自动显隐与换色
     · prefers-reduced-motion 早退，不启动 rAF
     · 空闲自动暂停 rAF（无粒子时清空画布并停帧），指针移动再唤醒，省 CPU

   粒子算法复刻自华为「异人之下」活动页（app.js 的 io 类 + meta.js 参数），
   配色与拖尾为青碧主题改造。原型见 pointer-particles.html。
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // 尊重系统减少动效：直接不启用
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch (e) {}
  if (!document.body) return;

  var OPT = {
    starRadius: 20, starSum: 10, initScope: 4,
    speeding: 4, drag: 0.81, dwindleStep: 0.5
  };
  // 青碧色阶（主题主色会在 sync() 里读 --accent 追加进来）
  var BASE_TINTS = ['#5eead4', '#2dd4bf', '#06B6D4', '#22D3EE', '#0d9488', '#67e8f9'];
  var SPRITE_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADwAAAA8BAMAAADI0sRBAAADI2lUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNS41LWMwMTQgNzkuMTUxNDgxLCAyMDEzLzAzLzEzLTEyOjA5OjE1ICAgICAgICAiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIiB4bWxuczpzdFJlZj0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlUmVmIyIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgQ0MgKE1hY2ludG9zaCkiIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6MDI1MjQ0MDJCOENFMTFFNEE1NTE4NjcxNUQ1Mzk1NjciIHhtcE1NOkRvY3VtZW50SUQ9InhtcC5kaWQ6MDI1MjQ0MDNCOENFMTFFNEE1NTE4NjcxNUQ1Mzk1NjciPiA8eG1wTU06RGVyaXZlZEZyb20gc3RSZWY6aW5zdGFuY2VJRD0ieG1wLmlpZDowMjUyNDQwMEI4Q0UxMUU0QTU1MTg2NzE1RDUzOTU2NyIgc3RSZWY6ZG9jdW1lbnRJRD0ieG1wLmRpZDowMjUyNDQwMUI4Q0UxMUU0QTU1MTg2NzE1RDUzOTU2NyIvPiA8L3JkZjpEZXNjcmlwdGlvbj4gPC9yZGY6UkRGPiA8L3g6eG1wbWV0YT4gPD94cGFja2V0IGVuZD0iciI/PlIcnpEAAAAZdEVYdFNvZnR3YXJlAEFkb2JlIEltYWdlUmVhZHlxyWU8AAAAMFBMVEVHcEz///////////////////////////////////////////////////////////9EPuwCAAAAEHRSTlMABPILGC8lVRI/e73iaYRPHtT7twAAAJxJREFUOMtjYBgFo2AggKCgoSBOSUZhixaPZkMBXHot3EJDU5oFcWl2i/xePzUFh3ZGk8zada+uT3PGLs3cNn31IZ1dlRkGWKWFXas2KSlpLw8xxCotkXlbCQj2TmvELh2/BiR96it2aZHwRyBpvVJHrNIm+KUJGE7AaQQ8RiBYCAQqgShhEMYboYSSAygxCQriTW0CoxluFNAIAABCfjyfRyRQqQAAAABJRU5ErkJggg==';

  var canvas = document.createElement('canvas');
  canvas.id = 'jade-particles-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:-1;pointer-events:none;display:none';
  var noise = document.querySelector('.noise-overlay');
  if (noise && noise.parentNode) noise.parentNode.insertBefore(canvas, noise);
  else document.body.appendChild(canvas);
  var ctx = canvas.getContext('2d');
  if (!ctx) { if (canvas.parentNode) canvas.parentNode.removeChild(canvas); return; }

  var W = 0, H = 0, DPR = 1;
  var sprite = new Image();
  sprite.src = SPRITE_SRC;
  var tinted = [];
  var accentKey = '';

  var stars = [], ripples = [];
  var pointerDown = false, lastX = null, lastY = null;
  var running = false, emptyFrames = 0, rafId = 0;
  var active = false;
  var PI2 = Math.PI * 2;

  function rand(a, b) { return a + Math.random() * (b - a); }
  function randInt(a, b) { return Math.floor(rand(a, b)); }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    W = window.innerWidth || document.documentElement.clientWidth || 1;
    H = window.innerHeight || document.documentElement.clientHeight || 1;
    canvas.width = Math.max(1, Math.round(W * DPR));
    canvas.height = Math.max(1, Math.round(H * DPR));
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  // 用发光点贴图 + 主题色 source-atop 染色，生成一组青碧粒子贴图
  function buildTints() {
    var colors = BASE_TINTS.slice();
    try {
      var acc = (getComputedStyle(document.body).getPropertyValue('--accent') || '').trim();
      if (acc && colors.indexOf(acc) < 0) colors.push(acc);
      var acc2 = (getComputedStyle(document.body).getPropertyValue('--accent-light') || '').trim();
      if (acc2 && colors.indexOf(acc2) < 0) colors.push(acc2);
      accentKey = acc + '|' + acc2;
    } catch (e) {}
    tinted = colors.map(function (color) {
      var c = document.createElement('canvas');
      c.width = c.height = 60;
      var g = c.getContext('2d');
      g.drawImage(sprite, 0, 0, 60, 60);
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = color;
      g.fillRect(0, 0, 60, 60);
      return c;
    });
  }

  function Star(x, y, power) {
    this.r = rand(2, OPT.starRadius * (power || 1));
    this.x = x; this.y = y;
    this.dir = randInt(0, 4);
    this.vx = rand(-OPT.speeding, OPT.speeding) * (power || 1);
    this.vy = rand(-OPT.speeding, OPT.speeding) * (power || 1);
    this.drag = OPT.drag;
    this.dwindle = OPT.dwindleStep;
    this.theta = rand(0, PI2);
    this.img = tinted.length ? tinted[randInt(0, tinted.length)] : sprite;
  }
  Star.prototype.step = function () {
    this.vx *= this.drag; this.vy *= this.drag;
    if (this.dir === 0)      { this.x -= this.vx; this.y -= this.vy; }
    else if (this.dir === 1) { this.x += this.vx; this.y -= this.vy; }
    else if (this.dir === 2) { this.x += this.vx; this.y += this.vy; }
    else                     { this.x -= this.vx; this.y += this.vy; }
    this.vx += 0.1 * Math.cos(this.theta);
    this.vy += 0.1 * Math.sin(this.theta);
    this.r -= rand(0, this.dwindle);
  };
  Star.prototype.draw = function () {
    if (this.r <= 0) return;
    var t = this.r / 2;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.theta);
    ctx.drawImage(this.img, -t, -t, this.r, this.r);
    ctx.restore();
  };

  function Ripple(x, y) { this.x = x; this.y = y; this.r = 4; this.a = 0.85; }
  Ripple.prototype.step = function () { this.r += 5; this.a *= 0.9; };
  Ripple.prototype.draw = function () {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r, 0, PI2);
    var acc = '';
    try { acc = (getComputedStyle(document.body).getPropertyValue('--accent-light') || '').trim(); } catch (e) {}
    ctx.strokeStyle = acc ? hexToRgba(acc, this.a.toFixed(3)) : 'rgba(94,234,212,' + this.a.toFixed(3) + ')';
    ctx.lineWidth = 2; ctx.stroke();
  };
  function hexToRgba(hex, a) {
    hex = String(hex).replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(hex, 16);
    if (isNaN(n)) return 'rgba(94,234,212,' + a + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function emit(x, y, count, power) {
    count = count || OPT.starSum;
    power = power || 1;
    for (var i = 0; i < count; i++) {
      var sx = randInt(0, OPT.initScope), sy = randInt(0, OPT.initScope);
      var d = i % 4;
      var px = x + (d === 1 || d === 2 ? sx : -sx);
      var py = y + (d === 2 || d === 3 ? sy : -sy);
      stars.push(new Star(px, py, power));
    }
    if (stars.length > 1200) stars.splice(0, stars.length - 1200);
  }
  function burst(x, y) {
    emit(x, y, OPT.starSum * 7, 1.9);
    ripples.push(new Ripple(x, y));
  }

  function frame() {
    if (!active) { running = false; return; }
    // 半透明擦除形成拖尾；无粒子累计一定帧数后清空并暂停，省 CPU
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(0, 0, W, H);

    ctx.globalCompositeOperation = 'lighter';
    for (var i = stars.length - 1; i >= 0; i--) {
      var s = stars[i];
      s.step();
      if (s.r <= 0) { stars.splice(i, 1); continue; }
      s.draw();
    }
    for (var j = ripples.length - 1; j >= 0; j--) {
      var rp = ripples[j];
      rp.step();
      if (rp.a < 0.02) { ripples.splice(j, 1); continue; }
      rp.draw();
    }
    ctx.globalCompositeOperation = 'source-over';

    if (!stars.length && !ripples.length) {
      emptyFrames++;
      if (emptyFrames > 12) {
        ctx.clearRect(0, 0, W, H);
        running = false;
        return; // 停帧，等下次指针事件唤醒
      }
    } else {
      emptyFrames = 0;
    }
    rafId = requestAnimationFrame(frame);
  }
  function kick() {
    if (!active) return;
    emptyFrames = 0;
    if (!running) { running = true; rafId = requestAnimationFrame(frame); }
  }

  function onMove(e) {
    if (!active) return;
    var x = e.clientX, y = e.clientY;
    var step = (lastX === null) ? 0 : Math.hypot(x - lastX, y - lastY);
    var stride = Math.max(1, Math.min(6, Math.floor(step / 14)));
    for (var k = 0; k < stride; k++) {
      emit(x, y, pointerDown ? OPT.starSum * 2 : OPT.starSum, pointerDown ? 1.4 : 1);
    }
    lastX = x; lastY = y;
    kick();
  }
  function onDown(e) {
    if (!active) return;
    pointerDown = true;
    burst(e.clientX, e.clientY);
    lastX = e.clientX; lastY = e.clientY;
    kick();
  }
  function onUp() { pointerDown = false; }

  // 门控：仅青碧色主题 + 着色器开启时启用
  function wantActive() {
    var off = false;
    try { off = localStorage.getItem('dp_shader') === 'off'; } catch (e) {}
    var isCyan = !!document.body && document.body.classList.contains('theme-cyan');
    return isCyan && !off;
  }

  // 主题/明暗/开关变化时同步显隐与配色
  function sync() {
    var wasActive = active;
    active = wantActive();
    if (!active) {
      canvas.style.display = 'none';
      stars.length = 0; ripples.length = 0;
      running = false;
      if (rafId) { try { cancelAnimationFrame(rafId); } catch (e) {} rafId = 0; }
      try { ctx.clearRect(0, 0, W, H); } catch (e) {}
      return;
    }
    canvas.style.display = '';
    if (!W || !H || canvas.width !== Math.round(W * DPR)) resize();
    // 主题色变化时重建贴图
    var accNow = '';
    try {
      accNow = (getComputedStyle(document.body).getPropertyValue('--accent') || '').trim() + '|' +
               (getComputedStyle(document.body).getPropertyValue('--accent-light') || '').trim();
    } catch (e) {}
    if (!tinted.length || accNow !== accentKey) buildTints();
    if (!wasActive) kick();
  }

  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerdown', onDown, { passive: true });
  window.addEventListener('pointerup', onUp, { passive: true });
  window.addEventListener('pointercancel', onUp, { passive: true });
  window.addEventListener('resize', function () { resize(); }, { passive: true });

  if (window.MutationObserver && document.body) {
    try { new MutationObserver(function () { sync(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] }); } catch (e) {}
  }
  // 供 syncMetaThemeColor() 在主题切换时主动调用
  window.__npJadeSync = sync;

  // 启动：等贴图加载完成后首次同步
  function boot() {
    resize();
    buildTints();
    sync();
  }
  if (sprite.complete) boot();
  else sprite.onload = boot;
})();
