// ─────────── ClimbCrop main app ───────────
import { initI18n, t } from './i18n.js?v=2';
import { Tracker, buildPath, seekTo, smoothstep, lerpBox, BONES, trackSubject } from './tracker.js?v=2';
import { exportVideo } from './exporter.js?v=2';

const $ = s => document.querySelector(s);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt = s => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

const ASPECTS = {
  '916': { w: 9, h: 16, out: [1080, 1920] },
  '54':  { w: 4, h: 5,  out: [1080, 1350] }, // "5:4" preset — portrait 1080×1350
  '11':  { w: 1, h: 1,  out: [1080, 1080] },
};
const ANALYZE_FPS = 8;

// Difficulty tape/hold colours in the common Korean-gym order (easy → hard).
const GRADES = [
  { key: 'white',  color: '#f8fafc' }, { key: 'yellow', color: '#facc15' },
  { key: 'orange', color: '#f97316' }, { key: 'green',  color: '#22c55e' },
  { key: 'blue',   color: '#3b82f6' }, { key: 'red',    color: '#ef4444' },
  { key: 'purple', color: '#a855f7' }, { key: 'gray',   color: '#9ca3af' },
  { key: 'brown',  color: '#92400e' }, { key: 'black',  color: '#111827' },
  { key: 'pink',   color: '#f9a8d4' }, { key: 'navy',   color: '#1e3a8a' },
];
// Gym logos bundled under public/images/. Add a file there + a line here to offer more.
const GYMS = [
  { name: 'Awake Climbing', src: 'public/images/awake.jpg' },
  { name: 'The Climb', src: 'public/images/theclimb.jpg' },
];

const state = {
  fileUrl: null, dur: 0, vw: 0, vh: 0,
  trimStart: 0, trimEnd: 0, climbStart: 0, zoomDur: 2.5,
  arKey: '54', zoom: 0.55, smooth: 0.6, skel: 'off',
  segments: [],           // {start, end, speed}
  boxKeys: [],            // {t, cx, cy} manual crop-box positions (keyframes, normalized centre)
  frames: null,           // cached per-frame detections from the scan
  samples: null, path: null,
  view: 'full', playing: false, analyzed: false,
  result: null,
  quality: 'accurate',    // pose model tier: fast | balanced | accurate
  watermark: { difficulty: null, gym: null }, // logo always on; gym: {type:'image',img,name}
};

// ─────────── Video element + audio graph ───────────
const video = document.createElement('video');
video.playsInline = true;
video.preload = 'auto';
video.crossOrigin = 'anonymous';

let actx = null, monitorGain = null, recordDest = null;
function ensureAudioGraph() {
  if (actx) { actx.resume(); return; }
  actx = new (window.AudioContext || window.webkitAudioContext)();
  const src = actx.createMediaElementSource(video);
  monitorGain = actx.createGain();
  src.connect(monitorGain).connect(actx.destination);
  recordDest = actx.createMediaStreamDestination();
  src.connect(recordDest);
}

// ─────────── DOM refs ───────────
const cv = $('#preview'), ctx = cv.getContext('2d');
const tl = $('#timeline'), tlStrip = $('#tlStrip');
const modal = $('#modal'), progressFill = $('#progressFill'), progressPct = $('#progressPct');

const tracker = new Tracker();
let abortCtl = null;

// ─────────── Screens ───────────
function showScreen(name) {
  for (const id of ['upload', 'editor', 'result']) $(`#screen-${id}`).classList.toggle('hidden', id !== name);
}

// ─────────── Crop math ───────────
const arVal = () => ASPECTS[state.arKey].w / ASPECTS[state.arKey].h;

function fullViewBox() {
  const ar = arVal();
  let h = state.vh, w = h * ar;
  if (w > state.vw) { w = state.vw; h = w / ar; }
  return { x: (state.vw - w) / 2, y: (state.vh - h) / 2, w, h };
}

function rebuildPath() {
  if (!state.samples) { state.path = null; return; }
  state.path = buildPath(state.samples, {
    vw: state.vw, vh: state.vh, ar: arVal(),
    zoom: state.zoom, smooth: state.smooth, fps: state.sampleFps || ANALYZE_FPS,
  });
}

// Manual box keyframes: each is an absolute crop centre {t, cx, cy} the user placed by dragging
// the crop box. Returns the interpolated manual centre + a weight (1 at/between keys, fading to 0
// away from them so auto-tracking takes back over). null when there are no keyframes.
function manualCenter(tSec) {
  const K = state.boxKeys;
  if (!K.length) return null;
  const W = 1.5;
  let left = null, right = null;
  for (const k of K) {
    if (k.t <= tSec && (!left || k.t > left.t)) left = k;
    if (k.t > tSec && (!right || k.t < right.t)) right = k;
  }
  if (left && right && right.t - left.t <= 2 * W) {       // sustained region between two keys
    const f = (tSec - left.t) / (right.t - left.t);
    return { cx: left.cx + (right.cx - left.cx) * f, cy: left.cy + (right.cy - left.cy) * f, w: 1 };
  }
  const near = left && right ? (tSec - left.t < right.t - tSec ? left : right) : (left || right);
  let w = Math.max(0, 1 - Math.abs(near.t - tSec) / W);
  w = w * w * (3 - 2 * w);                                 // smoothstep falloff
  return { cx: near.cx, cy: near.cy, w };
}

function cropAt(tSec) {
  const full = state.path ? state.path.full : fullViewBox();
  if (!state.path) {
    // pre-analysis preview of the crop size, centred on a manual box key or the frame centre
    const h = full.h * state.zoom, w = h * arVal();
    const m = manualCenter(tSec);
    const cx = (m ? m.cx : 0.5) * state.vw;
    const cy = (m ? m.cy : 0.5) * state.vh;
    return { x: clamp(cx - w / 2, 0, state.vw - w), y: clamp(cy - h / 2, 0, state.vh - h), w, h };
  }
  // Auto framing (full view before the climb, then an ease-in zoom to the tracked box).
  let autoBox;
  if (tSec <= state.climbStart) {
    autoBox = full;
  } else {
    const [cx, cy] = state.path.centerNormAt(tSec);
    const tracked = state.path.boxAtCenter(cx, cy);
    if (tSec < state.climbStart + state.zoomDur) {
      const f = smoothstep((tSec - state.climbStart) / state.zoomDur);
      autoBox = lerpBox(full, tracked, f);
    } else autoBox = tracked;
  }
  // A manual box keyframe overrides the auto framing (even during the intro), blended by weight.
  const m = manualCenter(tSec);
  if (!m) return autoBox;
  return lerpBox(autoBox, state.path.boxAtCenter(m.cx, m.cy), m.w);
}

function speedAt(tSec) {
  const g = state.segments.find(g => tSec >= g.start && tSec < g.end);
  return g ? g.speed : 1;
}

function skeletonAlpha(tSec) {
  if (state.skel === 'off' || !state.path) return 0;
  if (state.skel === 'always') return 0.55;
  const end = state.climbStart + state.zoomDur;
  if (tSec >= end) return 0;
  if (tSec <= state.climbStart) return 0.6;
  return 0.6 * (1 - smoothstep((tSec - state.climbStart) / state.zoomDur));
}

// ─────────── Rendering ───────────
function drawSkeleton(c, tSec, mapX, mapY, scale) {
  const alpha = skeletonAlpha(tSec);
  if (!alpha) return;
  const lms = state.path.lmsAt(tSec);
  if (!lms) return;                 // click-track has no landmarks
  c.save();
  c.globalAlpha = alpha;
  c.lineWidth = Math.max(2, 3 * scale);
  c.lineCap = 'round';
  c.strokeStyle = '#34d399';
  c.beginPath();
  for (const [a, b] of BONES) {
    if (lms[a][2] < 0.35 || lms[b][2] < 0.35) continue;
    c.moveTo(mapX(lms[a][0]), mapY(lms[a][1]));
    c.lineTo(mapX(lms[b][0]), mapY(lms[b][1]));
  }
  c.stroke();
  c.fillStyle = '#a7f3d0';
  for (const p of lms) {
    if (p[2] < 0.35) continue;
    c.beginPath();
    c.arc(mapX(p[0]), mapY(p[1]), Math.max(2, 2.5 * scale), 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
}

// Debug overlay: draw EVERY detected pose (gray) so you can see whether MediaPipe found the
// climber and which pose the tracker locked onto (the bright green one drawn on top).
function drawAllSkeletons(c, tSec, mapX, mapY, scale) {
  if (state.skel === 'off' || !state.path || !state.path.allAt) return;
  const all = state.path.allAt(tSec);
  if (all.length <= 1) return;
  c.save();
  c.globalAlpha = 0.4;
  c.lineWidth = Math.max(1, 1.5 * scale);
  c.strokeStyle = '#f8fafc';
  for (const lms of all) {
    c.beginPath();
    for (const [a, b] of BONES) {
      if (lms[a][2] < 0.3 || lms[b][2] < 0.3) continue;
      c.moveTo(mapX(lms[a][0]), mapY(lms[a][1]));
      c.lineTo(mapX(lms[b][0]), mapY(lms[b][1]));
    }
    c.stroke();
  }
  c.restore();
}

function renderFrame(c, cw, ch, tSec, forExport = false) {
  const cropMode = forExport || (state.view === 'crop' && state.analyzed);
  if (cropMode) {
    const box = cropAt(tSec);
    c.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, cw, ch);
    const sX = cw / box.w;
    const mx = nx => (nx * state.vw - box.x) * sX;
    const my = ny => (ny * state.vh - box.y) * (ch / box.h);
    drawAllSkeletons(c, tSec, mx, my, sX * (state.vw / 1000));
    drawSkeleton(c, tSec, mx, my, sX * (state.vw / 1000));
    drawWatermark(c, cw, ch);
  } else {
    c.drawImage(video, 0, 0, cw, ch);
    const sx = cw / state.vw, sy = ch / state.vh;
    const box = cropAt(tSec);
    c.save();
    c.fillStyle = 'rgba(0,0,0,.45)';
    c.beginPath();
    c.rect(0, 0, cw, ch);
    c.rect(box.x * sx, box.y * sy, box.w * sx, box.h * sy);
    c.fill('evenodd');
    c.strokeStyle = 'rgba(52,211,153,.95)';
    c.lineWidth = 2;
    c.strokeRect(box.x * sx, box.y * sy, box.w * sx, box.h * sy);
    c.restore();
    if (state.path) {
      drawAllSkeletons(c, tSec, nx => nx * cw, ny => ny * ch, sx * (state.vw / 1000));
      drawSkeleton(c, tSec, nx => nx * cw, ny => ny * ch, sx * (state.vw / 1000));
    }
  }
}

// Rounded rect helper.
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// Bottom-right branding overlay: [gym logo] [difficulty dot] [ClimbCrop wordmark].
// Sizes are relative to the canvas height, so it scales across preview and 1080p export.
function drawWatermark(c, cw, ch) {
  const wm = state.watermark;
  const pad = Math.round(ch * 0.03);
  const h = Math.max(18, Math.round(ch * 0.052));
  const gap = Math.round(h * 0.34);
  const yMid = ch - pad - h / 2;
  let x = cw - pad;
  c.save();
  c.textBaseline = 'middle';
  c.shadowColor = 'rgba(0,0,0,.5)';
  c.shadowBlur = h * 0.18;

  // ClimbCrop wordmark — mandatory. "Climb" white, "Crop" green, no emoji.
  {
    const fs = Math.round(h * 0.62);
    c.font = `800 ${fs}px "Pretendard Variable", system-ui, sans-serif`;
    const climbW = c.measureText('Climb').width;
    const cropW = c.measureText('Crop').width;
    const boxW = h * 0.34 + climbW + cropW + h * 0.34;
    c.fillStyle = 'rgba(12,20,15,.5)';
    roundRect(c, x - boxW, yMid - h / 2, boxW, h, h / 2); c.fill();
    c.shadowBlur = 0;
    c.textAlign = 'left';
    let tx = x - boxW + h * 0.34;
    c.fillStyle = '#fff'; c.fillText('Climb', tx, yMid); tx += climbW;
    c.fillStyle = '#34d399'; c.fillText('Crop', tx, yMid);
    x -= boxW + gap;
    c.shadowColor = 'rgba(0,0,0,.5)'; c.shadowBlur = h * 0.18;
  }

  if (wm.difficulty) {
    const r = h * 0.44;
    c.beginPath(); c.arc(x - r, yMid, r, 0, Math.PI * 2);
    c.fillStyle = wm.difficulty; c.fill();
    c.shadowBlur = 0;
    c.lineWidth = Math.max(1.5, r * 0.16); c.strokeStyle = 'rgba(255,255,255,.9)'; c.stroke();
    x -= r * 2 + gap;
    c.shadowColor = 'rgba(0,0,0,.5)'; c.shadowBlur = h * 0.18;
  }

  if (wm.gym && wm.gym.type === 'image' && wm.gym.img && wm.gym.img.complete) {
    // Circular badge: clip square-ish logos to a circle (removes the opaque corners of a
    // JPG, and respects the alpha of a transparent PNG — no background box is added).
    const img = wm.gym.img;
    const d = h, cxp = x - d / 2, cyp = yMid;
    c.save();
    c.beginPath(); c.arc(cxp, cyp, d / 2, 0, Math.PI * 2); c.clip();
    const ratio = img.naturalWidth / (img.naturalHeight || 1);
    let dw = d, dh = d;
    if (ratio >= 1) dw = d * ratio; else dh = d / ratio;   // cover the disc
    c.drawImage(img, cxp - dw / 2, cyp - dh / 2, dw, dh);
    c.restore();
    x -= d + gap;
  }
  c.restore();
}

function fitPreviewCanvas() {
  let aw, ah;
  if (state.view === 'crop' && state.analyzed) { const a = ASPECTS[state.arKey]; aw = a.w; ah = a.h; }
  else { aw = state.vw || 16; ah = state.vh || 9; }
  const maxH = 720, maxW = 1080;
  let h = maxH, w = h * aw / ah;
  if (w > maxW) { w = maxW; h = w * ah / aw; }
  cv.width = Math.round(w); cv.height = Math.round(h);
  cv.style.aspectRatio = `${aw} / ${ah}`;
}

function drawPreview() {
  if (!state.vw) return;
  renderFrame(ctx, cv.width, cv.height, video.currentTime);
  updatePlayhead();
  $('#timeLabel').textContent = `${fmt(video.currentTime)} / ${fmt(state.dur)}`;
}

// ─────────── Playback ───────────
function play() {
  ensureAudioGraph();
  if (video.currentTime >= state.trimEnd - 0.05 || video.currentTime < state.trimStart) {
    video.currentTime = state.trimStart;
  }
  state.playing = true;
  $('#playBtn').textContent = '⏸';
  video.play();
  const loop = () => {
    if (!state.playing) return;
    if (video.currentTime >= state.trimEnd || video.ended) { pause(); return; }
    video.playbackRate = speedAt(video.currentTime);
    drawPreview();
    video.requestVideoFrameCallback(loop);
  };
  video.requestVideoFrameCallback(loop);
}
function pause() {
  state.playing = false;
  video.pause();
  video.playbackRate = 1;
  $('#playBtn').textContent = '▶';
  drawPreview();
}

// ─────────── Timeline ───────────
function pct(tSec) { return `${(tSec / state.dur) * 100}%`; }
function updatePlayhead() { $('#playhead').style.left = pct(video.currentTime); }

function updateTimelineUI() {
  $('#hStart').style.left = pct(state.trimStart);
  $('#hEnd').style.left = pct(state.trimEnd);
  $('#shadeL').style.width = pct(state.trimStart);
  $('#shadeR').style.width = `${(1 - state.trimEnd / state.dur) * 100}%`;
  $('#trimLabelVal').textContent = `${fmt(state.trimStart)} – ${fmt(state.trimEnd)}`;
  const layer = $('#bandLayer');
  layer.innerHTML = '';
  for (const g of state.segments) {
    const d = document.createElement('div');
    d.className = `tl-band ${g.speed < 1 ? 'slow' : 'fast'}`;
    d.style.left = pct(g.start);
    d.style.width = `${((g.end - g.start) / state.dur) * 100}%`;
    const lb = document.createElement('span');
    lb.className = 'tl-band-label';
    lb.textContent = `${g.speed}×`;
    d.appendChild(lb);
    layer.appendChild(d);
  }
  updatePlayhead();
}

// The intro zoom starts a fixed 1s after the (trimmed) start; keep speed sections in range.
function syncClimbStart() {
  state.climbStart = clamp(state.trimStart + 1, state.trimStart, state.trimEnd);
  for (const g of state.segments) {
    g.start = clamp(g.start, state.trimStart, state.trimEnd);
    g.end = clamp(g.end, state.trimStart, state.trimEnd);
  }
}

// Lightweight live scrub: move the preview to a time without fighting the seeked handler.
let scrubReq = null;
function scrubTo(tSec) {
  if (state.playing) pause();
  scrubReq = clamp(tSec, 0, Math.max(0, state.dur - 0.03));
  if (video.seeking) return;             // coalesce — the seeked handler will pull the latest
  video.currentTime = scrubReq;
}
video.addEventListener('seeked', () => {
  if (scrubReq != null && Math.abs(video.currentTime - scrubReq) > 0.02) {
    const next = scrubReq; scrubReq = null; video.currentTime = next; return;
  }
  scrubReq = null;
  if (!state.playing) drawPreview();
});

let dragRole = null;
tl.addEventListener('pointerdown', e => {
  const h = e.target.closest('.tl-handle,.tl-marker');
  dragRole = h ? h.dataset.role : 'scrub';
  tl.setPointerCapture(e.pointerId);
  onTimelineMove(e);
});
tl.addEventListener('pointermove', e => { if (dragRole) onTimelineMove(e); });
tl.addEventListener('pointerup', () => {
  if (dragRole === 'start' || dragRole === 'end') {
    // drop any section squeezed to nothing by the new trim bounds
    state.segments = state.segments.filter(g => g.end - g.start > 0.05);
    renderSegments();
    updateTimelineUI();
  }
  dragRole = null;
});

function onTimelineMove(e) {
  const r = tl.getBoundingClientRect();
  const tSec = clamp((e.clientX - r.left) / r.width, 0, 1) * state.dur;
  if (dragRole === 'start') {
    state.trimStart = clamp(tSec, 0, state.trimEnd - 0.5);
    syncClimbStart();
    scrubTo(state.trimStart);            // show the new start frame live
  } else if (dragRole === 'end') {
    state.trimEnd = clamp(tSec, state.trimStart + 0.5, state.dur);
    syncClimbStart();
    scrubTo(state.trimEnd);              // show the new end frame live
  } else {
    scrubTo(clamp(tSec, state.trimStart, state.trimEnd));
  }
  updateTimelineUI();
}

async function buildThumbnails() {
  const thumbVid = document.createElement('video');
  thumbVid.muted = true; thumbVid.playsInline = true; thumbVid.preload = 'auto';
  thumbVid.src = state.fileUrl;
  await new Promise(r => thumbVid.addEventListener('loadedmetadata', r, { once: true }));
  const W = tl.clientWidth || 800, H = 64;
  tlStrip.width = W; tlStrip.height = H;
  const c = tlStrip.getContext('2d');
  c.fillStyle = '#0a0e1c'; c.fillRect(0, 0, W, H);
  const n = Math.max(6, Math.floor(W / 90));
  const tw = W / n;
  for (let i = 0; i < n; i++) {
    try {
      await seekTo(thumbVid, (i + 0.5) / n * thumbVid.duration);
      const s = Math.max(tw / thumbVid.videoWidth, H / thumbVid.videoHeight);
      const dw = thumbVid.videoWidth * s, dh = thumbVid.videoHeight * s;
      c.drawImage(thumbVid, i * tw + (tw - dw) / 2, (H - dh) / 2, dw, dh);
    } catch { /* skip thumb */ }
  }
  thumbVid.removeAttribute('src');
  thumbVid.load();
}

// ─────────── Speed segments ───────────
const SPEED_OPTS = [0.25, 0.5, 0.75, 1.5, 2, 3, 4];
function renderSegments() {
  const list = $('#segmentList');
  list.innerHTML = '';
  state.segments.forEach((g, i) => {
    const row = document.createElement('div');
    row.className = 'segment-row';
    row.innerHTML = `
      <input type="number" step="0.1" min="0" value="${g.start.toFixed(1)}" title="${t('speedStart')}">
      <input type="number" step="0.1" min="0" value="${g.end.toFixed(1)}" title="${t('speedEnd')}">
      <select>${SPEED_OPTS.map(s => `<option value="${s}" ${s === g.speed ? 'selected' : ''}>${s}×</option>`).join('')}</select>
      <button class="del" title="delete">✕</button>`;
    const [inS, inE] = row.querySelectorAll('input');
    inS.addEventListener('change', () => { g.start = clamp(parseFloat(inS.value) || 0, 0, g.end - 0.1); syncSegments(); });
    inE.addEventListener('change', () => { g.end = clamp(parseFloat(inE.value) || 0, g.start + 0.1, state.dur); syncSegments(); });
    row.querySelector('select').addEventListener('change', e => { g.speed = parseFloat(e.target.value); syncSegments(); });
    row.querySelector('.del').addEventListener('click', () => { state.segments.splice(i, 1); syncSegments(); });
    list.appendChild(row);
  });
}
function syncSegments() {
  state.segments.sort((a, b) => a.start - b.start);
  renderSegments();
  updateTimelineUI();
}
$('#addSegBtn').addEventListener('click', () => {
  const start = clamp(video.currentTime, state.trimStart, state.trimEnd - 0.5);
  state.segments.push({ start, end: Math.min(start + 3, state.trimEnd), speed: 0.5 });
  syncSegments();
});

// ─────────── Modal / progress ───────────
let adLoaded = false;
function maybeLoadAd() {
  if (adLoaded) return;
  const client = window.ADSENSE_CLIENT || '';
  const slotEl = $('#adSlot');
  const slot = slotEl?.dataset.adSlot;
  if (!client || /0000000000000000/.test(client) || !slot || /^0+$/.test(slot)) return; // not configured yet
  slotEl.innerHTML = '';
  const ins = document.createElement('ins');
  ins.className = 'adsbygoogle';
  ins.style.cssText = 'display:inline-block;width:336px;height:280px;max-width:100%';
  ins.setAttribute('data-ad-client', client);
  ins.setAttribute('data-ad-slot', slot);
  slotEl.appendChild(ins);
  try { (window.adsbygoogle = window.adsbygoogle || []).push({}); adLoaded = true; } catch { /* blocked */ }
}

let modalT0 = 0;
function showModal(titleKey) {
  $('#modalTitle').textContent = t(titleKey);
  progressFill.style.width = '0%';
  progressPct.textContent = '0%';
  $('#modalNote').textContent = t('processingNote');
  modalT0 = performance.now();
  modal.classList.remove('hidden');
  maybeLoadAd();
}
function setProgress(f) {
  f = clamp(f, 0, 1);
  const p = Math.round(f * 100);
  progressFill.style.width = `${p}%`;
  progressPct.textContent = `${p}%`;
  if (f > 0.03 && f < 1) {
    const elapsed = (performance.now() - modalT0) / 1000;
    const eta = Math.ceil(elapsed / f - elapsed);
    if (isFinite(eta) && eta >= 0) $('#modalNote').textContent = t('eta', { s: eta });
  }
}
function hideModal() { modal.classList.add('hidden'); }
function setIndeterminate(on) {
  progressFill.classList.toggle('indet', on);
  if (on) { progressFill.style.width = '40%'; progressPct.textContent = ''; }
  else progressFill.style.width = '0%';
}
$('#cancelBtn').addEventListener('click', () => abortCtl?.abort());

function toast(msg, ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ─────────── Analyze ───────────
$('#analyzeBtn').addEventListener('click', async () => {
  pause();
  abortCtl = new AbortController();
  showModal('loadingModel');
  setIndeterminate(true);   // model download has no progress; don't look frozen
  try {
    await tracker.init(state.quality);
    setIndeterminate(false);
    $('#modalTitle').textContent = t('analyzing');
    modalT0 = performance.now();
    const { frames, fps } = await tracker.analyze(video, {
      start: state.trimStart, end: state.trimEnd,
      scanRate: 1, onProgress: setProgress, signal: abortCtl.signal,
    });
    hideModal();
    if (!frames || frames.length < 2) { toast(t('analyzeLow', { p: 0 })); return; }
    state.frames = frames;
    state.sampleFps = fps;
    const { samples, rate } = trackSubject(frames);
    state.samples = samples;
    state.analyzed = true;
    rebuildPath();   // manual box keyframes are absolute, so they persist across re-analysis
    $('#trackInfo').textContent = t(rate < 0.5 ? 'analyzeLow' : 'analyzeDone');
    $('#exportBtn').disabled = false;
    updateManualUI();
    setView('crop');
    video.currentTime = state.trimStart;
  } catch (err) {
    hideModal();
    if (err.name === 'AbortError') toast(t('canceled'));
    else { console.error(err); toast(String(err.message || err)); }
  }
});

// ─────────── Export ───────────
$('#exportBtn').addEventListener('click', async () => {
  if (!state.analyzed) { toast(t('analyzeFirst')); return; }
  pause();
  ensureAudioGraph();
  await actx.resume();
  abortCtl = new AbortController();
  showModal('exporting');
  monitorGain.gain.value = 0; // silent export; audio still reaches the recorder
  // Mobile throttles/stops a non-visible <video>, truncating the capture. Show the source video
  // playing in the modal so it stays fully alive for the whole export.
  video.classList.add('export-live');
  $('#modalTitle').insertAdjacentElement('afterend', video);
  try {
    const [outW, outH] = ASPECTS[state.arKey].out;
    const res = await exportVideo({
      video,
      audioStream: recordDest.stream,
      drawFrame: (c, cvs, tSec) => renderFrame(c, cvs.width, cvs.height, tSec, true),
      trimStart: state.trimStart, trimEnd: state.trimEnd,
      speedAt, outW, outH,
      onProgress: setProgress,
      signal: abortCtl.signal,
    });
    state.result = res;
    showResult(res);
  } catch (err) {
    if (err.name === 'AbortError') toast(t('canceled'));
    else { console.error(err); toast(t('exportFail') + (err.message || err)); }
  } finally {
    monitorGain.gain.value = 1;
    video.classList.remove('export-live');
    if (video.parentNode) video.parentNode.removeChild(video);
    hideModal();
  }
});

// ─────────── Result / share ───────────
function showResult({ blob, ext }) {
  const url = URL.createObjectURL(blob);
  const rv = $('#resultVideo');
  rv.src = url;
  const dl = $('#downloadBtn');
  dl.href = url;
  dl.download = `climbcrop_${Date.now() % 100000}.${ext}`;
  showScreen('result');
}

// One unified share: hand the video file to the OS share sheet (Instagram, KakaoTalk, Messages,
// …). If file-sharing isn't available (most desktops), fall back to downloading the file.
async function shareResult() {
  if (!state.result) return;
  const { blob, ext } = state.result;
  const file = new File([blob], `climbcrop.${ext}`, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'ClimbCrop', text: 'ClimbCrop 🧗' });
    } catch (err) {
      if (err.name !== 'AbortError') { $('#downloadBtn').click(); toast(t('shareNoFiles'), 4000); }
    }
  } else {
    $('#downloadBtn').click();            // no OS share for files → just download it
    toast(t('shareNoFiles'), 4000);
  }
}
$('#shareBtn').addEventListener('click', shareResult);
$('#backToEditBtn').addEventListener('click', () => { showScreen('editor'); drawPreview(); });

// ─────────── Settings bindings ───────────
function setView(v) {
  state.view = v;
  $('#viewFullBtn').classList.toggle('active', v === 'full');
  $('#viewCropBtn').classList.toggle('active', v === 'crop');
  cv.classList.toggle('pannable', state.analyzed);   // drag the box in either view
  // Manual-correction UI (box-drag hint, keyframe help) only makes sense once analyzed.
  const disp = state.analyzed ? '' : 'none';
  for (const id of ['#seedHint', '#manualField', '#keyHintLegend']) {
    const el = $(id); if (el) el.style.display = disp;
  }
  fitPreviewCanvas();
  drawPreview();
}
$('#viewFullBtn').addEventListener('click', () => setView('full'));
$('#viewCropBtn').addEventListener('click', () => setView('crop'));
$('#resetFramingBtn').addEventListener('click', () => {
  state.boxKeys = [];
  updateManualUI();
  drawPreview();
});
$('#playBtn').addEventListener('click', () => state.playing ? pause() : play());
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !$('#screen-editor').classList.contains('hidden')
      && !['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) {
    e.preventDefault();
    state.playing ? pause() : play();
  }
});

$('#aspectSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.arKey = b.dataset.ar;
  $('#aspectSeg').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  rebuildPath();
  fitPreviewCanvas();
  drawPreview();
});
$('#qualitySeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.q === state.quality) return;
  state.quality = b.dataset.q;
  $('#qualitySeg').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  if (state.analyzed) toast(t('reanalyze'));
});
$('#skelSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.skel = b.dataset.skel;
  $('#skelSeg').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  drawPreview();
});

// ─────────── Watermark / branding controls ───────────
function setupWatermarkUI() {
  const dots = $('#gradeDots');
  GRADES.forEach(g => {
    const d = document.createElement('button');
    d.className = 'grade-dot';
    d.style.background = g.color;
    d.dataset.color = g.color;
    d.title = g.key;
    d.addEventListener('click', () => {
      state.watermark.difficulty = state.watermark.difficulty === g.color ? null : g.color;
      refreshGradeDots();
      drawPreview();
    });
    dots.appendChild(d);
  });

  const chips = $('#gymChips');
  const none = document.createElement('button');
  none.className = 'gym-chip none-opt active';
  none.dataset.gym = '';
  none.setAttribute('data-i18n', 'gymNone');
  none.textContent = t('gymNone');
  none.addEventListener('click', () => { state.watermark.gym = null; refreshGymChips(); drawPreview(); });
  chips.appendChild(none);

  GYMS.forEach(gym => {
    const b = document.createElement('button');
    b.className = 'gym-chip';
    b.dataset.gym = gym.name;
    b.title = gym.name;
    const img = new Image();
    img.src = gym.src;
    img.onload = () => { if (state.watermark.gym?.name === gym.name) drawPreview(); };
    b.appendChild(img);
    b.addEventListener('click', () => {
      const on = state.watermark.gym?.name === gym.name;
      state.watermark.gym = on ? null : { type: 'image', img, name: gym.name };
      refreshGymChips();
      drawPreview();
    });
    chips.appendChild(b);
  });
  refreshGymChips();
}
function refreshGradeDots() {
  document.querySelectorAll('#gradeDots .grade-dot').forEach(d =>
    d.classList.toggle('active', d.dataset.color === state.watermark.difficulty));
}
function refreshGymChips() {
  const name = state.watermark.gym?.name || '';
  document.querySelectorAll('#gymChips .gym-chip').forEach(c =>
    c.classList.toggle('active', (c.dataset.gym || '') === name));
}

const zoomSlider = $('#zoomSlider'), smoothSlider = $('#smoothSlider'), zoomDurSlider = $('#zoomDurSlider');
function syncSliderLabels() {
  $('#zoomVal').textContent = `${zoomSlider.value}%`;
  $('#smoothVal').textContent = `${smoothSlider.value}%`;
  $('#zoomDurVal').textContent = `${(zoomDurSlider.value / 10).toFixed(1)}s`;
}
zoomSlider.addEventListener('input', () => { state.zoom = zoomSlider.value / 100; syncSliderLabels(); rebuildPath(); drawPreview(); });
smoothSlider.addEventListener('input', () => { state.smooth = smoothSlider.value / 100; syncSliderLabels(); rebuildPath(); drawPreview(); });
zoomDurSlider.addEventListener('input', () => { state.zoomDur = zoomDurSlider.value / 10; syncSliderLabels(); drawPreview(); });

// Move the crop BOX to place a keyframe at the current frame.
//  • Original view: tap / drag → the box centre goes where you point (direct placement).
//  • Crop view: drag → pan the framing (content follows your drag).
// Keyframes interpolate between each other and fade back to auto-tracking elsewhere.
let dragKey = null, dragStart = null;
function keyAt(tSec) {
  let k = state.boxKeys.find(x => Math.abs(x.t - tSec) < 0.15);
  if (!k) {
    const box = cropAt(tSec);
    k = { t: tSec, cx: (box.x + box.w / 2) / state.vw, cy: (box.y + box.h / 2) / state.vh };
    state.boxKeys.push(k);
    state.boxKeys.sort((a, b) => a.t - b.t);
  }
  return k;
}
cv.addEventListener('pointerdown', e => {
  if (!(state.analyzed && state.path)) return;
  if (state.playing) pause();
  cv.setPointerCapture(e.pointerId);
  dragKey = keyAt(video.currentTime);
  dragStart = { x: e.clientX, y: e.clientY, cx: dragKey.cx, cy: dragKey.cy };
  if (state.view === 'full') setKeyToPointer(e);   // original view: jump box to the tap
  updateManualUI();
  drawPreview();
});
cv.addEventListener('pointermove', e => {
  if (!dragKey) return;
  if (state.view === 'full') {
    setKeyToPointer(e);
  } else {
    const r = cv.getBoundingClientRect();
    const cropFracX = state.path.cropW / state.vw, cropFracY = state.path.cropH / state.vh;
    dragKey.cx = clamp(dragStart.cx - ((e.clientX - dragStart.x) / r.width) * cropFracX, 0, 1);
    dragKey.cy = clamp(dragStart.cy - ((e.clientY - dragStart.y) / r.height) * cropFracY, 0, 1);
  }
  drawPreview();
});
function setKeyToPointer(e) {
  const r = cv.getBoundingClientRect();
  dragKey.cx = clamp((e.clientX - r.left) / r.width, 0, 1);
  dragKey.cy = clamp((e.clientY - r.top) / r.height, 0, 1);
}
function endDrag() { dragKey = null; }
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);

function updateManualUI() {
  const btn = $('#resetFramingBtn');
  if (btn) btn.style.display = state.boxKeys.length ? '' : 'none';
  const layer = $('#seedLayer');
  if (!layer) return;
  layer.innerHTML = '';
  for (const k of state.boxKeys) {
    const tick = document.createElement('div');
    tick.className = 'tl-seed';
    tick.style.left = `${(k.t / state.dur) * 100}%`;
    const del = document.createElement('button');
    del.className = 'tl-seed-del';
    del.textContent = '✕';
    del.title = t('deleteKey');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      state.boxKeys = state.boxKeys.filter(x => x !== k);
      updateManualUI();
      drawPreview();
    });
    tick.appendChild(del);
    tick.addEventListener('pointerdown', e => e.stopPropagation()); // don't scrub the timeline
    tick.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasSel = tick.classList.contains('sel');
      layer.querySelectorAll('.tl-seed.sel').forEach(x => x.classList.remove('sel'));
      if (!wasSel) { tick.classList.add('sel'); scrubTo(k.t); }
    });
    layer.appendChild(tick);
  }
}
// Click anywhere else hides the delete buttons.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.tl-seed')) $('#seedLayer')?.querySelectorAll('.tl-seed.sel').forEach(x => x.classList.remove('sel'));
});

// ─────────── Upload / init ───────────
async function loadVideo(file) {
  pause();
  showModal('loadingVideo');
  setIndeterminate(true);
  try {
    if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
    state.fileUrl = URL.createObjectURL(file);
    video.src = state.fileUrl;
    video.load();
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('timeout')), 20000);
      video.addEventListener('loadedmetadata', () => { clearTimeout(timer); res(); }, { once: true });
      video.addEventListener('error', () => {
        clearTimeout(timer);
        rej(new Error(`decode (code ${video.error?.code ?? '?'})`));
      }, { once: true });
    });
    if (!isFinite(video.duration) || !video.videoWidth) throw new Error('bad metadata');
    initEditor();
  } catch (err) {
    console.error(err);
    toast(`${t('videoLoadFail')} [${err.message}]`, 7000);
    fi.value = '';
  } finally {
    setIndeterminate(false);
    hideModal();
  }
}

function initEditor() {
  Object.assign(state, {
    dur: video.duration, vw: video.videoWidth, vh: video.videoHeight,
    trimStart: 0, trimEnd: video.duration,
    climbStart: Math.min(1, video.duration),   // intro zoom starts 1s after the start
    segments: [], boxKeys: [], frames: null, samples: null, path: null,
    analyzed: false, result: null, view: 'full', playing: false,
  });
  $('#exportBtn').disabled = true;
  $('#trackInfo').textContent = '';
  showScreen('editor');
  setView('full');
  renderSegments();
  updateTimelineUI();
  updateManualUI();
  seekTo(video, 0.05).then(() => drawPreview());
  buildThumbnails();
}

const dz = $('#dropzone'), fi = $('#fileInput');
// (opening the file picker is native — #dropzone is a <label for="fileInput">)
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
dz.addEventListener('drop', e => {
  e.preventDefault();
  dz.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('video/')) loadVideo(f);
});
fi.addEventListener('change', () => { if (fi.files[0]) loadVideo(fi.files[0]); });

function restart() {
  pause();
  showScreen('upload');
  fi.value = '';
}
$('#restartBtn').addEventListener('click', restart);
$('#restartBtn2').addEventListener('click', restart);

window.addEventListener('resize', () => { if (!$('#screen-editor').classList.contains('hidden')) drawPreview(); });

initI18n();
syncSliderLabels();
setupWatermarkUI();
showScreen('upload');
window.__ccAppReady = true; // signals the inline watchdog that module JS is alive
