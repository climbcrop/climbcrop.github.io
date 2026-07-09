// ─────────── Climber tracking: MediaPipe Pose + main-subject lock + smoothing ───────────
// MediaPipe is loaded lazily at analyze time so a CDN/adblock failure can't break the app UI.
const MEDIAPIPE_ESM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// Main skeleton bones (MediaPipe 33-landmark topology)
export const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [28, 30], [30, 32],
  [9, 10], [15, 19], [16, 20],
];

export function seekTo(video, t) {
  return new Promise(resolve => {
    const clamped = Math.max(0, Math.min(t, Math.max(0, video.duration - 0.03)));
    if (Math.abs(video.currentTime - clamped) < 0.001 && video.readyState >= 2) { resolve(); return; }
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = clamped;
  });
}

function poseInfo(lms) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0, n = 0;
  for (const p of lms) {
    const vis = p.visibility ?? 1;
    if (vis < 0.35) continue;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    n++;
  }
  if (n < 4) return null;
  // Center on the torso (shoulders + hips) when visible — steadier than the bbox center
  const torso = [11, 12, 23, 24].filter(i => (lms[i].visibility ?? 1) > 0.35);
  let cx, cy;
  if (torso.length >= 2) {
    cx = torso.reduce((s, i) => s + lms[i].x, 0) / torso.length;
    cy = torso.reduce((s, i) => s + lms[i].y, 0) / torso.length;
  } else {
    cx = (minX + maxX) / 2; cy = (minY + maxY) / 2;
  }
  return {
    cx, cy,
    h: maxY - minY,
    area: (maxX - minX) * (maxY - minY),
    lms: lms.map(p => [p.x, p.y, p.visibility ?? 1]),
  };
}

// Pick the main subject: nearest candidate to the anchor within maxJump.
// anchor is a predicted {cx,cy}; maxJump grows while frames are missed so the
// tracker can re-acquire a fast climber instead of freezing on a stale position.
function pickPose(cands, anchor, maxJump) {
  if (!cands.length) return null;
  if (!anchor) return cands.slice().sort((a, b) => b.area - a.area)[0]; // first lock: biggest person
  let best = null, bestD = Infinity;
  for (const c of cands) {
    const d = Math.hypot(c.cx - anchor.cx, c.cy - anchor.cy);
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= maxJump ? best : null;
}

// Fill missed frames by interpolating between the nearest detections (never lose the subject).
function fillGaps(samples) {
  const idx = samples.map((s, i) => s.det ? i : -1).filter(i => i >= 0);
  if (!idx.length) return false;
  const first = idx[0], last = idx[idx.length - 1];
  for (let i = 0; i < first; i++) samples[i].det = samples[first].det;
  for (let i = last + 1; i < samples.length; i++) samples[i].det = samples[last].det;
  for (let k = 0; k < idx.length - 1; k++) {
    const a = idx[k], b = idx[k + 1];
    for (let i = a + 1; i < b; i++) {
      const f = (i - a) / (b - a);
      const A = samples[a].det, B = samples[b].det;
      samples[i].det = {
        cx: A.cx + (B.cx - A.cx) * f,
        cy: A.cy + (B.cy - A.cy) * f,
        h: A.h + (B.h - A.h) * f,
        area: A.area,
        lms: A.lms.map((p, j) => [
          p[0] + (B.lms[j][0] - p[0]) * f,
          p[1] + (B.lms[j][1] - p[1]) * f,
          Math.min(p[2], B.lms[j][2]),
        ]),
        interp: true,
      };
    }
  }
  return true;
}

export class Tracker {
  constructor() { this.landmarker = null; }

  async init(onStatus) {
    if (this.landmarker) return;
    onStatus?.('loadingModel');
    let FilesetResolver, PoseLandmarker;
    try {
      ({ FilesetResolver, PoseLandmarker } = await import(MEDIAPIPE_ESM));
    } catch {
      throw new Error('AI 모델 라이브러리를 불러오지 못했어요. 인터넷 연결 또는 광고차단기를 확인해 주세요. (Failed to load MediaPipe from CDN)');
    }
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    // IMAGE mode: each seeked frame is detected independently — no internal video
    // tracker to drift/stall when we jump around the timeline. We do our own
    // cross-frame subject tracking below.
    const opts = {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'IMAGE',
      numPoses: 5,
      minPoseDetectionConfidence: 0.35,
      minPosePresenceConfidence: 0.35,
    };
    try {
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts);
    } catch {
      opts.baseOptions.delegate = 'CPU';
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts);
    }
  }

  /**
   * Sample the trimmed range in a SINGLE linear playback pass (no per-frame seeking —
   * random seeks are the slow part). Plays muted at scanRate× and runs pose detection on
   * EVERY delivered frame via requestVideoFrameCallback, then does subject tracking.
   * scanRate 1 = real-time scan, one detection per frame (keeps up on typical clips);
   * inference that can't keep up simply drops the odd frame — still near per-frame dense.
   */
  async analyze(video, { start, end, seed = null, onProgress, signal, scanRate = 1 }) {
    const raw = [];                 // { t, cands } collected during the pass, one per frame

    const wasMuted = video.muted, wasRate = video.playbackRate;
    video.muted = true;             // silent, and lets it play without a gesture
    await seekTo(video, start);

    try {
      await new Promise((resolve, reject) => {
        let lastT = -1, done = false, watchdog = 0;
        const finish = (err) => {
          if (done) return; done = true;
          clearInterval(watchdog);
          video.removeEventListener('ended', onEnded);
          signal?.removeEventListener('abort', onAbort);
          video.pause();
          err ? reject(err) : resolve();
        };
        const onAbort = () => finish(new DOMException('Aborted', 'AbortError'));
        const onEnded = () => finish();   // trimEnd == video end → no more frames to sample
        if (signal) {
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
        }
        const onFrame = (now, meta) => {
          if (done) return;
          const t = meta.mediaTime;
          if (t > lastT + 1e-4) {   // detect on every distinct frame
            lastT = t;
            let result;
            try { result = this.landmarker.detect(video); }
            catch { result = { landmarks: [] }; }
            raw.push({ t, cands: (result.landmarks || []).map(poseInfo).filter(Boolean) });
            onProgress?.(Math.min(1, (t - start) / Math.max(0.001, end - start)));
          }
          if (t >= end - 1e-3 || video.ended) { finish(); return; }
          video.requestVideoFrameCallback(onFrame);
        };
        video.addEventListener('ended', onEnded);
        // Watchdog: rVFC stops firing once playback ends/stalls near the clip end.
        watchdog = setInterval(() => {
          if (done) return;
          if (video.ended || video.currentTime >= end - 0.03) finish();
        }, 200);
        video.playbackRate = scanRate;
        video.requestVideoFrameCallback(onFrame);
        video.play().then(() => {}, finish);
      });
    } finally {
      video.pause();
      video.muted = wasMuted;
      video.playbackRate = wasRate;
    }

    if (raw.length < 2) return { samples: null, rate: 0 };

    // ── Subject tracking over the collected frames ──
    // The main subject is committed on the FIRST frame (seed if the user tapped one,
    // else the largest person) and never re-decided. Prediction + a modest re-acquire
    // window keep the lock on that same climber; longer misses are interpolated rather
    // than grabbed from another person.
    const samples = [];
    let prev = null, prevT = null, vx = 0, vy = 0;
    const MAX_V = 1.5;
    let detected = 0;
    for (const { t, cands } of raw) {
      let anchor = null, maxJump = 0.42;
      if (prev) {
        const dt = t - prevT;
        anchor = { cx: prev.cx + vx * dt, cy: prev.cy + vy * dt };
        maxJump = Math.min(0.34, 0.16 + 0.22 * dt);  // stay on the first-frame subject
      } else if (seed) {
        anchor = seed;
      }
      const det = pickPose(cands, anchor, maxJump);
      if (det) {
        if (prev && t > prevT) {
          const dt = t - prevT;
          vx = clampV((det.cx - prev.cx) / dt, MAX_V);
          vy = clampV((det.cy - prev.cy) / dt, MAX_V);
        }
        prev = det; prevT = t; detected++;
      } else {
        vx *= 0.7; vy *= 0.7;
      }
      samples.push({ t, det });
    }

    const ok = fillGaps(samples);
    if (!ok) return { samples: null, rate: 0 };
    const effFps = (samples.length - 1) / Math.max(0.001, end - start);
    return { samples, rate: detected / samples.length, fps: effFps };
  }
}

function clampV(v, m) { return Math.max(-m, Math.min(m, v)); }

// ─────────── Crop path (smoothed, clamped, aspect-locked) ───────────
function boxBlur(arr, radius, passes = 3) {
  let a = arr.slice();
  for (let p = 0; p < passes; p++) {
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++) {
      let sum = 0, n = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(a.length - 1, i + radius); j++) { sum += a[j]; n++; }
      out[i] = sum / n;
    }
    a = out;
  }
  return a;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const smoothstep = x => { const k = clamp(x, 0, 1); return k * k * (3 - 2 * k); };
export const lerpBox = (A, B, f) => ({
  x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f,
  w: A.w + (B.w - A.w) * f, h: A.h + (B.h - A.h) * f,
});

/**
 * Build the crop path from analysis samples.
 * ar = width/height. zoom: 1 = full view, smaller = tighter. smooth: 0..1.
 */
export function buildPath(samples, { vw, vh, ar, zoom, smooth, fps }) {
  // Full view: the largest crop of the target aspect that fits inside the frame, centered.
  let fullH = vh, fullW = fullH * ar;
  if (fullW > vw) { fullW = vw; fullH = fullW / ar; }
  const full = { x: (vw - fullW) / 2, y: (vh - fullH) / 2, w: fullW, h: fullH };

  const cropH = fullH * zoom;
  const cropW = cropH * ar; // ≤ fullW ≤ vw by construction — the box can never leave the frame

  const times = samples.map(s => s.t);
  const windowSec = 0.4 + smooth * 3.2;
  const radius = Math.max(1, Math.round(windowSec * fps / 2));
  const cxs = boxBlur(samples.map(s => s.det.cx * vw), radius);
  // Bias slightly above the torso center to leave headroom for the climber
  const cys = boxBlur(samples.map(s => (s.det.cy - s.det.h * 0.06) * vh), radius);

  function indexAt(t) {
    if (t <= times[0]) return [0, 0, 0];
    if (t >= times[times.length - 1]) return [times.length - 1, times.length - 1, 0];
    let lo = 0, hi = times.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; (times[m] <= t ? lo = m : hi = m); }
    return [lo, hi, (t - times[lo]) / (times[hi] - times[lo])];
  }

  function centerAt(t) {
    const [a, b, f] = indexAt(t);
    return [cxs[a] + (cxs[b] - cxs[a]) * f, cys[a] + (cys[b] - cys[a]) * f];
  }

  function trackedBox(t) {
    const [cx, cy] = centerAt(t);
    return {
      x: clamp(cx - cropW / 2, 0, vw - cropW),
      y: clamp(cy - cropH / 2, 0, vh - cropH),
      w: cropW, h: cropH,
    };
  }

  function lmsAt(t) {
    const [a, b, f] = indexAt(t);
    const A = samples[a].det.lms, B = samples[b].det.lms;
    return A.map((p, j) => [p[0] + (B[j][0] - p[0]) * f, p[1] + (B[j][1] - p[1]) * f, Math.min(p[2], B[j][2])]);
  }

  return { full, trackedBox, lmsAt, cropW, cropH };
}
