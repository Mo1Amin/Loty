import type { Player, PlayerEvents } from './types.ts';

export type Html5Input =
  | { type: 'url'; url: string; hls: boolean }
  | { type: 'file'; file: File }
  | { type: 'stream'; stream: MediaStream; muted?: boolean };

/**
 * One <video> element for everything the browser can decode itself:
 * direct files, HLS, a file from this device, and a live WebRTC stream.
 */
export async function createHtml5Player(host: HTMLElement, input: Html5Input, startAt: number, events: PlayerEvents): Promise<Player> {
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  video.className = 'stage-video';
  host.appendChild(video);

  let objectUrl: string | null = null;
  let hls: { destroy(): void } | null = null;
  let destroyed = false;
  const live = input.type === 'stream';

  if (input.type === 'stream') {
    video.srcObject = input.stream;
    video.muted = !!input.muted;
    video.controls = false;
  } else {
    video.controls = true;
    if (input.type === 'file') {
      objectUrl = URL.createObjectURL(input.file);
      video.src = objectUrl;
    } else if (input.hls && !video.canPlayType('application/vnd.apple.mpegurl')) {
      const { default: Hls } = await import('hls.js');
      if (!Hls.isSupported()) throw new Error('This browser cannot play HLS');
      const h = new Hls({ startPosition: startAt || -1, maxBufferLength: 30 });
      h.loadSource(input.url);
      h.attachMedia(video);
      h.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal && !destroyed) events.error({ message: 'البث ده وقف أو الرابط انتهى.', openUrl: input.url });
      });
      hls = h;
    } else {
      video.src = input.url;
    }
    if (startAt > 0) {
      video.addEventListener('loadedmetadata', () => (video.currentTime = startAt), { once: true });
    }
  }

  video.addEventListener('play', () => events.play());
  video.addEventListener('pause', () => {
    if (!video.ended) events.pause();
  });
  video.addEventListener('seeked', () => events.seeked(video.currentTime));
  video.addEventListener('waiting', () => events.buffering(true));
  video.addEventListener('playing', () => events.buffering(false));
  video.addEventListener('canplay', () => events.buffering(false));
  video.addEventListener('ended', () => events.ended());
  video.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(video.duration)) events.meta({ duration: video.duration });
  });
  video.addEventListener('error', () => {
    if (destroyed || live) return;
    const code = video.error?.code;
    events.error({
      message:
        code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
          ? 'المتصفح ده مش بيعرف يشغّل الصيغة دي. جرّب MP4 أو WebM.'
          : 'الرابط مش بيفتح. ممكن يكون انتهى أو محتاج تسجيل دخول — جرّب البث من شاشتك.',
      ...(input.type === 'url' ? { openUrl: input.url } : {}),
    });
  });

  return {
    smooth: !live,
    live,
    video,
    async play() {
      try {
        await video.play();
        return true;
      } catch (err) {
        if ((err as DOMException).name !== 'NotAllowedError') return true;
        video.muted = true;
        try {
          await video.play();
        } catch {
          /* still blocked; the tap-to-play overlay handles it */
        }
        return false;
      }
    },
    pause: () => video.pause(),
    seek: (t) => {
      if (!live) video.currentTime = t;
    },
    setRate: (r) => {
      if (!live && Math.abs(video.playbackRate - r) > 0.001) video.playbackRate = r;
    },
    getTime: () => video.currentTime,
    getDuration: () => (Number.isFinite(video.duration) ? video.duration : 0),
    isPlaying: () => !video.paused && !video.ended,
    setVolume: (v) => {
      video.volume = Math.max(0, Math.min(1, v));
    },
    setMuted: (m) => {
      video.muted = m;
    },
    isMuted: () => video.muted,
    destroy: () => {
      destroyed = true;
      hls?.destroy();
      video.pause();
      video.removeAttribute('src');
      video.srcObject = null;
      video.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      host.replaceChildren();
    },
  };
}
