/*! Genie window animation for My Pins (adapted from the Local Video Player version).
 * API: GenieFX.run(card, scrim, origin{x,y,w}, 'open'|'close', done)
 *      GenieFX.on() / GenieFX.set(bool)   (preference is stored in localStorage)
 * Falls back to "no animation" (calls done immediately) if WebGL or the snapshot fails. */
(() => {
  'use strict';
  const KEY = 'pins.genie', ROWS = 90, LAG = 0.7, TIP = 24, PAD = 80, MAX = 2500, OPEN_MS = 640, CLOSE_MS = 520;
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const smooth = t => t * t * (3 - 2 * t);
  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let on = true, broken = false, busy = false;
  try { on = localStorage.getItem(KEY) !== 'off'; } catch (e) {}

  const css = document.createElement('style');
  css.textContent = `.genie-hold{opacity:0!important;transition:none!important;animation:none!important}
.genie-live{animation:none!important}
#genieCanvas{position:fixed;left:0;top:0;pointer-events:none;z-index:2147483646;display:none}`;
  document.head.appendChild(css);

  /* ---------- WebGL ---------- */
  const canvas = document.createElement('canvas');
  canvas.id = 'genieCanvas';
  canvas.setAttribute('aria-hidden', 'true');
  let gl = null, isGL2 = false, posBuf, uViewport, uAlpha;
  const pos = new Float32Array((ROWS + 1) * 4);
  try {
    const o = { alpha: true, premultipliedAlpha: true, antialias: true };
    gl = canvas.getContext('webgl2', o);
    isGL2 = !!gl;
    if (!gl) gl = canvas.getContext('webgl', o);
    if (gl) {
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, `attribute vec2 aPos;attribute vec2 aUv;uniform vec2 uViewport;varying vec2 vUv;
void main(){vec2 c=aPos/uViewport;gl_Position=vec4(c.x*2.0-1.0,1.0-c.y*2.0,0.0,1.0);vUv=aUv;}`));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `precision mediump float;uniform sampler2D uTex;uniform float uAlpha;varying vec2 vUv;
void main(){gl_FragColor=texture2D(uTex,vUv)*uAlpha;}`));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) gl = null;
      else {
        gl.useProgram(prog);
        uViewport = gl.getUniformLocation(prog, 'uViewport');
        uAlpha = gl.getUniformLocation(prog, 'uAlpha');
        const uv = new Float32Array((ROWS + 1) * 4);
        for (let k = 0; k <= ROWS; k++) uv.set([0, k / ROWS, 1, k / ROWS], k * 4);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
        const aUv = gl.getAttribLocation(prog, 'aUv');
        gl.enableVertexAttribArray(aUv);
        gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
        posBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
        gl.bufferData(gl.ARRAY_BUFFER, pos.byteLength, gl.DYNAMIC_DRAW);
        const aPos = gl.getAttribLocation(prog, 'aPos');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearColor(0, 0, 0, 0);
      }
    }
  } catch (e) { gl = null; }

  function makeTexture(img) {
    try {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (isGL2) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
      else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      return tex;
    } catch (e) { broken = true; return null; }
  }

  /* ---------- DOM -> image snapshot (computed styles written inline into an SVG foreignObject) ---------- */
  const SKIP_TAGS = new Set(['script', 'style', 'link', 'noscript', 'video', 'audio', 'iframe', 'object', 'embed', 'template', 'canvas']);
  const SKIP_PROP = /^(transition|animation|will-change|cursor|pointer-events|user-select|-webkit-user-select|scroll|overscroll|touch-action|resize|view-transition|anchor|position-|interactivity|caret|-webkit-locale|-webkit-tap|container|content-visibility|inline-size|block-size|min-inline|min-block|max-inline|max-block|margin-inline|margin-block|padding-inline|padding-block|border-inline|border-block|inset-inline|inset-block|border-start|border-end|app-region|-webkit-app-region)/;
  const FORCE = new Set(['width', 'height', 'display', 'position', 'box-sizing']);
  let frame = null;
  const baseCache = new Map();

  function readStyle(cs) {
    const o = {};
    for (let i = 0; i < cs.length; i++) { const n = cs[i]; if (!SKIP_PROP.test(n)) o[n] = cs.getPropertyValue(n); }
    return o;
  }
  function baselineFor(node) {
    const key = node.localName;
    let b = baseCache.get(key);
    if (b) return b;
    if (!frame) {
      frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.style.cssText = 'position:fixed;left:-9999px;top:0;width:1234px;height:600px;border:0;visibility:hidden;pointer-events:none';
      document.body.appendChild(frame);
      const d = frame.contentDocument; d.open(); d.write('<!doctype html><html><body></body></html>'); d.close();
    }
    const d = frame.contentDocument, el = d.createElement(node.localName);
    d.body.appendChild(el);
    b = readStyle(frame.contentWindow.getComputedStyle(el));
    el.remove();
    baseCache.set(key, b);
    return b;
  }
  function styleString(vals, base, parent) {
    let s = '';
    for (const n in vals) { const v = vals[n]; if (FORCE.has(n) || v !== base[n] || v !== parent[n]) s += n + ':' + v + ';'; }
    return s;
  }
  function pseudo(host, which, hostVals) {
    const pcs = getComputedStyle(host, which), c = pcs.content;
    if (!c || c === 'none' || c === 'normal' || pcs.display === 'none') return null;
    const sp = document.createElement('span'), vals = readStyle(pcs);
    delete vals.content;
    sp.setAttribute('style', styleString(vals, baselineFor(sp), hostVals));
    const m = /^"([\s\S]*)"$/.exec(c);
    if (m) sp.textContent = m[1];
    return sp;
  }
  function cloneEl(node, ctx, pv, root) {
    if (++ctx.n > MAX) throw new Error('snapshot too large');
    const tag = node.localName;
    if (SKIP_TAGS.has(tag)) return null;
    const cs = getComputedStyle(node);
    if (cs.display === 'none') return null;
    const out = node.cloneNode(false);
    for (const a of Array.from(out.attributes)) if (/^on/i.test(a.name)) out.removeAttribute(a.name);
    const vals = readStyle(cs);
    let s = styleString(vals, baselineFor(node), pv);
    if (/auto|scroll/.test(cs.overflowX + cs.overflowY)) s += 'overflow:hidden;';
    if (root) {
      const r = ctx.rect;
      s += `position:absolute;left:${PAD}px;top:${PAD}px;right:auto;bottom:auto;margin:0;transform:none;translate:none;rotate:none;scale:none;opacity:1;visibility:visible;` +
           `width:${r.width}px;height:${r.height}px;min-width:0;min-height:0;max-width:none;max-height:none;box-sizing:border-box;`;
    }
    out.setAttribute('style', s);
    if (tag === 'input') out.setAttribute('value', node.value);
    if (tag === 'textarea') { out.textContent = node.value; return out; }
    const b = pseudo(node, '::before', vals); if (b) out.appendChild(b);
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out.appendChild(c.cloneNode());
      else if (c.nodeType === 1) { const k = cloneEl(c, ctx, vals, false); if (k) out.appendChild(k); }
    }
    const a = pseudo(node, '::after', vals); if (a) out.appendChild(a);
    return out;
  }
  function serialize(card, r) {
    const ctx = { n: 0, rect: r };
    const xml = new XMLSerializer().serializeToString(cloneEl(card, ctx, baselineFor(document.createElement('div')), true));
    const W = r.width + PAD * 2, H = r.height + PAD * 2, sc = Math.min(devicePixelRatio || 1, 2.5, 4096 / Math.max(W, H));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * sc}" height="${H * sc}" viewBox="0 0 ${W} ${H}"><foreignObject x="0" y="0" width="${W}" height="${H}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${W}px;height:${H}px;overflow:hidden">${xml}</div></foreignObject></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  async function snapshot(card, r) {
    const img = new Image();
    const ok = await new Promise(res => { img.onload = () => res(true); img.onerror = () => res(false); img.src = serialize(card, r); });
    return ok ? makeTexture(img) : null;
  }

  /* ---------- Mesh warp ---------- */
  function fit() {
    const dpr = devicePixelRatio || 1, w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      canvas.style.width = innerWidth + 'px'; canvas.style.height = innerHeight + 'px';
    }
    gl.viewport(0, 0, w, h);
  }
  function draw(tex, g, p) {
    const cxw = g.left + g.TW / 2;
    let prevY = -Infinity;
    for (let k = 0; k <= ROWS; k++) {
      const f = k / ROWS, d = g.nearTop ? f : 1 - f;
      const s = clamp(p * (1 + LAG) - d * LAG), ey = 1 - (1 - s) * (1 - s), ex = smooth(s);
      const y0 = g.top + f * g.TH;
      let y = y0 + (g.ty - y0) * ey;
      if (y < prevY) y = prevY;
      prevY = y;
      const cx = cxw + (g.tx - cxw) * ex, w = g.TW + (g.tip - g.TW) * ey, i = k * 4;
      pos[i] = cx - w / 2; pos[i + 1] = y; pos[i + 2] = cx + w / 2; pos[i + 3] = y;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
    gl.uniform2f(uViewport, innerWidth, innerHeight);
    gl.uniform1f(uAlpha, 1 - smooth(clamp((p - 0.86) / 0.14)));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, (ROWS + 1) * 2);
  }

  /* ---------- Public API ---------- */
  const enabled = () => on && !reduced.matches && !broken && !!gl;

  async function run(card, scrim, o, dir, done) {
    if (!card || !enabled() || busy) { done && done(); return; }
    busy = true;
    const open = dir === 'open';
    if (open) { card.classList.add('genie-hold'); if (scrim) { scrim.style.animation = 'none'; scrim.style.opacity = '0'; } }
    const r = card.getBoundingClientRect();
    let tex = null;
    try { tex = r.width > 4 && r.height > 4 ? await snapshot(card, r) : null; } catch (e) { broken = true; }
    if (!tex) {                                           // fall back to no animation
      card.classList.remove('genie-hold');
      if (scrim) scrim.style.opacity = '';
      busy = false; done && done(); return;
    }
    const g = { left: r.left - PAD, top: r.top - PAD, TW: r.width + PAD * 2, TH: r.height + PAD * 2, tx: o.x, ty: o.y, tip: Math.min(TIP, Math.max(10, o.w * 0.55)) };
    g.nearTop = o.y < g.top + g.TH / 2;
    const from = open ? 1 : 0, to = open ? 0 : 1, dur = open ? OPEN_MS : CLOSE_MS;
    card.classList.add('genie-hold');
    if (canvas.parentNode !== document.body) document.body.appendChild(canvas);
    canvas.style.display = 'block';
    const t0 = performance.now();
    const step = now => {
      const k = clamp((now - t0) / dur), p = k >= 1 ? to : from + (to - from) * ease(k);
      fit(); gl.clear(gl.COLOR_BUFFER_BIT);
      if (k < 1) draw(tex, g, p);
      if (scrim) scrim.style.opacity = String(clamp(1 - p));
      if (k < 1) { requestAnimationFrame(step); return; }
      canvas.style.display = 'none';
      gl.deleteTexture(tex);
      if (open) { card.classList.remove('genie-hold'); card.classList.add('genie-live'); if (scrim) scrim.style.opacity = ''; }
      busy = false; done && done();
    };
    requestAnimationFrame(step);
  }

  window.GenieFX = {
    run,
    on: () => on,
    set(v) { on = !!v; try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) {} }
  };
})();
