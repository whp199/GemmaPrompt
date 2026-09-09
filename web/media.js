/* Browser-only reference preparation. Original videos never leave this tab. */
const GemmaMedia = (() => {
  function sampleTimes(duration, count) {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Video has no readable duration.');
    if (!Number.isInteger(count) || count < 2 || count > 32) throw new Error('Choose 2–32 sample frames.');
    // Stay inside the final decoded frame, including very short clips.
    const end = Math.max(0, duration - Math.min(0.05, duration / 2));
    return Array.from({ length: count }, (_, i) => end * i / (count - 1));
  }

  function waitFor(video, event, action, signal) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener(event, ready);
        video.removeEventListener('error', fail);
        signal?.removeEventListener('abort', abort);
      };
      const ready = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error('Cannot decode this video. Try an MP4 (H.264) or WebM file.')); };
      const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Video decoding timed out. Try a shorter clip or another codec.')); }, 20000);
      video.addEventListener(event, ready, { once: true });
      video.addEventListener('error', fail, { once: true });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      try { action(); } catch (err) { cleanup(); reject(err); }
    });
  }

  async function videoFrames(file, count, signal, progress = () => {}) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    try {
      await waitFor(video, 'loadeddata', () => { video.src = url; video.load(); }, signal);
      const times = sampleTimes(video.duration, count);
      if (!video.videoWidth || !video.videoHeight) throw new Error('This file has no video track.');
      const scale = Math.min(1, 768 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const ctx = canvas.getContext('2d');
      const frames = [];
      for (const time of times) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (Math.abs(video.currentTime - time) > 0.00001) {
          await waitFor(video, 'seeked', () => { video.currentTime = time; }, signal);
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push({ time, url: canvas.toDataURL('image/jpeg', 0.82) });
        progress(frames.length, times.length);
      }
      return { name: file.name, duration: video.duration, frames, preview: url };
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    } finally {
      video.removeAttribute('src');
      video.load();
    }
  }
  return { sampleTimes, videoFrames };
})();
if (typeof module !== 'undefined') module.exports = GemmaMedia;
