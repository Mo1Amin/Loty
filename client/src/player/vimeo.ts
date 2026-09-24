import type { Player, PlayerEvents } from './types.ts';

/** Vimeo's API is async everywhere; we mirror its time locally so the sync loop can read it synchronously. */
export async function createVimeoPlayer(host: HTMLElement, id: string, hash: string | undefined, startAt: number, events: PlayerEvents): Promise<Player> {
  const { default: VimeoPlayer } = await import('@vimeo/player');
  const mount = document.createElement('div');
  mount.className = 'stage-embed';
  host.appendChild(mount);

  const url = `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ''}`;
  const vp = new VimeoPlayer(mount, { url: url as `https://player.vimeo.com/video/${string}`, playsinline: true, responsive: false, dnt: true, width: 640 });
  let time = startAt;
  let timeAt = performance.now();
  let playing = false;
  let rate = 1;
  let duration = 0;
  let muted = false;

  vp.on('timeupdate', (d: { seconds: number; duration: number }) => {
    time = d.seconds;
    timeAt = performance.now();
    duration = d.duration;
  });
  vp.on('play', () => {
    playing = true;
    events.play();
  });
  vp.on('pause', () => {
    playing = false;
    events.pause();
  });
  vp.on('seeked', (d: { seconds: number }) => {
    time = d.seconds;
    timeAt = performance.now();
    events.seeked(d.seconds);
  });
  vp.on('bufferstart', () => events.buffering(true));
  vp.on('bufferend', () => events.buffering(false));
  vp.on('ended', () => {
    playing = false;
    events.ended();
  });
  vp.on('error', (e: { name?: string }) => {
    events.error({
      message: e.name === 'PrivacyError' ? 'الفيديو ده خاص أو ممنوع تشغيله برا Vimeo.' : 'Vimeo مش قادر يشغّل الفيديو ده.',
      embedBlocked: e.name === 'PrivacyError',
      openUrl: `https://vimeo.com/${id}${hash ? `/${hash}` : ''}`,
    });
  });

  await vp.ready();
  const iframe = mount.querySelector('iframe');
  if (iframe) iframe.style.cssText = 'width:100%;height:100%;border:0';
  vp.getVideoTitle().then((title: string) => events.meta({ title })).catch(() => {});
  vp.getDuration().then((d: number) => {
    duration = d;
    events.meta({ duration: d });
  }).catch(() => {});
  if (startAt > 0) await vp.setCurrentTime(startAt).catch(() => {});

  return {
    smooth: false,
    live: false,
    async play() {
      try {
        await vp.play();
        return true;
      } catch {
        await vp.setMuted(true).catch(() => {});
        muted = true;
        await vp.play().catch(() => {});
        return false;
      }
    },
    pause: () => void vp.pause().catch(() => {}),
    seek: (t) => {
      time = t;
      timeAt = performance.now();
      void vp.setCurrentTime(t).catch(() => {});
    },
    setRate: (r) => {
      if (r === rate) return;
      rate = r;
      void vp.setPlaybackRate(r).catch(() => {}); // Pro-only on some videos; the room still syncs by seeking
    },
    getTime: () => (playing ? time + ((performance.now() - timeAt) / 1000) * rate : time),
    getDuration: () => duration,
    isPlaying: () => playing,
    setVolume: (v) => void vp.setVolume(Math.max(0, Math.min(1, v))).catch(() => {}),
    setMuted: (m) => {
      muted = m;
      void vp.setMuted(m).catch(() => {});
    },
    isMuted: () => muted,
    destroy: () => {
      void vp.destroy().catch(() => {});
      host.replaceChildren();
    },
  };
}
