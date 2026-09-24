/**
 * Measures who is talking, from the voice streams already arriving.
 * Drives the speaking ring on avatars and ducks the video under a voice.
 */
export class SpeakingMeter {
  private ctx: AudioContext | null = null;
  private meters = new Map<string, { analyser: AnalyserNode; source: MediaStreamAudioSourceNode; level: number; lastLoud: number }>();
  private timer: number | undefined;
  private listeners = new Set<() => void>();
  private speaking: ReadonlySet<string> = new Set();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSpeaking = () => this.speaking;

  /** `streams`: member id → voice stream (including this device's own mic). */
  track(streams: Map<string, MediaStream>) {
    if (streams.size > 0 && !this.ctx) {
      this.ctx = new AudioContext();
      this.timer = window.setInterval(() => this.sample(), 100);
    }
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});

    for (const [id, meter] of this.meters) {
      const s = streams.get(id);
      if (!s || meter.source.mediaStream !== s) {
        meter.source.disconnect();
        this.meters.delete(id);
      }
    }
    for (const [id, stream] of streams) {
      if (this.meters.has(id) || stream.getAudioTracks().length === 0) continue;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser); // analysed only; playback goes through <audio> elements
      this.meters.set(id, { analyser, source, level: 0, lastLoud: 0 });
    }
  }

  private buffer = new Float32Array(512);

  private sample() {
    const now = performance.now();
    const next = new Set<string>();
    for (const [id, m] of this.meters) {
      m.analyser.getFloatTimeDomainData(this.buffer);
      let sum = 0;
      for (const v of this.buffer) sum += v * v;
      const rms = Math.sqrt(sum / this.buffer.length);
      m.level = m.level * 0.6 + rms * 0.4;
      if (m.level > 0.02) m.lastLoud = now;
      // Hold for a moment so the ring does not flicker between words.
      if (now - m.lastLoud < 450) next.add(id);
    }
    const same = next.size === this.speaking.size && [...next].every((id) => this.speaking.has(id));
    if (!same) {
      this.speaking = next;
      this.listeners.forEach((fn) => fn());
    }
  }

  destroy() {
    window.clearInterval(this.timer);
    for (const m of this.meters.values()) m.source.disconnect();
    this.meters.clear();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.listeners.clear();
  }
}

export async function openMic(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
}

export function canBroadcastScreen(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

export async function openScreen(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    // Chrome and Edge offer "Share tab audio"; Firefox and Safari share video only.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MediaTrackConstraints,
    // Chrome hints: prefer a tab, keep this tab out of the list, let the user switch tabs mid-broadcast.
    ...({ preferCurrentTab: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include' } as object),
  } as DisplayMediaStreamOptions);
}

/** A playing <video> as a stream. Safari has no captureStream on media elements. */
export function captureVideo(video: HTMLVideoElement): MediaStream | null {
  const v = video as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
  return v.captureStream?.() ?? v.mozCaptureStream?.() ?? null;
}
