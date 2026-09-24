import { randomBytes, randomInt } from 'node:crypto';
import {
  LIMITS,
  type ChatMessage,
  type ErrorCode,
  type Member,
  type NewItem,
  type PlayCommand,
  type PlaybackState,
  type QueueItem,
  type QueueMode,
  type RoomSettings,
  type RoomSnapshot,
} from '../shared/protocol.ts';
import { positionAt } from '../shared/sync.ts';

// A room is plain state plus the rules for changing it. Nothing in here knows
// about sockets, so the rules can be tested without a network.

// No 0/O, 1/I/L: codes get read aloud and typed on phones.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const HOLD_LIMIT_MS = 8_000;
const HUES = [211, 145, 28, 340, 270, 180, 48, 0, 300, 100, 230, 15];

export interface MemberRecord extends Member {
  secret: string;
  socketId: string | null;
  joinedAt: number;
  offlineSince: number | null;
  bufferingSince: number | null;
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; code: ErrorCode };

const fail = (code: ErrorCode, error: string): { ok: false; error: string; code: ErrorCode } => ({ ok: false, code, error });

export function newId(bytes = 9): string {
  return randomBytes(bytes).toString('base64url');
}

export function newRoomCode(taken: (code: string) => boolean): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!taken(code)) return code;
  }
}

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

export function cleanName(input: unknown): string {
  const name = typeof input === 'string' ? input.replace(/\s+/g, ' ').trim() : '';
  return [...name].slice(0, LIMITS.nameLength).join('') || 'ضيف';
}

/** Titles the client sets before the real one is known. */
export function isPlaceholderTitle(title: string): boolean {
  return title === 'بدون عنوان' || /^فيديو \d+ من البلاي ليست$/.test(title);
}

export class Room {
  readonly code: string;
  settings: RoomSettings = { control: 'everyone', waitForBuffering: true, locked: false };
  members = new Map<string, MemberRecord>();
  queue: QueueItem[] = [];
  playback: PlaybackState = { itemId: null, playing: false, position: 0, rate: 1, updatedAt: 0, rev: 0 };
  chat: ChatMessage[] = [];
  /** Knocking sockets waiting for the host, by knock id. */
  knocks = new Map<string, { name: string; socketId: string }>();
  emptySince: number | null = null;
  private holdSince = 0;
  /** After giving up on a slow connection, do not hold again straight away. */
  private noHoldUntil = 0;

  constructor(code: string) {
    this.code = code;
  }

  // ── Membership ────────────────────────────────────────────────────────────

  addMember(name: string, socketId: string, now: number): MemberRecord {
    const usedHues = new Set([...this.members.values()].map((m) => m.hue));
    const hue = HUES.find((h) => !usedHues.has(h)) ?? HUES[this.members.size % HUES.length]!;
    const member: MemberRecord = {
      id: newId(),
      secret: newId(18),
      name: cleanName(name),
      hue,
      isHost: this.members.size === 0,
      online: true,
      buffering: false,
      micOn: false,
      streams: {},
      socketId,
      joinedAt: now,
      offlineSince: null,
      bufferingSince: null,
    };
    this.members.set(member.id, member);
    this.emptySince = null;
    this.notice(`${member.name} دخل الغرفة`, now);
    return member;
  }

  canJoin(): Result {
    if (this.onlineCount() >= LIMITS.membersPerRoom) return fail('full', `الغرفة فيها ${LIMITS.membersPerRoom} أشخاص، وده أقصى عدد.`);
    return { ok: true };
  }

  resume(memberId: string, secret: string, socketId: string, _now: number): Result<{ member: MemberRecord }> {
    const member = this.members.get(memberId);
    if (!member || member.secret !== secret) return fail('expired', 'الجلسة القديمة انتهت. ادخل الغرفة من جديد.');
    member.socketId = socketId;
    member.online = true;
    member.offlineSince = null;
    this.emptySince = null;
    return { ok: true, member };
  }

  /** The socket dropped. The seat is kept for a while so a reload or a tunnel does not cost the host role. */
  disconnect(memberId: string, now: number): void {
    const member = this.members.get(memberId);
    if (!member) return;
    member.online = false;
    member.socketId = null;
    member.offlineSince = now;
    member.micOn = false;
    member.streams = {};
    this.setBuffering(memberId, false, now);
    this.endBroadcastsBy(memberId, now);
    if (this.onlineCount() === 0) this.emptySince = now;
  }

  remove(memberId: string, now: number, reason: 'left' | 'kicked' | 'timeout'): void {
    const member = this.members.get(memberId);
    if (!member) return;
    this.members.delete(memberId);
    this.endBroadcastsBy(memberId, now);
    this.notice(reason === 'kicked' ? `${member.name} اتشال من الغرفة` : `${member.name} خرج`, now);
    if (member.isHost) this.promoteNextHost(now);
    if (this.onlineCount() === 0) this.emptySince ??= now;
  }

  /** Drops members whose grace period ran out. Returns true when anything changed. */
  expireOffline(now: number): boolean {
    let changed = false;
    for (const m of [...this.members.values()]) {
      if (!m.online && m.offlineSince !== null && now - m.offlineSince > LIMITS.resumeGraceMs) {
        this.remove(m.id, now, 'timeout');
        changed = true;
      }
    }
    // A host who is away should not freeze a room that has people in it.
    const host = this.host();
    if (host && !host.online && host.offlineSince !== null && now - host.offlineSince > 20_000 && this.onlineCount() > 0) {
      this.promoteNextHost(now);
      changed = true;
    }
    return changed;
  }

  transferHost(fromId: string, toId: string, now: number): Result {
    const from = this.members.get(fromId);
    const to = this.members.get(toId);
    if (!from?.isHost) return fail('forbidden', 'المضيف بس اللي يقدر ينقل الإدارة.');
    if (!to || to.id === from.id) return fail('invalid', 'الشخص ده مش في الغرفة.');
    from.isHost = false;
    to.isHost = true;
    this.notice(`${to.name} بقى المضيف`, now);
    return { ok: true };
  }

  private promoteNextHost(now: number): void {
    const candidates = [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const next = candidates.find((m) => m.online) ?? candidates[0];
    for (const m of this.members.values()) m.isHost = false;
    if (next) {
      next.isHost = true;
      this.notice(`${next.name} بقى المضيف`, now);
    }
  }

  host(): MemberRecord | undefined {
    for (const m of this.members.values()) if (m.isHost) return m;
    return undefined;
  }

  onlineCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.online) n++;
    return n;
  }

  /** Whether this member may drive playback and reshape the queue. */
  canControl(memberId: string): boolean {
    const m = this.members.get(memberId);
    return !!m && (this.settings.control === 'everyone' || m.isHost);
  }

  updateSettings(memberId: string, patch: Partial<RoomSettings>): Result {
    if (!this.members.get(memberId)?.isHost) return fail('forbidden', 'المضيف بس اللي يغيّر الإعدادات.');
    if (patch.control === 'everyone' || patch.control === 'host') this.settings.control = patch.control;
    if (typeof patch.waitForBuffering === 'boolean') this.settings.waitForBuffering = patch.waitForBuffering;
    if (typeof patch.locked === 'boolean') this.settings.locked = patch.locked;
    return { ok: true };
  }

  // ── Playback ──────────────────────────────────────────────────────────────

  command(memberId: string, c: PlayCommand, now: number): Result {
    if (!this.canControl(memberId)) return fail('forbidden', 'المضيف بس اللي بيتحكم في التشغيل دلوقتي.');
    if (c.itemId !== this.playback.itemId) return fail('invalid', 'الفيديو اتغيّر قبل ما الأمر يوصل.');
    const position = Number(c.position);
    if (!Number.isFinite(position) || position < 0 || position > 60 * 60 * 48) return fail('invalid', 'وقت غير صالح.');
    const p = this.playback;
    switch (c.type) {
      case 'play':
        this.setPlayback({ playing: true, position, holdFor: undefined }, now);
        break;
      case 'pause':
        this.setPlayback({ playing: false, position, holdFor: undefined }, now);
        break;
      case 'seek':
        this.setPlayback({ position }, now);
        break;
      case 'rate': {
        const rate = Number(c.rate);
        if (!Number.isFinite(rate) || rate < 0.25 || rate > 2) return fail('invalid', 'السرعة لازم تكون بين 0.25 و 2.');
        this.setPlayback({ rate, position: positionAt(p, now) }, now);
        break;
      }
    }
    return { ok: true };
  }

  private setPlayback(patch: Partial<Omit<PlaybackState, 'rev' | 'updatedAt'>>, now: number): void {
    const next: PlaybackState = { ...this.playback, ...patch, updatedAt: now, rev: this.playback.rev + 1 };
    if (next.holdFor === undefined) delete next.holdFor;
    this.playback = next;
  }

  private startItem(item: QueueItem | undefined, now: number, startAt = 0): void {
    for (const m of this.members.values()) {
      m.buffering = false;
      m.bufferingSince = null;
    }
    if (!item) {
      this.setPlayback({ itemId: null, playing: false, position: 0, rate: 1, holdFor: undefined }, now);
      return;
    }
    this.setPlayback({ itemId: item.id, playing: true, position: startAt, rate: 1, holdFor: undefined }, now);
  }

  /** Someone's player reached the end. Every client reports it, so only the first report for the current item counts. */
  ended(itemId: string, now: number): boolean {
    if (itemId !== this.playback.itemId) return false;
    const current = this.queue[0];
    if (current?.source.kind === 'broadcast') return false;
    this.advance(now);
    return true;
  }

  private advance(now: number): void {
    this.queue.shift();
    this.startItem(this.queue[0], now);
  }

  setBuffering(memberId: string, buffering: boolean, now: number): void {
    const m = this.members.get(memberId);
    if (!m) return;
    m.buffering = buffering;
    m.bufferingSince = buffering ? (m.bufferingSince ?? now) : null;
  }

  /**
   * Holds the room while someone has been buffering for `after` ms, and lets it
   * go once nobody is. Returns true when the playback state changed.
   */
  evaluateHold(now: number, after = 1_200): boolean {
    const p = this.playback;
    const current = this.queue[0];
    if (!p.itemId || current?.source.kind === 'broadcast') return false;

    // One slow connection should not hold everyone hostage: wait a while, then carry on
    // and let that player catch up by seeking once it has data.
    if (p.holdFor && now - this.holdSince >= HOLD_LIMIT_MS) {
      this.noHoldUntil = now + 20_000;
      this.setPlayback({ playing: true, holdFor: undefined }, now);
      return true;
    }
    const stuck = [...this.members.values()].find(
      (m) => m.online && m.bufferingSince !== null && now - m.bufferingSince >= after,
    );
    // Waiting only makes sense for someone else: alone, your own player simply catches up.
    if (this.settings.waitForBuffering && p.playing && stuck && now >= this.noHoldUntil && this.onlineCount() > 1) {
      this.holdSince = now;
      this.setPlayback({ playing: false, position: positionAt(p, now), holdFor: stuck.name }, now);
      return true;
    }
    const anyBuffering = [...this.members.values()].some((m) => m.online && m.buffering);
    if (p.holdFor && !anyBuffering) {
      this.setPlayback({ playing: true, holdFor: undefined }, now);
      return true;
    }
    return false;
  }

  // ── Queue ─────────────────────────────────────────────────────────────────

  addItems(memberId: string, items: NewItem[], mode: QueueMode, now: number): Result<{ ids: string[] }> {
    const member = this.members.get(memberId);
    if (!member) return fail('invalid', 'انت مش في الغرفة.');
    // Anyone may suggest something for the end of the queue; jumping the line is a control action.
    if (mode !== 'end' && !this.canControl(memberId)) return fail('forbidden', 'المضيف بس اللي يقدر يشغّل حاجة دلوقتي. تقدر تضيفها لآخر القايمة.');
    if (!Array.isArray(items) || items.length === 0) return fail('invalid', 'مفيش حاجة تتضاف.');
    const room = LIMITS.queueItems - this.queue.length + (mode === 'now' && this.queue.length > 0 ? 1 : 0);
    if (room <= 0) return fail('full', `القايمة فيها ${LIMITS.queueItems} عنصر، ده الحد الأقصى.`);

    const fresh: QueueItem[] = items.slice(0, room).map((it) => {
      const q: QueueItem = {
        id: newId(6),
        source: it.source,
        title: String(it.title ?? '').slice(0, 200) || 'بدون عنوان',
        addedBy: member.name,
      };
      if (it.thumb) q.thumb = String(it.thumb).slice(0, 500);
      if (typeof it.duration === 'number' && Number.isFinite(it.duration)) q.duration = it.duration;
      return q;
    });
    const startAt = Number(items[0]?.startAt) || 0;
    const idle = this.playback.itemId === null;

    if (mode === 'now') {
      // The interrupted item is dropped, not pushed back: "play this now" means now.
      if (!idle) this.queue.shift();
      this.queue.unshift(...fresh);
      this.startItem(this.queue[0], now, startAt);
    } else if (mode === 'next' && !idle) {
      this.queue.splice(1, 0, ...fresh);
    } else {
      this.queue.push(...fresh);
      if (idle) this.startItem(this.queue[0], now, this.queue[0] === fresh[0] ? startAt : 0);
    }
    return { ok: true, ids: fresh.map((f) => f.id) };
  }

  removeItem(memberId: string, id: string, now: number): Result {
    if (!this.canControl(memberId)) return fail('forbidden', 'المضيف بس اللي يعدّل القايمة.');
    const index = this.queue.findIndex((q) => q.id === id);
    if (index < 0) return fail('invalid', 'العنصر ده مش في القايمة.');
    if (index === 0 && this.playback.itemId === id) this.advance(now);
    else this.queue.splice(index, 1);
    return { ok: true };
  }

  /** Reorders what comes next. The item that is playing stays first. */
  moveItems(memberId: string, order: string[]): Result {
    if (!this.canControl(memberId)) return fail('forbidden', 'المضيف بس اللي يرتّب القايمة.');
    const playing = this.playback.itemId ? this.queue[0] : undefined;
    const upcoming = playing ? this.queue.slice(1) : this.queue;
    const wanted = order.filter((id) => id !== playing?.id);
    if (wanted.length !== upcoming.length || new Set(wanted).size !== wanted.length) return fail('invalid', 'الترتيب ده قديم، حاول تاني.');
    const byId = new Map(upcoming.map((q) => [q.id, q]));
    const sorted = wanted.map((id) => byId.get(id));
    if (sorted.some((q) => !q)) return fail('invalid', 'الترتيب ده قديم، حاول تاني.');
    this.queue = [...(playing ? [playing] : []), ...(sorted as QueueItem[])];
    return { ok: true };
  }

  playItem(memberId: string, id: string, now: number): Result {
    if (!this.canControl(memberId)) return fail('forbidden', 'المضيف بس اللي يغيّر اللي شغّال.');
    const index = this.queue.findIndex((q) => q.id === id);
    if (index < 0) return fail('invalid', 'العنصر ده مش في القايمة.');
    if (index === 0 && this.playback.itemId === id) return { ok: true };
    const [item] = this.queue.splice(index, 1);
    if (this.playback.itemId) this.queue.shift();
    this.queue.unshift(item!);
    this.startItem(item, now);
    return { ok: true };
  }

  skip(memberId: string, now: number): Result {
    if (!this.canControl(memberId)) return fail('forbidden', 'المضيف بس اللي يقدر يتخطّى.');
    if (!this.playback.itemId) return fail('invalid', 'مفيش حاجة شغّالة.');
    this.advance(now);
    return { ok: true };
  }

  /** Clients fill in titles and durations once their player knows them. */
  setMeta(id: string, meta: { title?: string; duration?: number; thumb?: string }): boolean {
    const item = this.queue.find((q) => q.id === id);
    if (!item) return false;
    let changed = false;
    if (meta.title && (isPlaceholderTitle(item.title) || item.title.startsWith('http') || item.source.kind === 'youtube')) {
      const title = String(meta.title).slice(0, 200);
      if (title !== item.title) {
        item.title = title;
        changed = true;
      }
    }
    if (typeof meta.duration === 'number' && Number.isFinite(meta.duration) && meta.duration > 0 && item.duration !== meta.duration) {
      item.duration = meta.duration;
      changed = true;
    }
    return changed;
  }

  startBroadcast(memberId: string, label: string, from: 'screen' | 'file', now: number): Result<{ itemId: string }> {
    const member = this.members.get(memberId);
    if (!member) return fail('invalid', 'انت مش في الغرفة.');
    if (!this.canControl(memberId)) return fail('forbidden', 'المضيف بس اللي يقدر يبث دلوقتي.');
    this.endBroadcastsBy(memberId, now, false);
    const res = this.addItems(
      memberId,
      [{ source: { kind: 'broadcast', hostId: memberId, label: cleanName(label) || 'بث', from }, title: String(label).slice(0, 200) || (from === 'file' ? 'ملف' : 'شاشة') }],
      'now',
      now,
    );
    if (!res.ok) return res;
    return { ok: true, itemId: res.ids[0]! };
  }

  endBroadcastsBy(memberId: string, now: number, advanceIfCurrent = true): void {
    const isMine = (q: QueueItem) => q.source.kind === 'broadcast' && q.source.hostId === memberId;
    const current = this.queue[0];
    const currentIsMine = !!current && this.playback.itemId === current.id && isMine(current);
    this.queue = this.queue.filter((q, i) => (i === 0 && currentIsMine) || !isMine(q));
    if (currentIsMine) {
      if (advanceIfCurrent) this.advance(now);
      else this.queue.shift();
    }
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

  say(memberId: string, text: string, replyTo: string | undefined, now: number): Result<{ message: ChatMessage }> {
    const m = this.members.get(memberId);
    if (!m) return fail('invalid', 'انت مش في الغرفة.');
    const clean = String(text ?? '').trim().slice(0, LIMITS.chatLength);
    if (!clean) return fail('invalid', 'الرسالة فاضية.');
    const message: ChatMessage = { id: newId(6), at: now, from: m.id, name: m.name, hue: m.hue, text: clean };
    const target = replyTo ? this.chat.find((c) => c.id === replyTo) : undefined;
    if (target) message.replyTo = { id: target.id, name: target.name, text: target.text.slice(0, 120) };
    this.pushChat(message);
    return { ok: true, message };
  }

  private notice(text: string, now: number): void {
    const message: ChatMessage = { id: newId(6), at: now, from: null, name: '', hue: 0, text };
    this.pushChat(message);
  }

  private pushChat(message: ChatMessage): void {
    this.chat.push(message);
    if (this.chat.length > LIMITS.chatHistory) this.chat.splice(0, this.chat.length - LIMITS.chatHistory);
  }

  snapshot(): RoomSnapshot {
    const members: Member[] = [...this.members.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map(({ id, name, hue, isHost, online, buffering, micOn, streams }) => ({ id, name, hue, isHost, online, buffering, micOn, streams }));
    return {
      code: this.code,
      settings: { ...this.settings },
      members,
      queue: this.queue,
      playback: this.playback,
      chat: this.chat,
    };
  }
}
