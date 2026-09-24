import { io, type Socket } from 'socket.io-client';
import type {
  ChatMessage,
  ClientToServer,
  NewItem,
  PlayCommand,
  PlaybackState,
  QueueMode,
  RoomSettings,
  RoomSnapshot,
  ServerToClient,
  Session,
} from '../../../shared/protocol.ts';
import { ClockSync } from '../../../shared/sync.ts';

export type Phase =
  | { name: 'idle' }
  | { name: 'joining' }
  | { name: 'knocking'; code: string }
  | { name: 'in-room' }
  | { name: 'gone'; reason: string };

export interface ClientState {
  phase: Phase;
  connected: boolean;
  room: RoomSnapshot | null;
  me: string | null;
  /** member id → last time they typed (local clock) */
  typing: Record<string, number>;
  knocks: { id: string; name: string }[];
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
type Listener = () => void;

const SESSION_KEY = 'loty.session';

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function saveSession(s: Session | null) {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode: a reload will simply ask to join again */
  }
}

/**
 * The one connection to the server. React reads it through `useClient`;
 * players and WebRTC subscribe to the typed events directly.
 */
export class RoomClient {
  readonly socket: Socket<ServerToClient, ClientToServer>;
  readonly clock = new ClockSync();
  private state: ClientState = { phase: { name: 'idle' }, connected: false, room: null, me: null, typing: {}, knocks: [] };
  private listeners = new Set<Listener>();
  private session: Session | null = loadSession();
  private pingTimer: number | undefined;

  readonly onPlayback = new Set<(p: PlaybackState) => void>();
  readonly onChat = new Set<(m: ChatMessage) => void>();
  readonly onReact = new Set<(r: { emoji: string; from: string; hue: number }) => void>();

  constructor() {
    this.socket = io({ transports: ['websocket', 'polling'], autoConnect: true });
    const s = this.socket;

    s.on('connect', () => {
      this.set({ connected: true });
      void this.measureClock(6);
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => void this.measureClock(2), 20_000);
      if (this.session) void this.resume(this.session);
    });
    s.on('disconnect', () => this.set({ connected: false }));

    s.on('room:state', (room) => {
      this.set({ room });
      this.onPlayback.forEach((fn) => fn(room.playback));
    });
    s.on('play:state', (playback) => {
      const room = this.state.room;
      if (!room || playback.rev < room.playback.rev) return; // arrived after something newer
      this.set({ room: { ...room, playback } });
      this.onPlayback.forEach((fn) => fn(playback));
    });
    s.on('chat:message', (m) => {
      const room = this.state.room;
      if (!room || room.chat.some((c) => c.id === m.id)) return;
      const typing = { ...this.state.typing };
      if (m.from) delete typing[m.from];
      this.set({ room: { ...room, chat: [...room.chat, m].slice(-150) }, typing });
      this.onChat.forEach((fn) => fn(m));
    });
    s.on('chat:typing', ({ id }) => this.set({ typing: { ...this.state.typing, [id]: Date.now() } }));
    s.on('react', (r) => this.onReact.forEach((fn) => fn(r)));
    s.on('knock:request', (k) => {
      if (!this.state.knocks.some((x) => x.id === k.id)) this.set({ knocks: [...this.state.knocks, k] });
    });
    s.on('knock:cancel', ({ id }) => this.set({ knocks: this.state.knocks.filter((k) => k.id !== id) }));
    s.on('knock:result', ({ accepted, session }) => {
      if (accepted && session) void this.resume(session);
      else this.set({ phase: { name: 'gone', reason: 'المضيف ما دخّلكش المرة دي.' } });
    });
    s.on('kicked', () => {
      this.forget();
      this.set({ phase: { name: 'gone', reason: 'المضيف شالك من الغرفة.' }, room: null, me: null });
    });
  }

  // ── store plumbing for useSyncExternalStore ──
  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = () => this.state;
  private set(patch: Partial<ClientState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  get me() {
    const { room, me } = this.state;
    return room?.members.find((m) => m.id === me) ?? null;
  }

  get canControl() {
    const room = this.state.room;
    const me = this.me;
    return !!room && !!me && (room.settings.control === 'everyone' || me.isHost);
  }

  hasSessionFor(code: string) {
    return this.session?.code === code.toUpperCase();
  }

  private async measureClock(samples: number) {
    for (let i = 0; i < samples; i++) {
      await new Promise<void>((resolve) => {
        const t0 = Date.now();
        const timer = window.setTimeout(resolve, 3_000);
        this.socket.emit('clock:ping', t0, (serverNow) => {
          this.clock.add(t0, serverNow, Date.now());
          window.clearTimeout(timer);
          resolve();
        });
      });
      if (i < samples - 1) await new Promise((r) => setTimeout(r, 120));
    }
  }

  private call<T extends object>(fn: (ack: (res: Result<T>) => void) => void, timeoutMs = 8_000): Promise<Result<T>> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => resolve({ ok: false, error: 'السيرفر مش بيرد. اتأكد من الإنترنت.' }), timeoutMs);
      fn((res) => {
        window.clearTimeout(timer);
        resolve(res);
      });
    });
  }

  // ── lifecycle ──
  async create(name: string): Promise<Result> {
    this.set({ phase: { name: 'joining' } });
    const res = await this.call<{ session: Session }>((ack) => this.socket.emit('room:create', { name }, ack as never));
    if (!res.ok) {
      this.set({ phase: { name: 'idle' } });
      return res;
    }
    this.adopt(res.session);
    return { ok: true };
  }

  async join(code: string, name: string): Promise<Result> {
    this.set({ phase: { name: 'joining' } });
    const res = await this.call<{ session?: Session; waiting?: true }>((ack) => this.socket.emit('room:join', { code, name }, ack as never));
    if (!res.ok) {
      this.set({ phase: { name: 'idle' } });
      return res;
    }
    if (res.waiting) this.set({ phase: { name: 'knocking', code } });
    else if (res.session) this.adopt(res.session);
    return { ok: true };
  }

  private async resume(session: Session) {
    const res = await this.call((ack) => this.socket.emit('room:resume', session, ack as never));
    if (res.ok) this.adopt(session);
    else {
      this.forget();
      this.set({ phase: { name: 'gone', reason: res.error }, room: null, me: null });
    }
  }

  private adopt(session: Session) {
    this.session = session;
    saveSession(session);
    this.set({ phase: { name: 'in-room' }, me: session.memberId });
  }

  private forget() {
    this.session = null;
    saveSession(null);
  }

  leave() {
    this.socket.emit('room:leave');
    this.forget();
    this.set({ phase: { name: 'idle' }, room: null, me: null, knocks: [], typing: {} });
  }

  reset() {
    this.set({ phase: { name: 'idle' } });
  }

  // ── actions ──
  command(c: PlayCommand) {
    return this.call((ack) => this.socket.emit('play:command', c, ack as never));
  }
  ended(itemId: string) {
    this.socket.emit('play:ended', { itemId });
  }
  buffering(buffering: boolean) {
    this.socket.emit('play:buffering', { buffering });
  }
  add(items: NewItem[], mode: QueueMode) {
    return this.call<{ ids: string[] }>((ack) => this.socket.emit('queue:add', { items, mode }, ack as never));
  }
  remove(id: string) {
    return this.call((ack) => this.socket.emit('queue:remove', { id }, ack as never));
  }
  move(order: string[]) {
    return this.call((ack) => this.socket.emit('queue:move', { order }, ack as never));
  }
  playItem(id: string) {
    return this.call((ack) => this.socket.emit('queue:play', { id }, ack as never));
  }
  skip() {
    return this.call((ack) => this.socket.emit('queue:skip', ack as never));
  }
  meta(id: string, meta: { title?: string; duration?: number }) {
    this.socket.emit('queue:meta', { id, ...meta });
  }
  say(text: string, replyTo?: string) {
    return this.call((ack) => this.socket.emit('chat:send', replyTo ? { text, replyTo } : { text }, ack as never));
  }
  typing() {
    this.socket.emit('chat:typing');
  }
  react(emoji: string) {
    this.socket.emit('react', { emoji });
  }
  rename(name: string) {
    return this.call((ack) => this.socket.emit('member:rename', { name }, ack as never));
  }
  media(p: { micOn?: boolean; streams?: { voice?: string; screen?: string } }) {
    this.socket.emit('member:media', p);
  }
  transferHost(id: string) {
    return this.call((ack) => this.socket.emit('host:transfer', { id }, ack as never));
  }
  kick(id: string) {
    return this.call((ack) => this.socket.emit('host:kick', { id }, ack as never));
  }
  settings(patch: Partial<RoomSettings>) {
    return this.call((ack) => this.socket.emit('host:settings', patch, ack as never));
  }
  answerKnock(id: string, accept: boolean) {
    this.socket.emit('host:knock', { id, accept });
    this.set({ knocks: this.state.knocks.filter((k) => k.id !== id) });
  }
  startBroadcast(label: string, from: 'screen' | 'file') {
    return this.call<{ itemId: string }>((ack) => this.socket.emit('broadcast:start', { label, from }, ack as never));
  }
  stopBroadcast() {
    this.socket.emit('broadcast:stop');
  }
}

export const client = new RoomClient();
