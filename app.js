'use strict';
(() => {
const W = 1280, H = 720;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* ---------------- constants ---------------- */
const LAYERS = ['reference', 'fill', 'tone', 'pencil', 'ink', 'notes'];
const LAYER_LABEL = { reference: 'reference', fill: 'fill', tone: 'tone', pencil: 'pencil', ink: 'ink', notes: 'notes' };
const TOOLS = [
  { id: 'light', layer: 'reference', label: 'Light', img: 'assets/brush/toolbar-brush-tools-0.png' },
  { id: 'fillbrush', layer: 'fill', label: 'Fill', img: 'assets/brush/toolbar-brush-tools-1.png' },
  { id: 'tone', layer: 'tone', label: 'Tone', img: 'assets/brush/toolbar-brush-tools-2.png' },
  { id: 'pencil', layer: 'pencil', label: 'Pencil', img: 'assets/brush/toolbar-brush-tools-3.png' },
  { id: 'ink', layer: 'ink', label: 'Ink', img: 'assets/brush/toolbar-brush-tools-4.png' },
  { id: 'note', layer: 'notes', label: 'Note', img: 'assets/brush/toolbar-brush-tools-5.png' },
  { id: 'eraser', layer: null, label: 'Erase', img: 'assets/brush/toolbar-brush-tools-6.png' }
];
const PALETTE = ['#111111', '#8d8d8d', '#f2f2f2', '#4a7fb5'];

/* ---------------- dom ---------------- */
const view = $('#c'), ctx = view.getContext('2d');
const scratch = document.createElement('canvas'); scratch.width = W; scratch.height = H;
const sctx = scratch.getContext('2d');
const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
const tctx = tmp.getContext('2d');

/* ---------------- state ---------------- */
const S = {
  project: null, idx: 0, tool: 'ink', layer: 'ink', color: '#111111', size: 8,
  bucket: false, onion: true, captions: false, pencilOnly: false,
  guides: { grid: false, center: false, thirds: false }, playing: false
};
const rt = {
  mem: new Map(), hydrated: new Set(), hydrating: new Map(), dirty: new Set(),
  undo: [], redo: [], snap: new Map(), imgs: new Map(),
  saveT: 0, playT: 0, raf: 0, active: null, lastPen: 0, booted: false
};

/* ---------------- model ---------------- */
const newFrame = (shot = '1') => ({
  id: uid(), shot, newShot: false, durationMs: 2000,
  dialogue: '', action: '', notes: '', lineMiles: 0, layers: {}
});
const freshProject = () => ({ title: 'Untitled', fps: 12, frames: [newFrame()] });
const F = () => S.project && S.project.frames[S.idx];
const byId = id => S.project.frames.find(f => f.id === id);

function migrate(p) {
  if (!p || !Array.isArray(p.frames)) return freshProject();
  if (!p.frames.length) p.frames.push(newFrame());
  p.fps = clamp(+p.fps || 12, 1, 60);
  p.title = p.title || 'Untitled';
  p.frames.forEach(f => {
    if (!f.layers) f.layers = {};
    if (f.main) { f.layers.pencil = f.main; delete f.main; }
    if (f.fill) { f.layers.fill = f.fill; delete f.fill; }
    if (f.desc !== undefined) { if (!f.dialogue) f.dialogue = f.desc; delete f.desc; }
    f.shot = f.shot || '1';
    f.durationMs = clamp(+f.durationMs || 2000, 100, 600000);
    f.lineMiles = +f.lineMiles || 0;
    f.dialogue = f.dialogue || '';
    f.action = f.action || '';
    f.notes = f.notes || '';
    f.newShot = !!f.newShot;
  });
  return p;
}

function applyProject(p) {
  S.project = migrate(p);
  rt.mem.clear(); rt.hydrated.clear(); rt.hydrating.clear(); rt.dirty.clear();
  rt.undo.length = 0; rt.redo.length = 0; rt.snap.clear();
  S.playing = false; S.idx = 0;
  buildStrip();
  syncMeta();
  paint();
}

/* ---------------- layers / memory ---------------- */
function mk() { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; }

function getCv(f, name, create) {
  let m = rt.mem.get(f.id);
  if (!m) { if (!create) return null; m = new Map(); rt.mem.set(f.id, m); }
  let cv = m.get(name);
  if (!cv && create) { cv = mk(); m.set(name, cv); }
  return cv || null;
}

function loadInto(cv, url) {
  return new Promise(res => {
    if (!url) { cv.getContext('2d').clearRect(0, 0, W, H); return res(); }
    const im = new Image();
    im.onload = () => {
      const c = cv.getContext('2d');
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, W, H); c.drawImage(im, 0, 0); res();
    };
    im.onerror = () => res();
    im.src = url;
  });
}

function hydrate(f) {
  if (!f) return Promise.resolve();
  if (rt.hydrating.has(f.id)) return rt.hydrating.get(f.id);
  const jobs = [];
  for (const n of LAYERS) {
    const url = f.layers && f.layers[n];
    if (!url) continue;
    const key = f.id + ':' + n;
    if (rt.hydrated.has(key)) continue;
    const cv = getCv(f, n, true);
    if (!cv) continue;
    rt.hydrated.add(key);
    jobs.push(loadInto(cv, url));
  }
  const p = Promise.all(jobs).finally(() => rt.hydrating.delete(f.id));
  rt.hydrating.set(f.id, p);
  return p;
}

function stashFrame(f) {
  const m = rt.mem.get(f.id);
  if (!m) return;
  for (const [n, cv] of m) {
    if (rt.dirty.has(f.id + ':' + n)) f.layers[n] = cv.toDataURL('image/png');
  }
}

function evictFar() {
  const keep = new Set();
  [S.idx - 1, S.idx, S.idx + 1].forEach(i => {
    const f = S.project.frames[i];
    if (f) keep.add(f.id);
  });
  for (const fid of Array.from(rt.mem.keys())) {
    if (keep.has(fid)) continue;
    const f = byId(fid);
    if (f) stashFrame(f);
    rt.mem.delete(fid);
    rt.hydrated.forEach(k => { if (k.indexOf(fid + ':') === 0) rt.hydrated.delete(k); });
    rt.hydrating.delete(fid);
  }
}

/* ---------------- render ---------------- */
function scheduleRender() {
  if (rt.raf) return;
  rt.raf = requestAnimationFrame(() => { rt.raf = 0; paint(); });
}

function paint() {
  const f = F(); if (!f) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  if (S.onion && !S.playing && S.idx > 0) drawOnion();
  for (const n of LAYERS) {
    const cv = getCv(f, n, false);
    if (cv) ctx.drawImage(cv, 0, 0);
  }
  if (S.captions && f.dialogue) drawCaption(ctx, f.dialogue, 1);
  drawGuides();
}

function drawOnion() {
  const pf = S.project.frames[S.idx - 1];
  if (!pf) return;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.globalAlpha = 1; sctx.globalCompositeOperation = 'source-over';
  sctx.clearRect(0, 0, W, H);
  for (const n of LAYERS) {
    const cv = getCv(pf, n, false);
    if (cv) sctx.drawImage(cv, 0, 0);
  }
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = '#e53935'; sctx.fillRect(0, 0, W, H);
  sctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 0.22;
  ctx.drawImage(scratch, 0, 0);
  ctx.globalAlpha = 1;
}

function drawGuides() {
  const g = S.guides;
  if (!g.grid && !g.center && !g.thirds) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,.17)';
  ctx.lineWidth = 1;
  if (g.grid) {
    for (let x = 80; x < W; x += 80) { ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, H); ctx.stroke(); }
    for (let y = 80; y < H; y += 80) { ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(W, y + .5); ctx.stroke(); }
  }
  if (g.thirds) {
    [W / 3, W * 2 / 3].forEach(x => { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); });
    [H / 3, H * 2 / 3].forEach(y => { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); });
  }
  if (g.center) {
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
  }
  ctx.restore();
}

function drawCaption(c, text, scale) {
  const fs = 30 * scale, pad = 18 * scale, maxW = W - 200 * scale;
  const font = '400 ' + fs + 'px thicccboi, -apple-system, sans-serif';
  c.save();
  c.font = font;
  const chars = String(text).split('');
  const lines = [];
  let line = '';
  for (const ch of chars) {
    if (ch === '\n') { lines.push(line); line = ''; continue; }
    const test = line + ch;
    if (c.measureText(test).width > maxW && line) { lines.push(line); line = ch; }
    else line = test;
  }
  if (line) lines.push(line);
  const lh = fs * 1.32;
  let widest = 0;
  lines.forEach(l => { widest = Math.max(widest, c.measureText(l).width); });
  const boxH = lines.length * lh + pad * 2;
  const boxW = widest + pad * 2;
  const x = (W - boxW) / 2, y = H - boxH - 26 * scale;
  c.fillStyle = 'rgba(255,255,255,.86)';
  const r = 6 * scale;
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + boxW, y, x + boxW, y + boxH, r);
  c.arcTo(x + boxW, y + boxH, x, y + boxH, r); c.arcTo(x, y + boxH, x, y, r);
  c.arcTo(x, y, x + boxW, y, r); c.closePath(); c.fill();
  c.fillStyle = '#111'; c.textAlign = 'center'; c.textBaseline = 'top';
  lines.forEach((l, i) => c.fillText(l, W / 2, y + pad + i * lh + (lh - fs) / 2));
  c.restore();
}

/* ---------------- thumbnails ---------------- */
const drawThumb = async f => {
  const cv = f._cv;
  if (!cv) return;
  const c = cv.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
  for (const n of LAYERS) {
    const mem = getCv(f, n, false);
    if (mem) { c.drawImage(mem, 0, 0, cv.width, cv.height); continue; }
    const url = f.layers[n];
    if (!url) continue;
    const im = await loadImg(url);
    if (im) c.drawImage(im, 0, 0, cv.width, cv.height);
  }
};

function loadImg(url) {
  let p = rt.imgs.get(url);
  if (p) return p;
  p = new Promise(res => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = url;
  });
  rt.imgs.set(url, p);
  if (rt.imgs.size > 40) rt.imgs.delete(rt.imgs.keys().next().value);
  return p;
}

function buildStrip() {
  const drawer = $('#thumbnail-drawer');
  drawer.innerHTML = '';
  S.project.frames.forEach((f, i) => {
    const b = document.createElement('button');
    b.className = 'thumb';
    const cv = document.createElement('canvas');
    cv.width = 220; cv.height = 124;
    b.appendChild(cv); f._cv = cv;
    const num = document.createElement('span');
    num.className = 'num'; num.textContent = f.shot || String(i + 1);
    b.appendChild(num);
    b.addEventListener('click', () => { if (!S.playing) select(i); });
    drawer.appendChild(b);
    drawThumb(f);
  });
  highlightStrip();
}

function highlightStrip() {
  const f = F();
  $$('#thumbnail-drawer .thumb').forEach((el, i) => {
    el.classList.toggle('sel', i === S.idx);
    const fr = S.project.frames[i];
    el.classList.toggle('newshot', !!(fr && fr.newShot));
    const num = el.querySelector('.num');
    if (num && fr) num.textContent = fr.shot || String(i + 1);
  });
}

/* ---------------- select / navigation ---------------- */
async function select(i, opts = {}) {
  if (!S.project) return;
  i = clamp(i, 0, S.project.frames.length - 1);
  S.idx = i;
  evictFar();
  const f = F();
  await hydrate(f);
  if (S.onion && i > 0) await hydrate(S.project.frames[i - 1]);
  syncMeta(); paint(); highlightStrip(); drawThumb(f); syncTransport(); syncSeek();
  if (!opts.play) scheduleSave();
}

function addFrame() {
  const cur = F();
  const nf = newFrame(cur ? cur.shot : '1');
  if (!S.project.frames.length) { S.project.frames.push(nf); buildStrip(); select(0); }
  else {
    S.project.frames.splice(S.idx + 1, 0, nf);
    buildStrip(); select(S.idx + 1);
  }
  scheduleSave();
}

async function dupFrame() {
  const f = F(); if (!f) return;
  stashFrame(f);
  const nf = newFrame(f.shot);
  nf.newShot = false; nf.durationMs = f.durationMs;
  nf.dialogue = f.dialogue; nf.action = f.action; nf.notes = f.notes;
  nf.layers = Object.assign({}, f.layers);
  S.project.frames.splice(S.idx + 1, 0, nf);
  buildStrip(); await select(S.idx + 1);
  scheduleSave();
}

function delFrame() {
  if (S.project.frames.length <= 1) { clearFrame(); return; }
  const f = S.project.frames[S.idx];
  rt.mem.delete(f.id);
  S.project.frames.splice(S.idx, 1);
  buildStrip(); select(Math.min(S.idx, S.project.frames.length - 1));
  scheduleSave();
}

function clearFrame() {
  const f = F(); if (!f) return;
  for (const n of LAYERS) {
    const cv = getCv(f, n, false);
    if (!cv && !f.layers[n]) continue;
    const before = cv ? cv.toDataURL('image/png') : (f.layers[n] || '');
    if (cv) cv.getContext('2d').clearRect(0, 0, W, H);
    delete f.layers[n];
    rt.dirty.add(f.id + ':' + n);
    pushUndo(f.id + ':' + n, before, '');
  }
  paint(); drawThumb(f); scheduleSave();
}

function clearLayer() {
  const f = F(); if (!f) return;
  const n = S.layer;
  const cv = getCv(f, n, false);
  const before = cv ? cv.toDataURL('image/png') : (f.layers[n] || '');
  if (!before) return;
  if (cv) cv.getContext('2d').clearRect(0, 0, W, H);
  delete f.layers[n];
  rt.dirty.add(f.id + ':' + n);
  pushUndo(f.id + ':' + n, before, '');
  paint(); drawThumb(f); scheduleSave();
}

async function mergeDown() { // fill -> reference (fill merges down)
  const f = F(); await hydrate(f);
  const src = getCv(f, 'fill', false);
  if (!src) return;
  const dst = getCv(f, 'reference', true);
  const beforeRef = dst.toDataURL('image/png'), beforeFill = src.toDataURL('image/png');
  dst.getContext('2d').drawImage(src, 0, 0);
  src.getContext('2d').clearRect(0, 0, W, H);
  rt.dirty.add(f.id + ':reference'); rt.dirty.add(f.id + ':fill');
  pushUndo(f.id + ':reference', beforeRef, dst.toDataURL('image/png'));
  pushUndo(f.id + ':fill', beforeFill, '');
  rt.snap.delete(f.id + ':fill'); rt.snap.set(f.id + ':reference', dst.toDataURL('image/png'));
  paint(); drawThumb(f); scheduleSave();
}

async function mergeUp() { // reference -> fill
  const f = F(); await hydrate(f);
  const src = getCv(f, 'reference', false);
  if (!src) return;
  const dst = getCv(f, 'fill', true);
  const beforeRef = src.toDataURL('image/png'), beforeFill = dst.toDataURL('image/png');
  dst.getContext('2d').drawImage(src, 0, 0);
  src.getContext('2d').clearRect(0, 0, W, H);
  rt.dirty.add(f.id + ':reference'); rt.dirty.add(f.id + ':fill');
  pushUndo(f.id + ':reference', beforeRef, '');
  pushUndo(f.id + ':fill', beforeFill, dst.toDataURL('image/png'));
  rt.snap.delete(f.id + ':reference'); rt.snap.set(f.id + ':fill', dst.toDataURL('image/png'));
  paint(); drawThumb(f); scheduleSave();
}

/* ---------------- undo ---------------- */
function pushUndo(key, before, after) {
  rt.undo.push({ key, before: before || '', after: after || '' });
  if (rt.undo.length > 40) rt.undo.shift();
  rt.redo.length = 0;
}
async function restoreKey(key, url) {
  const i = key.indexOf(':');
  const fid = key.slice(0, i), layer = key.slice(i + 1);
  const f = byId(fid); if (!f) return;
  const cv = getCv(f, layer, true);
  await loadInto(cv, url);
  if (url) f.layers[layer] = url; else delete f.layers[layer];
  rt.hydrated.add(key); rt.dirty.add(key); rt.snap.set(key, url || '');
  if (f === F()) paint();
  drawThumb(f); scheduleSave();
}
async function undo() { const e = rt.undo.pop(); if (!e) return; rt.redo.push(e); await restoreKey(e.key, e.before); }
async function redo() { const e = rt.redo.pop(); if (!e) return; rt.undo.push(e); await restoreKey(e.key, e.after); }

/* ---------------- drawing ---------------- */
function toPt(e) {
  const r = view.getBoundingClientRect();
  let p = e.pressure;
  if (e.pointerType === 'pen') { if (!p) p = 0.5; p = clamp(p, 0.06, 1); }
  else p = 0.62;
  return {
    x: clamp((e.clientX - r.left) * (W / r.width), 0, W),
    y: clamp((e.clientY - r.top) * (H / r.height), 0, H),
    p
  };
}
function dot(c, x, y, p) {
  const r = Math.max(0.55, S.size * (0.22 + 0.85 * p)) / 2;
  c.beginPath(); c.arc(x, y, r, 0, 6.2831853); c.fill();
}
function segment(c, a, b) {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const md = Math.max(0.6, S.size * 0.18);
  const n = Math.max(1, Math.ceil(d / md));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    dot(c, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.p + (b.p - a.p) * t);
  }
}
function beforeFor(key, lc) {
  let v = rt.snap.get(key);
  if (v === undefined || v === null) { v = lc.toDataURL('image/png'); rt.snap.set(key, v); }
  return v;
}
function hex2rgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function floodFill(lc, x, y) {
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const img = lc.getImageData(0, 0, W, H), d = img.data;
  const si = (y * W + x) * 4;
  const tr = d[si], tg = d[si + 1], tb = d[si + 2], ta = d[si + 3];
  const rgb = hex2rgb(S.color);
  if (Math.abs(tr - rgb[0]) + Math.abs(tg - rgb[1]) + Math.abs(tb - rgb[2]) < 12 && ta === 255) return;
  const tol = 48, stack = [y * W + x], seen = new Uint8Array(W * H);
  let guard = 0;
  while (stack.length && guard++ < 4e6) {
    const idx = stack.pop();
    if (seen[idx]) continue;
    seen[idx] = 1;
    const p = idx * 4;
    if (Math.abs(d[p] - tr) + Math.abs(d[p + 1] - tg) + Math.abs(d[p + 2] - tb) + Math.abs(d[p + 3] - ta) > tol) continue;
    d[p] = rgb[0]; d[p + 1] = rgb[1]; d[p + 2] = rgb[2]; d[p + 3] = 255;
    const px = idx % W;
    if (px > 0) stack.push(idx - 1);
    if (px < W - 1) stack.push(idx + 1);
    if (idx >= W) stack.push(idx - W);
    if (idx < W * H - W) stack.push(idx + W);
  }
  lc.putImageData(img, 0, 0);
}

const STROKE_OPACITY = 1;
function endStroke() {
  const a = rt.active; if (!a) return;
  rt.active = null;
  const after = a.lc.toDataURL('image/png');
  pushUndo(a.key, a.before, after);
  rt.snap.set(a.key, after);
  rt.dirty.add(a.key);
  paint(); drawThumb(F()); scheduleSave();
  if (a.px > 0) { F().lineMiles = (F().lineMiles || 0) + a.px / 1000; syncLineMiles(); }
}

function setCtxStyle(c) {
  c.globalCompositeOperation = S.tool === 'eraser' ? 'destination-out' : 'source-over';
  c.fillStyle = S.tool === 'eraser' ? '#000' : S.color;
}

view.addEventListener('pointerdown', e => {
  if (!S.project || S.playing || rt.active) return;
  if (e.pointerType === 'pen') rt.lastPen = Date.now();
  if (S.pencilOnly && e.pointerType !== 'pen') { e.preventDefault(); return; }
  if (e.pointerType === 'touch' && Date.now() - rt.lastPen < 1200) { e.preventDefault(); return; }
  const f = F(); if (!f) return;
  const tool = TOOLS.find(t => t.id === S.tool);
  let layer = S.layer;
  if (tool && tool.layer) { layer = tool.layer; S.layer = layer; }
  const lc = getCv(f, layer, true);
  const lctx = lc.getContext('2d');
  const p = toPt(e);
  const key = f.id + ':' + layer;
  const before = beforeFor(key, lc);
  setCtxStyle(lctx);
  try { view.setPointerCapture(e.pointerId); } catch (_) {}
  if (S.bucket) {
    floodFill(lctx, p.x, p.y);
    rt.active = { pid: e.pointerId, lc, lctx, key, before, prev: p, px: 0 };
    endStroke();
  } else {
    dot(lctx, p.x, p.y, p.p);
    rt.active = { pid: e.pointerId, lc, lctx, key, before, prev: p, px: 0 };
    scheduleRender();
  }
  e.preventDefault();
});

view.addEventListener('pointermove', e => {
  const a = rt.active;
  if (!a || e.pointerId !== a.pid) return;
  e.preventDefault();
  let evs = null;
  try { evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null; } catch (_) {}
  if (!evs || !evs.length) evs = [e];
  setCtxStyle(a.lctx);
  for (const ev of evs) {
    const p = toPt(ev);
    a.px += Math.hypot(p.x - a.prev.x, p.y - a.prev.y);
    segment(a.lctx, a.prev, p);
    a.prev = p;
  }
  scheduleRender();
});

['pointerup', 'pointercancel'].forEach(ev =>
  view.addEventListener(ev, e => {
    if (!rt.active || e.pointerId !== rt.active.pid) return;
    endStroke(); e.preventDefault();
  })
);

/* ---------------- persistence ---------------- */
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open('sb-ipad', 1);
    r.onupgradeneeded = () => { try { r.result.createObjectStore('kv'); } catch (_) {} };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function dbGet(k) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('kv', 'readonly').objectStore('kv').get(k);
    t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error);
  });
}
async function dbPut(k, v) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(v, k);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
function serialize() {
  const p = { title: S.project.title, fps: S.project.fps, idx: S.idx, updatedAt: Date.now(), frames: [] };
  S.project.frames.forEach(f => {
    stashFrame(f);
    p.frames.push({
      id: f.id, shot: f.shot, newShot: !!f.newShot, durationMs: f.durationMs,
      dialogue: f.dialogue || '', action: f.action || '', notes: f.notes || '',
      lineMiles: f.lineMiles || 0, layers: Object.assign({}, f.layers)
    });
  });
  rt.dirty.clear();
  return p;
}
function scheduleSave() { clearTimeout(rt.saveT); rt.saveT = setTimeout(saveNow, 700); }
async function saveNow() {
  if (!S.project) return;
  try { await dbPut('project', serialize()); } catch (_) {}
}

/* ---------------- export ---------------- */
function pad(n) { return String(n).padStart(2, '0'); }
function safeName() { return (S.project.title || 'storyboard').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40); }
function b64ToBytes(b64) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function concat(chunks) {
  let n = 0; for (const c of chunks) n += c.length;
  const out = new Uint8Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function buildPDF(pages) {
  const enc = new TextEncoder();
  const n = pages.length, objs = [], offsets = [];
  const pageIds = [], contIds = [], imgIds = [];
  let next = 3;
  for (let i = 0; i < n; i++) { pageIds.push(next++); contIds.push(next++); imgIds.push(next++); }
  const total = next;
  objs[1] = enc.encode('<< /Type /Catalog /Pages 2 0 R >>');
  objs[2] = enc.encode('<< /Type /Pages /Count ' + n + ' /Kids [' + pageIds.map(x => x + ' 0 R').join(' ') + '] >>');
  for (let i = 0; i < n; i++) {
    const p = pages[i];
    objs[pageIds[i]] = enc.encode('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + p.pw + ' ' + p.ph +
      '] /Resources << /XObject << /Im0 ' + imgIds[i] + ' 0 R >> >> /Contents ' + contIds[i] + ' 0 R >>');
    const cs = 'q ' + p.pw + ' 0 0 ' + p.ph + ' 0 0 cm /Im0 Do Q';
    objs[contIds[i]] = enc.encode('<< /Length ' + cs.length + ' >>\nstream\n' + cs + '\nendstream');
    objs[imgIds[i]] = concat([
      enc.encode('<< /Type /XObject /Subtype /Image /Width ' + p.w + ' /Height ' + p.h +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.jpeg.length + ' >>\nstream\n'),
      p.jpeg, enc.encode('\nendstream')
    ]);
  }
  const out = []; let pos = 0;
  const w = b => { out.push(b); pos += b.length; };
  const ws = s => w(enc.encode(s));
  ws('%PDF-1.4\n');
  for (let i = 1; i < total; i++) {
    offsets[i] = pos;
    ws(i + ' 0 obj\n'); w(objs[i]); ws('\nendobj\n');
  }
  const xref = pos;
  ws('xref\n0 ' + total + '\n0000000000 65535 f \n');
  for (let i = 1; i < total; i++) ws(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  ws('trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF');
  return concat(out);
}

const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(entries) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const dt = new Date();
  const time = (dt.getHours() << 11) | (dt.getMinutes() << 5) | (dt.getSeconds() >> 1);
  const date = ((dt.getFullYear() - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate();
  for (const e of entries) {
    const name = enc.encode(e.name), crc = crc32(e.data);
    const lh = new Uint8Array(30 + name.length), v = new DataView(lh.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true);
    v.setUint16(8, 0, true); v.setUint16(10, time, true); v.setUint16(12, date, true);
    v.setUint32(14, crc, true); v.setUint32(18, e.data.length, true); v.setUint32(22, e.data.length, true);
    v.setUint16(26, name.length, true); v.setUint16(28, 0, true);
    lh.set(name, 30);
    parts.push(lh, e.data);
    const ch = new Uint8Array(46 + name.length), cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, time, true); cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, e.data.length, true); cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
    ch.set(name, 46);
    central.push(ch);
    offset += lh.length + e.data.length;
  }
  let cdSize = 0; central.forEach(c => cdSize += c.length);
  const eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
  return concat([...parts, ...central, eocd]);
}

function canShareFiles() {
  return !!(window.isSecureContext && navigator.canShare && navigator.share);
}
async function deliver(files) {
  const arr = Array.isArray(files) ? files : [files];
  try {
    if (canShareFiles() && navigator.canShare({ files: arr })) {
      const r = await Promise.race([
        navigator.share({ files: arr, title: arr.length > 1 ? safeName() : arr[0].name }).then(() => 'ok').catch(e => (e && e.name === 'AbortError') ? 'ok' : 'no'),
        new Promise(res => setTimeout(() => res('timeout'), 6000))
      ]);
      if (r === 'ok') return;
    }
  } catch (_) {}
  for (const f of arr) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    await new Promise(r => setTimeout(r, 350));
  }
}

async function compositeFrame(f) {
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.globalAlpha = 1; tctx.globalCompositeOperation = 'source-over';
  tctx.fillStyle = '#fff'; tctx.fillRect(0, 0, W, H);
  for (const n of LAYERS) {
    const cv = getCv(f, n, false);
    if (cv) { tctx.drawImage(cv, 0, 0); continue; }
    const url = f.layers[n];
    if (!url) continue;
    const im = await loadImg(url);
    if (im) tctx.drawImage(im, 0, 0);
  }
  if (S.captions && f.dialogue) drawCaption(tctx, f.dialogue, 1);
  return tmp;
}

async function exportPDF() {
  try {
    const pages = [];
    for (const f of S.project.frames) {
      await compositeFrame(f);
      const url = tmp.toDataURL('image/jpeg', 0.9);
      pages.push({ jpeg: b64ToBytes(url.split(',')[1]), w: W, h: H, pw: W, ph: H });
    }
    await saveNow();
    await deliver(new File([buildPDF(pages)], safeName() + '.pdf', { type: 'application/pdf' }));
  } catch (e) { alert('PDF 导出失败: ' + e.message); }
}
async function exportPNG() {
  try {
    const entries = [];
    for (let i = 0; i < S.project.frames.length; i++) {
      await compositeFrame(S.project.frames[i]);
      entries.push({
        name: safeName() + '-' + pad(i + 1) + '.png',
        data: b64ToBytes(tmp.toDataURL('image/png').split(',')[1])
      });
    }
    if (canShareFiles()) {
      await deliver(entries.map(e => new File([e.data], e.name, { type: 'image/png' })));
    } else {
      await deliver(new File([zipStore(entries)], safeName() + '-png.zip', { type: 'application/zip' }));
    }
  } catch (e) { alert('PNG 导出失败: ' + e.message); }
}
async function exportJSON() {
  const p = serialize();
  await dbPut('project', p);
  const blob = new Blob([JSON.stringify(p)], { type: 'application/json' });
  await deliver(new File([blob], safeName() + '.json', { type: 'application/json' }));
}
async function importJSON(file) {
  const text = await file.text();
  const p = JSON.parse(text);
  if (!p || !Array.isArray(p.frames)) throw new Error('文件格式不对');
  applyProject(p);
  await select(0);
  await dbPut('project', serialize());
}

/* ---------------- ui sync ---------------- */
function fmt(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function totalMs() { return S.project.frames.reduce((a, f) => a + (f.durationMs || 2000), 0); }
function startMs(i) {
  let t = 0;
  for (let k = 0; k < i; k++) t += S.project.frames[k].durationMs || 2000;
  return t;
}
function syncLineMiles() {
  const f = F(); if (!f) return;
  $('#lineMiles').textContent = (f.lineMiles || 0).toFixed(1);
}
function syncMeta() {
  const f = F(); if (!f) return;
  $('#shotName').value = f.shot || '';
  $('#boardCounter').textContent = 'Board: ' + (S.idx + 1) + ' of ' + S.project.frames.length;
  $('#lineMiles').textContent = (f.lineMiles || 0).toFixed(1);
  $('#newShot').checked = !!f.newShot;
  $('#durMs').value = f.durationMs;
  $('#durFrames').value = Math.round(f.durationMs / 1000 * S.project.fps);
  $('#dialogue').value = f.dialogue || '';
  $('#action').value = f.action || '';
  $('#notes').value = f.notes || '';
  $('#layerName').textContent = LAYER_LABEL[S.layer] || S.layer;
  $('#fps').value = String(S.project.fps);
  $('#projName').value = S.project.title || '';
  $('#statFps').textContent = S.project.fps + ' FPS';
}
function shotsCount() {
  return S.project.frames.filter(f => f.newShot || S.project.frames.indexOf(f) === 0).length;
}
function syncTransport() {
  $('#statTime').textContent = fmt(startMs(S.idx));
  $('#statTotal').textContent = fmt(totalMs());
  $('#statInfo').textContent = 'BOARD ' + (S.idx + 1) + ' OF ' + S.project.frames.length + ' · ' + shotsCount() + ' SHOT' + (shotsCount() === 1 ? '' : 'S');
  savePrefs();
}
function syncSeek() {
  const t = totalMs();
  const pos = startMs(S.idx);
  $('#seekFill').style.width = (t ? (pos / t) * 100 : 0) + '%';
}

/* ---------------- tools / colors ---------------- */
function buildTools() {
  const box = $('#tools');
  box.innerHTML = '';
  TOOLS.forEach(t => {
    const b = document.createElement('button');
    b.className = 'tool'; b.dataset.tool = t.id;
    b.innerHTML = '<img src="' + t.img + '" alt=""><span>' + t.label + '</span>';
    b.addEventListener('click', () => setTool(t.id));
    box.appendChild(b);
  });
}
function setTool(id) {
  S.tool = id;
  const t = TOOLS.find(x => x.id === id);
  if (t && t.layer) S.layer = t.layer;
  S.bucket = false;
  const bb = $('[data-act="bucket"]'); if (bb) bb.classList.remove('on');
  $$('.tool').forEach(b => b.classList.toggle('sel', b.dataset.tool === id));
  $('#layerName').textContent = LAYER_LABEL[S.layer] || S.layer;
  savePrefs();
}
function setColor(c) {
  S.color = c;
  $('#curColorBtn').style.background = c;
  $('#color').value = /^#[0-9a-f]{6}$/i.test(c) ? c : '#111111';
  $$('#palette button').forEach(b => b.classList.toggle('sel', b.dataset.c === c));
  savePrefs();
}
function buildPalette() {
  const box = $('#palette');
  box.innerHTML = '';
  PALETTE.forEach(c => {
    const b = document.createElement('button');
    b.style.background = c; b.dataset.c = c;
    b.addEventListener('click', () => setColor(c));
    box.appendChild(b);
  });
  setColor(S.color);
}
function setGuide(name) {
  S.guides[name] = !S.guides[name];
  const b = $('[data-guide="' + name + '"]');
  if (b) b.classList.toggle('on', S.guides[name]);
  paint(); savePrefs();
}

/* ---------------- playback ---------------- */
function togglePlay() { S.playing ? stopPlay() : startPlay(); }
function startPlay() {
  if (!S.project.frames.length) return;
  S.playing = true;
  setPlayIcon(true);
  const run = () => {
    if (!S.playing) return;
    const f = F();
    const dur = clamp(f.durationMs || 2000, 150, 60000);
    rt.playT = setTimeout(async () => {
      if (!S.playing) return;
      const next = S.idx + 1;
      if (next >= S.project.frames.length) { stopPlay(); return; }
      await select(next, { play: true });
      run();
    }, dur);
  };
  run();
}
function stopPlay() {
  S.playing = false;
  clearTimeout(rt.playT);
  setPlayIcon(false);
  paint();
}
function setPlayIcon(playing) {
  $('#playBtn').innerHTML = playing
    ? '<svg viewBox="0 0 24 18"><rect x="4" y="2" width="5" height="14"/><rect x="15" y="2" width="5" height="14"/></svg>'
    : '<svg viewBox="0 0 24 18"><path d="M3 1.5 21 9 3 16.5z"/></svg>';
}

/* ---------------- fit ---------------- */
function fit() {
  const pane = $('#sketch-pane');
  const r = pane.getBoundingClientRect();
  const aw = r.width - 24, ah = r.height - 24;
  if (aw <= 0 || ah <= 0) return;
  let w = aw, h = aw * H / W;
  if (h > ah) { h = ah; w = ah * W / H; }
  view.style.width = Math.round(w) + 'px';
  view.style.height = Math.round(h) + 'px';
}

/* ---------------- prefs ---------------- */
function savePrefs() {
  try {
    localStorage.setItem('sb-prefs', JSON.stringify({
      tool: S.tool, layer: S.layer, color: S.color, size: S.size,
      onion: S.onion, captions: S.captions, pencilOnly: S.pencilOnly, guides: S.guides
    }));
  } catch (_) {}
}
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('sb-prefs') || '{}');
    if (p.color) S.color = p.color;
    if (p.size) S.size = p.size;
    if (p.tool) S.tool = p.tool;
    if (p.layer) S.layer = p.layer;
    if (typeof p.onion === 'boolean') S.onion = p.onion;
    if (typeof p.captions === 'boolean') S.captions = p.captions;
    if (typeof p.pencilOnly === 'boolean') S.pencilOnly = p.pencilOnly;
    if (p.guides) S.guides = p.guides;
  } catch (_) {}
  $('#size').value = S.size;
  $('#pencilOnly').checked = S.pencilOnly;
  $('#onionBtn').classList.toggle('on', S.onion);
  $('#captionBtn').classList.toggle('on', S.captions);
  Object.keys(S.guides).forEach(g => {
    const b = $('[data-guide="' + g + '"]');
    if (b) b.classList.toggle('on', S.guides[g]);
  });
}

/* ---------------- bind ---------------- */
function bind() {
  $('#curColorBtn').addEventListener('click', () => $('#color').click());
  $('#color').addEventListener('input', e => setColor(e.target.value));
  $('#size').addEventListener('input', e => { S.size = +e.target.value; savePrefs(); });

  $$('[data-act]').forEach(b => b.addEventListener('click', async () => {
    const a = b.dataset.act;
    if (a === 'bucket') { S.bucket = !S.bucket; b.classList.toggle('on', S.bucket); if (S.bucket) return; }
    if (a === 'trash') { clearFrame(); return; }
    if (a === 'undo') { await undo(); return; }
    if (a === 'redo') { await redo(); return; }
    if (a === 'play') { togglePlay(); return; }
    if (a === 'prev') { if (!S.playing) select(S.idx - 1); return; }
    if (a === 'next') { if (!S.playing) select(S.idx + 1); return; }
  }));
  $$('[data-guide]').forEach(b => b.addEventListener('click', () => setGuide(b.dataset.guide)));
  $('#onionBtn').addEventListener('click', () => { S.onion = !S.onion; $('#onionBtn').classList.toggle('on', S.onion); paint(); savePrefs(); });
  $('#captionBtn').addEventListener('click', () => { S.captions = !S.captions; $('#captionBtn').classList.toggle('on', S.captions); paint(); savePrefs(); });

  $('#addFrame').addEventListener('click', addFrame);
  $('#shotName').addEventListener('input', e => {
    const f = F(); if (!f) return;
    f.shot = e.target.value;
    highlightStrip(); scheduleSave();
  });
  $('#newShot').addEventListener('change', e => {
    const f = F(); f.newShot = e.target.checked;
    highlightStrip(); scheduleSave();
  });
  $('#durMs').addEventListener('input', e => {
    const f = F(); const v = clamp(+e.target.value || 0, 0, 600000);
    if (!v) return;
    f.durationMs = v;
    $('#durFrames').value = Math.round(v / 1000 * S.project.fps);
    syncTransport(); syncSeek();
    scheduleSave();
  });
  $('#durFrames').addEventListener('input', e => {
    const f = F(); const v = clamp(+e.target.value || 0, 1, 100000);
    f.durationMs = Math.round(v / S.project.fps * 1000);
    $('#durMs').value = f.durationMs;
    syncTransport(); syncSeek();
    scheduleSave();
  });
  [['#dialogue', 'dialogue'], ['#action', 'action'], ['#notes', 'notes']].forEach(([sel, key]) => {
    $(sel).addEventListener('input', e => {
      const f = F(); if (!f) return;
      f[key] = e.target.value;
      if (key === 'dialogue' && S.captions) paint();
      scheduleSave();
    });
  });
  $('#projName').addEventListener('input', e => {
    S.project.title = e.target.value;
    scheduleSave();
  });
  $('#fps').addEventListener('change', e => {
    S.project.fps = clamp(+e.target.value || 12, 1, 60);
    const f = F();
    $('#durFrames').value = Math.round((f.durationMs || 2000) / 1000 * S.project.fps);
    syncTransport(); syncSeek(); scheduleSave();
  });
  $('#clearNotesBtn').addEventListener('click', () => {
    const f = F(); const cv = getCv(f, 'notes', false);
    const before = cv ? cv.toDataURL('image/png') : (f.layers.notes || '');
    if (!before) return;
    if (cv) cv.getContext('2d').clearRect(0, 0, W, H);
    delete f.layers.notes;
    rt.dirty.add(f.id + ':notes');
    pushUndo(f.id + ':notes', before, '');
    paint(); drawThumb(f); scheduleSave();
  });
  $('#clearLayerBtn').addEventListener('click', clearLayer);
  $('#mergeDownBtn').addEventListener('click', mergeDown);
  $('#mergeUpBtn').addEventListener('click', mergeUp);

  $('#menuBtn').addEventListener('click', e => {
    e.stopPropagation();
    if (matchMedia('(orientation:portrait)').matches) {
      const open = $('#app').classList.toggle('sidebar-open');
      $('#scrim').classList.toggle('show', open);
    } else {
      $('#menu-pop').classList.toggle('hidden');
    }
  });
  $('#scrim').addEventListener('click', () => { $('#app').classList.remove('sidebar-open'); $('#scrim').classList.remove('show'); });
  document.addEventListener('click', e => {
    if (!e.target.closest('#menu-pop') && !e.target.closest('#menuBtn')) $('#menu-pop').classList.add('hidden');
  });
  $$('#menu-pop button[data-m]').forEach(b => b.addEventListener('click', async () => {
    $('#menu-pop').classList.add('hidden');
    const m = b.dataset.m;
    if (m === 'new') {
      if (!confirm('新建项目？当前项目会被覆盖（先导出 JSON 备份）')) return;
      applyProject(freshProject()); await select(0); await dbPut('project', serialize());
    }
    if (m === 'import') $('#fileInput').click();
    if (m === 'dup') dupFrame();
    if (m === 'del') { if (confirm('删除当前画板？')) delFrame(); }
    if (m === 'pdf') exportPDF();
    if (m === 'png') exportPNG();
    if (m === 'json') exportJSON();
  }));
  $('#fileInput').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try { await importJSON(file); } catch (err) { alert('导入失败: ' + err.message); }
    e.target.value = '';
  });
  $('#pencilOnly').addEventListener('change', e => { S.pencilOnly = e.target.checked; savePrefs(); });

  $('#seek').addEventListener('pointerdown', e => {
    const r = $('#seek').getBoundingClientRect();
    const frac = clamp((e.clientX - r.left) / r.width, 0, 0.999);
    const t = frac * totalMs();
    let acc = 0, target = 0;
    for (let i = 0; i < S.project.frames.length; i++) {
      acc += S.project.frames[i].durationMs || 2000;
      if (t < acc) { target = i; break; }
      target = i;
    }
    if (!S.playing) select(target);
  });

  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', () => setTimeout(() => { fit(); if (!matchMedia('(orientation:portrait)').matches) { $('#app').classList.remove('sidebar-open'); $('#scrim').classList.remove('show'); } }, 260));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => setTimeout(fit, 60));
  document.addEventListener('gesturestart', e => e.preventDefault());
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

  document.addEventListener('keydown', e => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const k = e.key;
    if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (k === '1') setTool('light');
    if (k === '2') setTool('fillbrush');
    if (k === '3') setTool('tone');
    if (k === '4') setTool('pencil');
    if (k === '5') setTool('ink');
    if (k === '6') setTool('note');
    if (k === '7') setTool('eraser');
    if (k === 'o') { S.onion = !S.onion; $('#onionBtn').classList.toggle('on', S.onion); paint(); }
    if (k === 'g') setGuide('grid');
    if (k === '[') { S.size = clamp(S.size - 1, 1, 60); $('#size').value = S.size; savePrefs(); }
    if (k === ']') { S.size = clamp(S.size + 1, 1, 60); $('#size').value = S.size; savePrefs(); }
    if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); clearFrame(); }
    if (k === 'ArrowLeft') select(S.idx - 1);
    if (k === 'ArrowRight') select(S.idx + 1);
    if (k === ' ') { e.preventDefault(); togglePlay(); }
  });
}

/* ---------------- boot ---------------- */
async function boot() {
  buildTools();
  buildPalette();
  bind();
  loadPrefs();
  setTool(S.tool);
  setColor(S.color);
  $('#size').value = S.size;
  setPlayIcon(false);

  let saved = null;
  try { saved = await dbGet('project'); } catch (_) {}
  applyProject(saved || freshProject());
  fit();
  await select(saved ? clamp(+(saved.idx || 0), 0, S.project.frames.length - 1) : 0);
  syncSeek();
  setTimeout(fit, 120);
  setTimeout(fit, 400);

  if (window.visualViewport) {
    const vv = window.visualViewport;
    vv.addEventListener('resize', () => setTimeout(fit, 60));
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  rt.booted = true;
}
document.addEventListener('DOMContentLoaded', boot);
})();
