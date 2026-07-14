// ─────────── Click-to-track: appearance tracking (ZNCC template), no external library ───────────
// The user picks the climber once (a seed box, ideally refined by a MediaPipe detection at the
// start frame). We then follow that APPEARANCE patch frame-to-frame — immune to "holds look like
// a pose", works when the climber is small or side-on. Translation only (the crop size is fixed
// by the zoom, so tracking the centre is enough). Falls back to coasting when the match is weak.
import { seekTo } from './tracker.js?v=2';

const WW = 420;                 // work-resolution width (grayscale); keeps the search cheap
const TW = 28, TH = 28;         // template grid
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export async function analyzeClickTrack(video, { start, end, box0, onProgress, signal, scanRate = 1 }) {
  const sc = WW / video.videoWidth;
  const WH = Math.round(video.videoHeight * sc);
  const cap = document.createElement('canvas');
  cap.width = WW; cap.height = WH;
  const cctx = cap.getContext('2d', { willReadFrequently: true });

  const bw = Math.max(16, box0.w * WW), bh = Math.max(16, box0.h * WH);   // box size (constant)
  let cx = (box0.x + box0.w / 2) * WW, cy = (box0.y + box0.h / 2) * WH;   // tracked centre (work px)

  const tmpl = new Float32Array(TW * TH);
  const patch = new Float32Array(TW * TH);
  let haveTmpl = false;

  function grayFrame() {
    cctx.drawImage(video, 0, 0, WW, WH);
    const d = cctx.getImageData(0, 0, WW, WH).data;
    const g = new Float32Array(WW * WH);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    return g;
  }
  // Sample the box-sized region centred at (ccx,ccy) into a TW×TH grid.
  function sample(g, ccx, ccy, out) {
    const x0 = ccx - bw / 2, y0 = ccy - bh / 2;
    let k = 0;
    for (let ty = 0; ty < TH; ty++) {
      const sy = clamp(Math.round(y0 + (ty + 0.5) * bh / TH), 0, WH - 1) * WW;
      for (let tx = 0; tx < TW; tx++) {
        const sx = clamp(Math.round(x0 + (tx + 0.5) * bw / TW), 0, WW - 1);
        out[k++] = g[sy + sx];
      }
    }
  }
  function zncc(a, b) {
    const n = a.length; let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
    return num / (Math.sqrt(da * db) + 1e-6);
  }

  const samples = [];
  const push = (t) => samples.push({
    t,
    det: { cx: cx / WW, cy: cy / WH, h: bh / WH, area: (bw * bh) / (WW * WH), lms: null },
  });

  function track(g) {
    if (!haveTmpl) { sample(g, cx, cy, tmpl); haveTmpl = true; return; }
    const R = Math.round(0.07 * WW);      // search radius
    let best = -Infinity, bcx = cx, bcy = cy;
    for (let dy = -R; dy <= R; dy += 2) {
      for (let dx = -R; dx <= R; dx += 2) {
        const ccx = clamp(cx + dx, bw / 2, WW - bw / 2);
        const ccy = clamp(cy + dy, bh / 2, WH - bh / 2);
        sample(g, ccx, ccy, patch);
        const s = zncc(tmpl, patch);
        if (s > best) { best = s; bcx = ccx; bcy = ccy; }
      }
    }
    // refine ±1 around the best coarse offset
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ccx = clamp(bcx + dx, bw / 2, WW - bw / 2);
        const ccy = clamp(bcy + dy, bh / 2, WH - bh / 2);
        sample(g, ccx, ccy, patch);
        const s = zncc(tmpl, patch);
        if (s > best) { best = s; bcx = ccx; bcy = ccy; }
      }
    }
    if (best > 0.2) {                     // confident enough → move; else coast (hold position)
      cx = bcx; cy = bcy;
      if (best > 0.45) {                  // adapt the template slowly to lighting/appearance
        sample(g, cx, cy, patch);
        for (let i = 0; i < tmpl.length; i++) tmpl[i] = 0.9 * tmpl[i] + 0.1 * patch[i];
      }
    }
  }

  const wasMuted = video.muted, wasRate = video.playbackRate;
  video.muted = true;
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
      const onEnded = () => finish();
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
      const onFrame = (now, meta) => {
        if (done) return;
        const t = meta.mediaTime;
        if (t > lastT + 1e-4) {
          lastT = t;
          track(grayFrame());
          push(t);
          onProgress?.(Math.min(1, (t - start) / Math.max(0.001, end - start)));
        }
        if (t >= end - 1e-3 || video.ended) { finish(); return; }
        video.requestVideoFrameCallback(onFrame);
      };
      video.addEventListener('ended', onEnded);
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

  if (samples.length < 2) return { samples: null, rate: 0 };
  const effFps = (samples.length - 1) / Math.max(0.001, end - start);
  return { samples, rate: 1, fps: effFps };
}
