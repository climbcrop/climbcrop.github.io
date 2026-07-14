// ─────────── Export: real-time canvas capture + audio graph → MediaRecorder ───────────
import { seekTo } from './tracker.js?v=2';

export function pickMime() {
  const candidates = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const m of candidates) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* ignore */ }
  }
  return '';
}

/**
 * Plays the trimmed range in real time (honoring speed sections via playbackRate,
 * which keeps audio in sync with pitch preserved) while drawing the crop to a canvas
 * captured by MediaRecorder together with the audio-graph stream.
 */
export async function exportVideo({
  video, audioStream, drawFrame, trimStart, trimEnd,
  speedAt, outW, outH, onProgress, signal, onCanvas,
}) {
  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  onCanvas?.(canvas);           // show it live on-screen (mobile: keeps the canvas painting)

  // Fixed 30 fps capture (CFR). Without an fps the stream is variable-rate, which many players
  // (mobile / Instagram) render with visible judder; a constant rate exports smoothly.
  const FPS = 30;
  const stream = canvas.captureStream(FPS);
  if (audioStream) for (const tr of audioStream.getAudioTracks()) stream.addTrack(tr);

  const mime = pickMime();
  const recorder = new MediaRecorder(stream, {
    ...(mime ? { mimeType: mime } : {}),
    videoBitsPerSecond: 9_000_000,   // 1080p-friendly; lower encoder load → fewer dropped frames
    audioBitsPerSecond: 192_000,
  });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = e => reject(e.error || new Error('MediaRecorder error'));
  });

  // Keep the screen awake so mobile doesn't sleep/throttle mid-export.
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* unsupported */ }

  video.pause();
  video.preservesPitch = true;
  await seekTo(video, trimStart);
  drawFrame(ctx, canvas, video.currentTime); // avoid a black first frame

  const recStart = performance.now();
  recorder.start(250);
  await video.play();

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    video.pause();
    video.playbackRate = 1;
    try { wakeLock?.release(); } catch { /* ignore */ }
    if (recorder.state !== 'inactive') recorder.stop();
  };

  await new Promise((resolve) => {
    let settled = false;
    const draw = () => {
      const t = video.currentTime;
      const rate = speedAt(t);
      if (Math.abs(video.playbackRate - rate) > 0.001) video.playbackRate = rate;
      drawFrame(ctx, canvas, t);
      onProgress?.((t - trimStart) / Math.max(0.001, trimEnd - trimStart));
    };
    const end = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('ended', end);
      clearInterval(watchdog);
      onProgress?.(1);
      finish();
      resolve();
    };
    const tick = () => {
      if (settled) return;
      const t = video.currentTime;
      if (signal?.aborted || t >= trimEnd || video.ended) { end(); return; }
      draw();
      video.requestVideoFrameCallback(tick);
    };
    // 'ended' fires when trimEnd == video end (no more frames → rVFC would stall).
    video.addEventListener('ended', end);
    // Watchdog: catch stalls / paused-at-end, AND keep the canvas painting if rVFC gets
    // throttled on mobile (so the captured stream never freezes into a short clip).
    const watchdog = setInterval(() => {
      if (settled) return;
      if (signal?.aborted || video.ended || video.currentTime >= trimEnd - 0.03) { end(); return; }
      draw();
    }, 200);
    video.requestVideoFrameCallback(tick);
  });

  await stopped;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const type = (mime || 'video/webm').split(';')[0];
  const ext = type === 'video/mp4' ? 'mp4' : 'webm';
  let blob = new Blob(chunks, { type });
  // MediaRecorder WebM omits the Duration header → mobile players/messengers read it as a
  // few-second clip. Patch the real duration in so it saves/shares at full length.
  if (ext === 'webm') blob = await fixWebmDurationSafe(blob, performance.now() - recStart);
  return { blob, ext };
}

// Inject the true Duration into a MediaRecorder WebM. Uses a small vendored fixer loaded
// on demand; any failure falls back to the original blob (never corrupts the output).
async function fixWebmDurationSafe(blob, durationMs) {
  if (!(durationMs > 0)) return blob;
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/fix-webm-duration@1.0.5/+esm');
    const fn = mod.default || mod.fixWebmDuration || (typeof mod === 'function' ? mod : null);
    if (!fn) return blob;
    const r = fn(blob, durationMs);                   // no callback arg → returns Promise<Blob>
    if (r && typeof r.then === 'function') {
      const out = await r;
      return out instanceof Blob ? out : blob;
    }
    return await new Promise((resolve) => {           // very old callback-only builds
      let done = false;
      try { fn(blob, durationMs, (fixed) => { done = true; resolve(fixed instanceof Blob ? fixed : blob); }); }
      catch { resolve(blob); }
      setTimeout(() => { if (!done) resolve(blob); }, 4000);
    });
  } catch { return blob; }
}
