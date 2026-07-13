// ─────────── Climber tracking: MediaPipe Pose + main-subject lock + smoothing ───────────
// MediaPipe is loaded lazily at analyze time so a CDN/adblock failure can't break the app UI.
const MEDIAPIPE_ESM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
// Accuracy tiers. lite is fast but mislabels side-on / unusual climbing poses; heavy is far
// more robust (at a bigger download + slower inference). Default to heavy for quality.
const MODELS = {
  fast:     'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  balanced: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  accurate: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task',
};

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
  // Confidence proxy: mean visibility of the core torso landmarks that define the center.
  // Low on side-on / occluded / hallucinated poses → used to hold rather than jump.
  const core = [11, 12, 23, 24];
  let cvis = 0;
  for (const i of core) cvis += (lms[i].visibility ?? 0);
  const conf = cvis / core.length;
  return {
    cx, cy,
    h: maxY - minY,
    area: (maxX - minX) * (maxY - minY),
    conf,
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

// Multiple people, no seed: follow whoever is nearest the horizontal centre of the frame.
function pickCentered(cands) {
  let best = null, bestD = Infinity;
  for (const c of cands) {
    const d = Math.abs(c.cx - 0.5);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
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
  constructor() { this.landmarker = null; this.modelKey = null; this._mp = null; this._fileset = null; }

  async init(modelKey = 'accurate', onStatus) {
    if (this.landmarker && this.modelKey === modelKey) return;
    onStatus?.('loadingModel');
    if (!this._mp) {
      try { this._mp = await import(MEDIAPIPE_ESM); }
      catch {
        throw new Error('AI 모델 라이브러리를 불러오지 못했어요. 인터넷 연결 또는 광고차단기를 확인해 주세요. (Failed to load MediaPipe from CDN)');
      }
    }
    const { FilesetResolver, PoseLandmarker } = this._mp;
    if (!this._fileset) this._fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    if (this.landmarker) { try { this.landmarker.close(); } catch { /* ignore */ } this.landmarker = null; }
    // IMAGE mode: each seeked frame is detected independently — no internal video
    // tracker to drift/stall when we jump around the timeline. We do our own
    // cross-frame subject tracking below.
    const opts = {
      baseOptions: { modelAssetPath: MODELS[modelKey] || MODELS.balanced, delegate: 'GPU' },
      runningMode: 'IMAGE',
      numPoses: 5,
      minPoseDetectionConfidence: 0.35,
      minPosePresenceConfidence: 0.35,
    };
    try {
      this.landmarker = await PoseLandmarker.createFromOptions(this._fileset, opts);
    } catch {
      opts.baseOptions.delegate = 'CPU';
      this.landmarker = await PoseLandmarker.createFromOptions(this._fileset, opts);
    }
    this.modelKey = modelKey;
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
    // else the largest person). Two-tier association keeps the lock robust:
    //  • LOCKED (recent hit): accept only a candidate near the predicted position, so a
    //    brief occlusion by another climber can't steal the identity.
    //  • LOST (missed for > grace): read ALL skeletons in the frame globally and re-acquire
    //    the best match by scale-similarity + proximity, radius growing with time lost — so
    //    losing track for a moment never kills tracking for the rest of the clip.
    const samples = [];
    let prev = null, prevT = null, vx = 0, vy = 0, refH = 0;
    const MAX_V = 1.5, GRACE = 0.35;
    const MIN_CONF = 0.5;        // below this a detection is too unreliable to move the crop
    let detected = 0;
    for (const { t, cands } of raw) {
      let det;
      if (!prev) {
        // Initial lock: nearest to the seed the user tapped; otherwise, when several people
        // are in frame, follow the one closest to the horizontal centre (fixed-camera clips
        // frame the climber near the middle).
        det = (seed && pickPose(cands, seed, 0.5)) || pickCentered(cands);
      } else {
        const dt = t - prevT;
        const anchor = { cx: prev.cx + vx * dt, cy: prev.cy + vy * dt };
        det = dt <= GRACE
          ? pickPose(cands, anchor, 0.16 + 0.5 * dt)          // strict while briefly occluded
          : reacquire(cands, anchor, refH, dt);               // global re-acquire when lost
        // Confidence + scale gate: a low-confidence pose (side-on/occluded) or one whose size
        // is way off the tracked climber is a likely mis-detection — drop it and let the frame
        // interpolate (i.e. hold the last good position, then ease to the next good one).
        if (det && (det.conf < MIN_CONF || (refH && Math.abs(det.h - refH) / refH > 0.55))) det = null;
      }
      if (det) {
        if (prev && t > prevT) {
          const dt = t - prevT;
          const jump = Math.hypot(det.cx - prev.cx, det.cy - prev.cy);
          if (jump > 0.3) { vx = 0; vy = 0; }                 // re-acquire teleport: don't fling
          else { vx = clampV((det.cx - prev.cx) / dt, MAX_V); vy = clampV((det.cy - prev.cy) / dt, MAX_V); }
        }
        prev = det; prevT = t;
        refH = refH ? refH * 0.8 + det.h * 0.2 : det.h;       // running reference scale
        detected++;
      } else {
        vx *= 0.6; vy *= 0.6;
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

// Re-acquire the lost subject by scanning every skeleton in the frame. Score each candidate
// by proximity to the predicted position (radius grows the longer we've been lost) and by
// similarity to the subject's learned scale; reject candidates of a very different size so we
// don't lock onto a clearly different person.
function reacquire(cands, anchor, refH, dt) {
  if (!cands.length) return null;
  const radius = Math.min(1.2, 0.3 + 0.4 * dt);   // widen search the longer we're lost
  let best = null, bestScore = -Infinity;
  for (const c of cands) {
    const d = Math.hypot(c.cx - anchor.cx, c.cy - anchor.cy);
    if (d > radius) continue;
    const posScore = 1 - d / radius;
    const scaleScore = refH ? 1 - Math.min(1, Math.abs(c.h - refH) / refH) : 0.5;
    const score = 0.4 * posScore + 0.4 * scaleScore + 0.2 * (c.conf ?? 0);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (!best) return null;
  if (refH && Math.abs(best.h - refH) / refH > 0.6) return null;   // too different in size
  if ((best.conf ?? 0) < 0.4) return null;                          // too unreliable to re-lock
  return best;
}

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
