// ─────────── ClimbCrop main app ───────────
import { initI18n, t } from './i18n.js?v=2';
import { Tracker, buildPath, seekTo, smoothstep, lerpBox, BONES } from './tracker.js?v=2';
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
  samples: null, path: null, seed: null,
  view: 'full', playing: false, analyzed: false,
  result: null,
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

function cropAt(tSec) {
  const full = state.path ? state.path.full : fullViewBox();
  if (!state.path) {
    // pre-analysis preview of the crop size, centered on the seed or frame center
    const h = full.h * state.zoom, w = h * arVal();
    const cx = state.seed ? state.seed.cx * state.vw : state.vw / 2;
    const cy = state.seed ? state.seed.cy * state.vh : state.vh / 2;
    return { x: clamp(cx - w / 2, 0, state.vw - w), y: clamp(cy - h / 2, 0, state.vh - h), w, h };
  }
  if (tSec <= state.climbStart) return full;              // full view before the problem starts
  const tracked = state.path.trackedBox(tSec);
  if (tSec < state.climbStart + state.zoomDur) {           // gentle ease-in zoom
    const f = smoothstep((tSec - state.climbStart) / state.zoomDur);
    return lerpBox(full, tracked, f);
  }
  return tracked;
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

function renderFrame(c, cw, ch, tSec, forExport = false) {
  const cropMode = forExport || (state.view === 'crop' && state.analyzed);
  if (cropMode) {
    const box = cropAt(tSec);
    c.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, cw, ch);
    const sX = cw / box.w;
    drawSkeleton(c, tSec,
      nx => (nx * state.vw - box.x) * sX,
      ny => (ny * state.vh - box.y) * (ch / box.h),
      sX * (state.vw / 1000));
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
    if (state.path) drawSkeleton(c, tSec, nx => nx * cw, ny => ny * ch, sx * (state.vw / 1000));
    if (state.seed) {
      c.save();
      c.strokeStyle = '#fbbf24'; c.lineWidth = 2;
      c.beginPath();
      c.arc(state.seed.cx * cw, state.seed.cy * ch, 12, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.arc(state.seed.cx * cw, state.seed.cy * ch, 3, 0, Math.PI * 2);
      c.fillStyle = '#fbbf24'; c.fill();
      c.restore();
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
  $('#hClimb').style.left = pct(state.climbStart);
  $('#shadeL').style.width = pct(state.trimStart);
  $('#shadeR').style.width = `${(1 - state.trimEnd / state.dur) * 100}%`;
  $('#trimLabelVal').textContent = `${fmt(state.trimStart)} – ${fmt(state.trimEnd)}`;
  $('#climbLabelVal').textContent = fmt(state.climbStart);
  $('#climbStartVal').textContent = fmt(state.climbStart);
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

// Keep the climb marker and every speed section inside the trimmed range.
function clampInnerKeyframes() {
  state.climbStart = clamp(state.climbStart, state.trimStart, state.trimEnd);
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
    clampInnerKeyframes();
    scrubTo(state.trimStart);            // show the new start frame live
  } else if (dragRole === 'end') {
    state.trimEnd = clamp(tSec, state.trimStart + 0.5, state.dur);
    clampInnerKeyframes();
    scrubTo(state.trimEnd);              // show the new end frame live
  } else if (dragRole === 'climb') {
    state.climbStart = clamp(tSec, state.trimStart, state.trimEnd);
    scrubTo(state.climbStart);
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
  try {
    await tracker.init();
    $('#modalTitle').textContent = t('analyzing');
    modalT0 = performance.now();
    const { samples, rate, fps } = await tracker.analyze(video, {
      start: state.trimStart, end: state.trimEnd, fps: ANALYZE_FPS,
      seed: state.seed, onProgress: setProgress, signal: abortCtl.signal,
    });
    hideModal();
    if (!samples) {
      toast(t('analyzeLow', { p: 0 }));
      return;
    }
    state.samples = samples;
    state.sampleFps = fps;
    state.analyzed = true;
    rebuildPath();
    $('#trackInfo').textContent = t(rate < 0.5 ? 'analyzeLow' : 'analyzeDone');
    $('#exportBtn').disabled = false;
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
  // Mobile keeps an off-DOM <video> from playing reliably — mount it (tiny) for the export.
  video.classList.add('export-live');
  document.body.appendChild(video);
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
      onCanvas: mountExportPreview,
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
    clearExportPreview();
    hideModal();
  }
});

// Show the export canvas live inside the modal (also keeps a painted canvas on-screen,
// which mobile browsers need for captureStream to keep producing frames).
function mountExportPreview(canvas) {
  clearExportPreview();
  canvas.className = 'export-live-canvas';
  $('#modalTitle').insertAdjacentElement('afterend', canvas);
}
function clearExportPreview() {
  document.querySelector('.export-live-canvas')?.remove();
}

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

async function shareResult() {
  if (!state.result) return;
  const { blob, ext } = state.result;
  const file = new File([blob], `climbcrop.${ext}`, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'ClimbCrop' }); } catch { /* user dismissed */ }
  } else {
    toast(t('shareNoFiles'), 5000);
  }
}
$('#shareBtn').addEventListener('click', shareResult);
$('#shareInsta').addEventListener('click', shareResult);
$('#shareKakao').addEventListener('click', shareResult);
$('#backToEditBtn').addEventListener('click', () => { showScreen('editor'); drawPreview(); });

// ─────────── Settings bindings ───────────
function setView(v) {
  state.view = v;
  $('#viewFullBtn').classList.toggle('active', v === 'full');
  $('#viewCropBtn').classList.toggle('active', v === 'crop');
  fitPreviewCanvas();
  drawPreview();
}
$('#viewFullBtn').addEventListener('click', () => setView('full'));
$('#viewCropBtn').addEventListener('click', () => setView('crop'));
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
$('#setClimbBtn').addEventListener('click', () => {
  state.climbStart = clamp(video.currentTime, state.trimStart, state.trimEnd);
  updateTimelineUI();
  drawPreview();
});

// Pick the main climber — always on the FIRST frame so the lock matches where analysis starts.
cv.addEventListener('click', e => {
  if (state.view === 'crop' && state.analyzed) return;
  if (Math.abs(video.currentTime - state.trimStart) > 0.15) {
    scrubTo(state.trimStart);            // jump to the first frame, then tap the climber
    toast(t('pickOnFirst'));
    return;
  }
  const r = cv.getBoundingClientRect();
  state.seed = { cx: (e.clientX - r.left) / r.width, cy: (e.clientY - r.top) / r.height };
  if (state.analyzed) toast(t('reanalyze'));
  drawPreview();
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
    climbStart: Math.min(1.5, video.duration * 0.15),
    segments: [], samples: null, path: null, seed: null,
    analyzed: false, result: null, view: 'full', playing: false,
  });
  $('#exportBtn').disabled = true;
  $('#trackInfo').textContent = '';
  showScreen('editor');
  setView('full');
  renderSegments();
  updateTimelineUI();
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
