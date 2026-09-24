import type { Player, PlayerEvents } from './types.ts';

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<typeof YT> | null = null;

export function loadYouTubeApi(): Promise<typeof YT> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.async = true;
    tag.onerror = () => {
      apiPromise = null;
      reject(new Error('YouTube could not be reached'));
    };
    document.head.appendChild(tag);
  });
  return apiPromise;
}

function describeError(code: number, id: string): { message: string; embedBlocked?: boolean; openUrl?: string } {
  const openUrl = `https://www.youtube.com/watch?v=${id}`;
  switch (code) {
    case 101:
    case 150:
      return { message: 'صاحب الفيديو مانع تشغيله برا يوتيوب.', embedBlocked: true, openUrl };
    case 100:
      return { message: 'الفيديو ده اتشال أو بقى خاص.', openUrl };
    case 153:
      return { message: 'يوتيوب رفض التشغيل لأن الصفحة مش باعتة مصدرها. افتح Loty من رابطه الأصلي مش من ملف محلي.', openUrl };
    case 2:
      return { message: 'رابط الفيديو فيه مشكلة.', openUrl };
    default:
      return { message: 'يوتيوب مش قادر يشغّل الفيديو ده على الجهاز ده.', embedBlocked: true, openUrl };
  }
}

export async function createYouTubePlayer(host: HTMLElement, id: string, startAt: number, events: PlayerEvents): Promise<Player> {
  const api = await loadYouTubeApi();
  const mount = document.createElement('div');
  host.appendChild(mount);

  let playing = false;
  let destroyed = false;
  let lastVolume = 100;

  const yt = await new Promise<YT.Player>((resolve) => {
    const p: YT.Player = new api.Player(mount, {
      videoId: id,
      width: '100%',
      height: '100%',
      playerVars: {
        playsinline: 1,
        rel: 0,
        iv_load_policy: 3,
        enablejsapi: 1,
        origin: location.origin,
        start: Math.floor(startAt),
        autoplay: 0,
      },
      events: {
        onReady: () => resolve(p),
        onStateChange: (e) => {
          if (destroyed) return;
          const S = api.PlayerState;
          switch (e.data) {
            case S.PLAYING:
              playing = true;
              events.buffering(false);
              events.play();
              emitMeta();
              break;
            case S.PAUSED:
              playing = false;
              events.buffering(false);
              events.pause();
              break;
            case S.BUFFERING:
              events.buffering(true);
              break;
            case S.ENDED:
              playing = false;
              events.buffering(false);
              events.ended();
              break;
            case S.CUED:
              emitMeta();
              break;
          }
        },
        onError: (e) => {
          if (!destroyed) events.error(describeError(Number(e.data), id));
        },
      },
    });
  });

  const iframe = yt.getIframe();
  iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
  iframe.title = 'YouTube';

  function emitMeta() {
    const data = (yt as unknown as { getVideoData?: () => { title?: string; isLive?: boolean } }).getVideoData?.();
    const duration = yt.getDuration();
    events.meta({ ...(data?.title ? { title: data.title } : {}), ...(duration > 0 ? { duration } : {}) });
  }

  return {
    smooth: false,
    get live() {
      const data = (yt as unknown as { getVideoData?: () => { isLive?: boolean } }).getVideoData?.();
      return !!data?.isLive;
    },
    async play() {
      yt.playVideo();
      // The iframe cannot tell us autoplay was refused; if it has not started shortly, assume it was.
      const started = await new Promise<boolean>((resolve) => {
        const began = Date.now();
        const check = () => {
          const s = yt.getPlayerState();
          if (s === api.PlayerState.PLAYING) return resolve(true);
          if (s === api.PlayerState.BUFFERING && Date.now() - began < 6_000) return void setTimeout(check, 200);
          if (Date.now() - began > 1_500) return resolve(false);
          setTimeout(check, 150);
        };
        check();
      });
      if (started || destroyed) return started;
      // Muted autoplay is always allowed; the room keeps going and we ask for a tap to unmute.
      yt.mute();
      yt.playVideo();
      return false;
    },
    pause: () => yt.pauseVideo(),
    seek: (t) => yt.seekTo(t, true),
    setRate: (r) => {
      if (yt.getPlaybackRate() !== r) yt.setPlaybackRate(r);
    },
    getTime: () => yt.getCurrentTime() || 0,
    getDuration: () => yt.getDuration() || 0,
    isPlaying: () => playing,
    setVolume: (v) => {
      const next = Math.round(Math.max(0, Math.min(1, v)) * 100);
      if (next !== lastVolume) yt.setVolume(next);
      lastVolume = next;
    },
    setMuted: (m) => (m ? yt.mute() : yt.unMute()),
    isMuted: () => yt.isMuted(),
    destroy: () => {
      destroyed = true;
      try {
        yt.destroy();
      } catch {
        /* already gone */
      }
      mount.remove();
      host.replaceChildren();
    },
  };
}
