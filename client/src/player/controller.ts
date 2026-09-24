import type { MediaSource, PlaybackState, QueueItem } from '../../../shared/protocol.ts';
import { correction, POLICY_COARSE, POLICY_SMOOTH, positionAt } from '../../../shared/sync.ts';
import type { RoomClient } from '../lib/room-client.ts';
import { createHtml5Player } from './html5.ts';
import type { Player, PlayerError, PlayerEvents } from './types.ts';
import { createVimeoPlayer } from './vimeo.ts';
import { createYouTubePlayer } from './youtube.ts';

export interface StageStatus {
  loading: boolean;
  error: PlayerError | null;
  /** The browser blocked sound (or playback); one tap fixes it. */
  needsTap: boolean;
  /** A "local" item: this person still has to open the file. */
  needsFile: { name: string; size: number } | null;
  /** A broadcast whose stream has not arrived yet. */
  waitingForStream: boolean;
  sync: 'idle' | 'synced' | 'catching-up' | 'buffering' | 'live';
  drift: number;
}

const initialStatus: StageStatus = { loading: false, error: null, needsTap: false, needsFile: null, waitingForStream: false, sync: 'idle', drift: 0 };

export interface ControllerDeps {
  client: RoomClient;
  /** Remote broadcast stream from a member, if it has arrived. */
  remoteScreen(memberId: string): MediaStream | null;
  /** This device's own outgoing broadcast. */
  localBroadcast(): { stream?: MediaStream; file?: File } | null;
  /** Called with the <video> of a file broadcast so it can be captured and sent. */
  onBroadcastVideo(video: HTMLVideoElement | null): void;
  toast(message: string): void;
}

/**
 * Keeps one player in step with the room.
 *
 * The room state is the truth. The player is made to match it; anything the
 * player does that does not match, and that we did not cause in the last
 * moment, is a person using the player's own controls — that becomes a command.
 */
export class SyncController {
  private readonly host: HTMLElement;
  private readonly deps: ControllerDeps;
  private item: QueueItem | null = null;
  private itemKey = '';
  private player: Player | null = null;
  private playback: PlaybackState | null = null;
  private generation = 0;
  private status: StageStatus = initialStatus;
  private listeners = new Set<() => void>();
  private timer: number;

  /** Player events before this moment are echoes of our own calls. */
  private ownUntil = 0;
  /** After a person acts, give the server a moment to agree before correcting them. */
  private userUntil = 0;
  private lastSeekAt = 0;
  private buffering = false;
  private sawBuffering = false;
  private prev: { local: number; wall: number } | null = null;
  private metaSent = new Map<string, string>();
  private files = new Map<string, File>();
  private baseVolume: number | null = null;
  private duckFactor = 1;

  constructor(host: HTMLElement, deps: ControllerDeps) {
    this.host = host;
    this.deps = deps;
    this.timer = window.setInterval(() => this.tick(), 400);
  }

  // ── status store for React ──
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getStatus = () => this.status;
  private setStatus(patch: Partial<StageStatus>) {
    const next = { ...this.status, ...patch };
    if (Object.keys(patch).every((k) => this.status[k as keyof StageStatus] === next[k as keyof StageStatus])) return;
    this.status = next;
    this.listeners.forEach((fn) => fn());
  }

  get video(): HTMLVideoElement | null {
    return this.player?.video ?? null;
  }

  // ── inputs ──
  update(item: QueueItem | null, playback: PlaybackState) {
    this.playback = playback;
    const key = item ? this.keyFor(item) : '';
    if (key !== this.itemKey) {
      this.itemKey = key;
      this.item = item;
      void this.load();
      return;
    }
    this.item = item;
    this.apply();
  }

  /** Streams changed (a broadcast arrived or ended); rebuild if that changes what we show. */
  refresh() {
    if (!this.item) return;
    const key = this.keyFor(this.item);
    if (key !== this.itemKey) {
      this.itemKey = key;
      void this.load();
    }
  }

  openFile(file: File) {
    const need = this.status.needsFile;
    if (!need) return;
    if (file.size !== need.size) this.deps.toast(`الملف ده مختلف عن اللي عند الباقي (${need.name}). هيشتغل، بس المزامنة ممكن تبوظ.`);
    this.files.set(`${need.name}|${need.size}`, file);
    this.setStatus({ needsFile: null });
    void this.load();
  }

  async unlock() {
    const p = this.player;
    if (!p) return;
    p.setMuted(false);
    this.mark();
    const ok = await p.play();
    this.setStatus({ needsTap: !ok });
    if (ok && this.playback && !this.playback.playing && !p.live) {
      this.mark();
      p.pause();
    }
    this.apply();
  }

  /** Lowers the video while someone is talking; 1 restores it. */
  duck(factor: number) {
    const p = this.player;
    if (!p || factor === this.duckFactor) return;
    if (this.duckFactor === 1) this.baseVolume = 1;
    this.duckFactor = factor;
    p.setVolume((this.baseVolume ?? 1) * factor);
  }

  destroy() {
    window.clearInterval(this.timer);
    this.generation++;
    this.player?.destroy();
    this.player = null;
    this.deps.onBroadcastVideo(null);
    this.listeners.clear();
  }

  // ── loading ──
  private keyFor(item: QueueItem): string {
    const s = item.source;
    if (s.kind === 'broadcast') {
      const mine = s.hostId === this.deps.client.getState().me;
      const stream = mine ? this.deps.localBroadcast()?.stream?.id ?? 'file' : this.deps.remoteScreen(s.hostId)?.id ?? 'none';
      return `${item.id}:${stream}`;
    }
    if (s.kind === 'local') return `${item.id}:${this.files.has(`${s.name}|${s.size}`) ? 'file' : 'none'}`;
    return item.id;
  }

  private async load() {
    const gen = ++this.generation;
    this.player?.destroy();
    this.player = null;
    this.deps.onBroadcastVideo(null);
    this.prev = null;
    this.duckFactor = 1;
    this.setBuffering(false);

    const item = this.item;
    if (!item) {
      this.setStatus({ ...initialStatus });
      return;
    }
    this.setStatus({ ...initialStatus, loading: true });
    const startAt = this.playback && this.playback.itemId === item.id ? positionAt(this.playback, this.deps.client.clock.serverNow()) : 0;

    try {
      const player = await this.create(item.source, startAt);
      if (gen !== this.generation) {
        player?.destroy();
        return;
      }
      if (!player) return; // status already explains why
      this.player = player;
      this.setStatus({ loading: false, sync: player.live ? 'live' : 'synced' });
      if (item.source.kind === 'broadcast' && item.source.from === 'file' && player.video && this.isMine(item.source)) {
        this.deps.onBroadcastVideo(player.video);
      }
      this.apply(true);
    } catch (err) {
      if (gen !== this.generation) return;
      console.error(err);
      this.setStatus({ loading: false, error: { message: 'المشغّل ما اشتغلش. اتأكد من الإنترنت وجرّب تاني.' } });
    }
  }

  private isMine(s: Extract<MediaSource, { kind: 'broadcast' }>) {
    return s.hostId === this.deps.client.getState().me;
  }

  private async create(source: MediaSource, startAt: number): Promise<Player | null> {
    const events = this.events();
    switch (source.kind) {
      case 'youtube':
        return createYouTubePlayer(this.host, source.id, startAt, events);
      case 'vimeo':
        return createVimeoPlayer(this.host, source.id, source.hash, startAt, events);
      case 'direct':
        return createHtml5Player(this.host, { type: 'url', url: source.url, hls: source.format === 'hls' }, startAt, events);
      case 'local': {
        const file = this.files.get(`${source.name}|${source.size}`);
        if (!file) {
          this.setStatus({ loading: false, needsFile: { name: source.name, size: source.size } });
          return null;
        }
        return createHtml5Player(this.host, { type: 'file', file }, startAt, events);
      }
      case 'broadcast': {
        if (this.isMine(source)) {
          const local = this.deps.localBroadcast();
          if (source.from === 'file' && local?.file) return createHtml5Player(this.host, { type: 'file', file: local.file }, 0, events);
          if (local?.stream) return createHtml5Player(this.host, { type: 'stream', stream: local.stream, muted: true }, 0, events);
          this.setStatus({ loading: false, waitingForStream: true });
          return null;
        }
        const stream = this.deps.remoteScreen(source.hostId);
        if (!stream) {
          this.setStatus({ loading: false, waitingForStream: true });
          return null;
        }
        return createHtml5Player(this.host, { type: 'stream', stream }, 0, events);
      }
    }
  }

  // ── applying the room to the player ──
  private mark(ms = 1_200) {
    this.ownUntil = performance.now() + ms;
  }

  private get isOwn() {
    return performance.now() < this.ownUntil;
  }

  private get isFileBroadcaster() {
    const s = this.item?.source;
    return s?.kind === 'broadcast' && s.from === 'file' && this.isMine(s);
  }

  private apply(initial = false) {
    const p = this.player;
    const state = this.playback;
    const item = this.item;
    if (!p || !state || !item || state.itemId !== item.id) return;
    if (performance.now() < this.userUntil && !initial) return;

    if (item.source.kind === 'broadcast') {
      // Live: nothing to align, just make sure it is running. The file broadcaster drives their own video.
      if (!this.isFileBroadcaster && !p.isPlaying()) void this.startPlaying();
      else if (this.isFileBroadcaster && initial) void this.startPlaying();
      return;
    }

    const target = positionAt(state, this.deps.client.clock.serverNow());
    p.setRate(state.rate);
    if (state.playing) {
      if (Math.abs(p.getTime() - target) > 0.6) this.seek(target);
      if (!p.isPlaying()) void this.startPlaying();
    } else {
      if (p.isPlaying()) {
        this.mark();
        p.pause();
      }
      if (Math.abs(p.getTime() - state.position) > 0.25) this.seek(state.position);
      this.setStatus({ sync: 'synced', drift: 0 });
    }
  }

  private seek(t: number) {
    const p = this.player;
    if (!p) return;
    this.mark();
    this.lastSeekAt = performance.now();
    // Embedded players land a little late after a seek; aim slightly ahead.
    p.seek(p.smooth ? t : t + 0.2);
    this.prev = null;
  }

  private async startPlaying() {
    const p = this.player;
    if (!p) return;
    this.mark(2_000);
    const withSound = await p.play();
    if (p === this.player) this.setStatus({ needsTap: !withSound });
  }

  private tick() {
    const p = this.player;
    const state = this.playback;
    const item = this.item;
    if (!p || !state || !item || state.itemId !== item.id || item.source.kind === 'broadcast' || p.live) return;
    if (this.status.needsTap && !p.isPlaying()) return;

    const now = performance.now();
    const local = p.getTime();
    this.detectUserSeek(local, now, state);

    if (now < this.userUntil || this.buffering) return;
    if (!state.playing) {
      // A pause that arrived while we were deferring to the person's own action still has to land.
      if (p.isPlaying() && !this.isOwn) this.apply(true);
      return;
    }
    if (!p.isPlaying() && !this.isOwn) {
      void this.startPlaying();
      return;
    }
    const target = positionAt(state, this.deps.client.clock.serverNow());
    const drift = local - target;
    const cooldown = p.smooth ? 1_000 : 3_000;
    if (now - this.lastSeekAt < cooldown) {
      this.setStatus({ sync: 'catching-up', drift });
      return;
    }
    const c = correction(local, target, state.rate, p.smooth ? POLICY_SMOOTH : POLICY_COARSE);
    if (c.type === 'seek') this.seek(c.to);
    else if (c.type === 'rate') p.setRate(c.rate);
    const close = Math.abs(drift) < (p.smooth ? 0.25 : 0.8);
    this.setStatus({ sync: close ? 'synced' : 'catching-up', drift });
  }

  /** YouTube has no seek event, so a jump in its clock that we did not cause is a person scrubbing. */
  private detectUserSeek(local: number, wall: number, state: PlaybackState) {
    const p = this.player!;
    const prev = this.prev;
    this.prev = { local, wall };
    if (!prev || p.smooth || this.isOwn || this.sawBuffering) {
      this.sawBuffering = this.buffering;
      return;
    }
    this.sawBuffering = this.buffering;
    const advanced = p.isPlaying() ? ((wall - prev.wall) / 1000) * state.rate : 0;
    const jump = local - prev.local - advanced;
    if (Math.abs(jump) > 2) this.userAction('seek', local);
  }

  // ── what the player tells us ──
  private events(): PlayerEvents {
    const fromCurrent = (fn: () => void) => () => {
      if (this.player || this.status.loading) fn();
    };
    return {
      play: fromCurrent(() => {
        this.setStatus({ needsTap: this.player?.isMuted() ? this.status.needsTap : false });
        if (this.isOwn || this.playback?.playing || this.isLiveItem()) return;
        this.userAction('play', this.player?.getTime() ?? 0);
      }),
      pause: fromCurrent(() => {
        if (this.isOwn || this.isLiveItem()) return;
        // Paused while the room was only waiting for someone: that wait becomes a real pause.
        if (!this.playback?.playing && !this.playback?.holdFor) return;
        this.userAction('pause', this.player?.getTime() ?? 0);
      }),
      seeked: (time) => {
        if (this.isOwn || this.isLiveItem()) return;
        this.userAction('seek', time);
      },
      buffering: (on) => this.setBuffering(on),
      ended: () => {
        const item = this.item;
        if (item && !this.isLiveItem()) this.deps.client.ended(item.id);
      },
      error: (error) => {
        this.setStatus({ loading: false, error });
        this.setBuffering(false);
      },
      meta: (meta) => {
        const item = this.item;
        if (!item) return;
        const sig = `${meta.title ?? ''}|${Math.round(meta.duration ?? 0)}`;
        if (this.metaSent.get(item.id) === sig) return;
        this.metaSent.set(item.id, sig);
        this.deps.client.meta(item.id, meta);
      },
    };
  }

  private isLiveItem() {
    return this.item?.source.kind === 'broadcast' || !!this.player?.live;
  }

  private setBuffering(on: boolean) {
    if (on) this.sawBuffering = true;
    if (on === this.buffering) return;
    this.buffering = on;
    if (!this.isLiveItem()) this.deps.client.buffering(on);
    if (on) this.setStatus({ sync: 'buffering' });
  }

  private userAction(type: 'play' | 'pause' | 'seek', position: number) {
    const item = this.item;
    const state = this.playback;
    if (!item || !state) return;
    if (!this.deps.client.canControl) {
      this.deps.toast('المضيف بس اللي بيتحكم في التشغيل دلوقتي.');
      this.userUntil = 0;
      this.apply(true);
      return;
    }
    this.userUntil = performance.now() + 1_500;
    this.prev = null;
    void this.deps.client.command({ type, position: Math.max(0, position), itemId: item.id }).then((res) => {
      if (!res.ok) {
        this.userUntil = 0;
        this.apply(true);
      }
    });
  }

  /** Commands from the app's own buttons (keyboard, speed menu). */
  togglePlay() {
    const p = this.player;
    const state = this.playback;
    if (!p || !state || this.isLiveItem()) return;
    const type = state.playing ? 'pause' : 'play';
    this.mark();
    if (type === 'pause') p.pause();
    else void p.play();
    this.userAction(type, p.getTime());
  }

  seekBy(delta: number) {
    const p = this.player;
    if (!p || this.isLiveItem()) return;
    const to = Math.max(0, p.getTime() + delta);
    this.seek(to);
    this.userAction('seek', to);
  }

  seekTo(time: number) {
    const p = this.player;
    if (!p || this.isLiveItem()) return;
    this.seek(time);
    this.userAction('seek', time);
  }

  setMuted(muted: boolean) {
    this.player?.setMuted(muted);
  }

  isMuted() {
    return this.player?.isMuted() ?? false;
  }

  currentTime() {
    return this.player?.getTime() ?? 0;
  }

  /** Internal state for diagnosing sync in the field (enable with sessionStorage 'loty.debug'). */
  debug() {
    const p = this.player;
    return {
      item: this.item?.id ?? null,
      playback: this.playback,
      playing: p?.isPlaying() ?? null,
      time: p?.getTime() ?? null,
      muted: p?.isMuted() ?? null,
      buffering: this.buffering,
      ownFor: Math.round(this.ownUntil - performance.now()),
      userFor: Math.round(this.userUntil - performance.now()),
      status: this.status,
    };
  }
}
