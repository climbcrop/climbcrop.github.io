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
  speedAt, outW, outH, onProgress, signal,
}) {
  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  const stream = canvas.captureStream();
  if (audioStream) for (const tr of audioStream.getAudioTracks()) stream.addTrack(tr);

  const mime = pickMime();
  const recorder = new MediaRecorder(stream, {
    ...(mime ? { mimeType: mime } : {}),
    videoBitsPerSecond: 14_000_000,
    audioBitsPerSecond: 192_000,
  });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = e => reject(e.error || new Error('MediaRecorder error'));
  });

  video.pause();
  video.preservesPitch = true;
  await seekTo(video, trimStart);
  drawFrame(ctx, canvas, video.currentTime); // avoid a black first frame

  recorder.start(250);
  await video.play();

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    video.pause();
    video.playbackRate = 1;
    if (recorder.state !== 'inactive') recorder.stop();
  };

  await new Promise((resolve) => {
    let settled = false;
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
      const rate = speedAt(t);
      if (Math.abs(video.playbackRate - rate) > 0.001) video.playbackRate = rate;
      drawFrame(ctx, canvas, t);
      onProgress?.((t - trimStart) / Math.max(0.001, trimEnd - trimStart));
      video.requestVideoFrameCallback(tick);
    };
    // 'ended' fires when trimEnd == video end (no more frames → rVFC would stall).
    video.addEventListener('ended', end);
    // Watchdog: also catch stalls / paused-at-end where neither rVFC nor 'ended' fire.
    const watchdog = setInterval(() => {
      if (settled) return;
      if (signal?.aborted || video.ended || video.currentTime >= trimEnd - 0.03) end();
    }, 200);
    video.requestVideoFrameCallback(tick);
  });

  await stopped;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const type = (mime || 'video/webm').split(';')[0];
  return { blob: new Blob(chunks, { type }), ext: type === 'video/mp4' ? 'mp4' : 'webm' };
}
