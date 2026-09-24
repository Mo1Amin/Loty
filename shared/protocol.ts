// The contract between the server and every client. Both sides import this
// file, so a field renamed here breaks the build instead of breaking a room.

export type MediaSource =
  | { kind: 'youtube'; id: string }
  | { kind: 'vimeo'; id: string; hash?: string }
  | { kind: 'direct'; url: string; format: 'video' | 'hls' | 'audio' }
  /** Every member opens the same file from their own disk; only time is synced. */
  | { kind: 'local'; name: string; size: number }
  /** One member streams a tab, a window, or a file to everyone over WebRTC. */
  | { kind: 'broadcast'; hostId: string; label: string; from: 'screen' | 'file' };

export interface QueueItem {
  id: string;
  source: MediaSource;
  title: string;
  thumb?: string;
  duration?: number;
  addedBy: string;
}

export interface PlaybackState {
  itemId: string | null;
  playing: boolean;
  /** Seconds into the item at `updatedAt`. */
  position: number;
  rate: number;
  /** Server clock, ms. Clients add their measured offset before comparing. */
  updatedAt: number;
  /** Set when the room paused itself to wait for someone who is buffering. */
  holdFor?: string;
  /** Bumped on every change so a client can drop a stale state that arrived late. */
  rev: number;
}

export interface Member {
  id: string;
  name: string;
  hue: number;
  isHost: boolean;
  online: boolean;
  buffering: boolean;
  micOn: boolean;
  /** MediaStream ids this member is sending, so receivers know what a track is. */
  streams: { voice?: string; screen?: string };
}

export interface RoomSettings {
  /** Who may play, pause, seek and change the queue. */
  control: 'everyone' | 'host';
  /** Pause the room while anyone is buffering, then resume together. */
  waitForBuffering: boolean;
  /** New people knock and the host lets them in. */
  locked: boolean;
}

export interface ChatMessage {
  id: string;
  at: number;
  from: string | null; // null = system notice
  name: string;
  hue: number;
  text: string;
  replyTo?: { id: string; name: string; text: string };
}

export interface RoomSnapshot {
  code: string;
  settings: RoomSettings;
  members: Member[];
  queue: QueueItem[];
  playback: PlaybackState;
  chat: ChatMessage[];
}

export interface Session {
  code: string;
  memberId: string;
  secret: string;
}

export type Ack<T = object> = (res: ({ ok: true } & T) | { ok: false; error: string; code?: ErrorCode }) => void;

export type ErrorCode = 'not-found' | 'full' | 'locked' | 'denied' | 'forbidden' | 'rate' | 'invalid' | 'expired';

export type PlayCommand =
  | { type: 'play'; position: number; itemId: string }
  | { type: 'pause'; position: number; itemId: string }
  | { type: 'seek'; position: number; itemId: string }
  | { type: 'rate'; rate: number; position: number; itemId: string };

export type QueueMode = 'now' | 'next' | 'end';

export interface NewItem {
  source: MediaSource;
  title: string;
  thumb?: string;
  duration?: number;
  startAt?: number;
}

export type RtcSignal =
  | { description: RTCSessionDescriptionInit }
  | { candidate: RTCIceCandidateInit | null };

export interface ClientToServer {
  'room:create': (p: { name: string }, ack: Ack<{ session: Session }>) => void;
  'room:join': (p: { code: string; name: string }, ack: Ack<{ session: Session } | { waiting: true }>) => void;
  'room:resume': (p: Session, ack: Ack) => void;
  'room:leave': () => void;
  'clock:ping': (t0: number, ack: (serverNow: number) => void) => void;

  'play:command': (c: PlayCommand, ack?: Ack) => void;
  'play:ended': (p: { itemId: string }) => void;
  'play:buffering': (p: { buffering: boolean }) => void;

  'queue:add': (p: { items: NewItem[]; mode: QueueMode }, ack: Ack<{ ids: string[] }>) => void;
  'queue:remove': (p: { id: string }, ack?: Ack) => void;
  'queue:move': (p: { order: string[] }, ack?: Ack) => void;
  'queue:play': (p: { id: string }, ack?: Ack) => void;
  'queue:skip': (ack?: Ack) => void;
  'queue:meta': (p: { id: string; title?: string; duration?: number; thumb?: string }) => void;

  'chat:send': (p: { text: string; replyTo?: string }, ack?: Ack) => void;
  'chat:typing': () => void;
  react: (p: { emoji: string }) => void;

  'member:rename': (p: { name: string }, ack?: Ack) => void;
  'member:media': (p: { micOn?: boolean; streams?: Member['streams'] }) => void;
  'host:transfer': (p: { id: string }, ack?: Ack) => void;
  'host:kick': (p: { id: string }, ack?: Ack) => void;
  'host:settings': (p: Partial<RoomSettings>, ack?: Ack) => void;
  'host:knock': (p: { id: string; accept: boolean }) => void;

  'broadcast:start': (p: { label: string; from: 'screen' | 'file' }, ack: Ack<{ itemId: string }>) => void;
  'broadcast:stop': () => void;

  'rtc:signal': (p: { to: string; signal: RtcSignal }) => void;
}

export interface ServerToClient {
  'room:state': (s: RoomSnapshot) => void;
  'play:state': (s: PlaybackState) => void;
  'chat:message': (m: ChatMessage) => void;
  'chat:typing': (p: { id: string }) => void;
  react: (p: { emoji: string; from: string; hue: number }) => void;
  'knock:request': (p: { id: string; name: string }) => void;
  'knock:cancel': (p: { id: string }) => void;
  'knock:result': (p: { accepted: boolean; session?: Session }) => void;
  kicked: () => void;
  'rtc:signal': (p: { from: string; signal: RtcSignal }) => void;
}

export const LIMITS = {
  membersPerRoom: 12,
  queueItems: 300,
  chatHistory: 120,
  chatLength: 500,
  nameLength: 24,
  /** How long a dropped member keeps their seat (and host role) before it is released. */
  resumeGraceMs: 90_000,
  /** How long an empty room survives, so a reload does not destroy it. */
  emptyRoomTtlMs: 5 * 60_000,
} as const;

export const REACTIONS = ['❤️', '😂', '😮', '😢', '🔥', '👏'] as const;
