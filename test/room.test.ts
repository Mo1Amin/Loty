import { describe, expect, it } from 'vitest';
import { LIMITS, type NewItem } from '../shared/protocol.ts';
import { normalizeCode, Room } from '../server/room.ts';

const yt = (id: string): NewItem => ({ source: { kind: 'youtube', id: id.padEnd(11, 'x') }, title: id });

function setup() {
  const room = new Room('ABCDEF');
  const host = room.addMember('Mo', 's1', 0);
  const guest = room.addMember('Sara', 's2', 1);
  return { room, host, guest };
}

describe('membership', () => {
  it('makes the first member host and gives each a distinct colour', () => {
    const { host, guest } = setup();
    expect(host.isHost).toBe(true);
    expect(guest.isHost).toBe(false);
    expect(host.hue).not.toBe(guest.hue);
  });

  it('keeps the seat through a reload, and only with the right secret', () => {
    const { room, guest } = setup();
    room.disconnect(guest.id, 10);
    expect(room.resume(guest.id, 'wrong', 's3', 11).ok).toBe(false);
    expect(room.resume(guest.id, guest.secret, 's3', 11).ok).toBe(true);
    expect(room.members.get(guest.id)?.online).toBe(true);
  });

  it('hands the host role on when the host leaves', () => {
    const { room, host, guest } = setup();
    room.remove(host.id, 5, 'left');
    expect(room.members.get(guest.id)?.isHost).toBe(true);
  });

  it('hands it on when the host has been away too long, but not immediately', () => {
    const { room, host, guest } = setup();
    room.disconnect(host.id, 0);
    room.expireOffline(5_000);
    expect(room.members.get(guest.id)?.isHost).toBe(false);
    room.expireOffline(25_000);
    expect(room.members.get(guest.id)?.isHost).toBe(true);
    room.expireOffline(LIMITS.resumeGraceMs + 1);
    expect(room.members.has(host.id)).toBe(false);
  });

  it('refuses the thirteenth person', () => {
    const room = new Room('X');
    for (let i = 0; i < LIMITS.membersPerRoom; i++) room.addMember(`m${i}`, `s${i}`, i);
    expect(room.canJoin()).toMatchObject({ ok: false, code: 'full' });
  });

  it('normalizes typed codes', () => {
    expect(normalizeCode(' ab-cd ef ')).toBe('ABCDEF');
  });
});

describe('queue', () => {
  it('starts playing the first thing added to an idle room', () => {
    const { room, host } = setup();
    room.addItems(host.id, [yt('a'), yt('b')], 'end', 100);
    expect(room.playback).toMatchObject({ itemId: room.queue[0]!.id, playing: true, position: 0 });
    expect(room.queue).toHaveLength(2);
  });

  it('inserts "next" right after what is playing', () => {
    const { room, host } = setup();
    room.addItems(host.id, [yt('a'), yt('b')], 'end', 0);
    room.addItems(host.id, [yt('c')], 'next', 0);
    expect(room.queue.map((q) => q.title)).toEqual(['a', 'c', 'b']);
  });

  it('"now" replaces what is playing and honours a start time', () => {
    const { room, host } = setup();
    room.addItems(host.id, [yt('a'), yt('b')], 'end', 0);
    room.addItems(host.id, [{ ...yt('c'), startAt: 42 }], 'now', 0);
    expect(room.queue.map((q) => q.title)).toEqual(['c', 'b']);
    expect(room.playback.position).toBe(42);
  });

  it('advances once per item even when every client reports the end', () => {
    const { room, host } = setup();
    room.addItems(host.id, [yt('a'), yt('b'), yt('c')], 'end', 0);
    const first = room.playback.itemId!;
    expect(room.ended(first, 10)).toBe(true);
    expect(room.ended(first, 11)).toBe(false);
    expect(room.queue.map((q) => q.title)).toEqual(['b', 'c']);
  });

  it('keeps the playing item first when reordering', () => {
    const { room, host } = setup();
    const { ids } = room.addItems(host.id, [yt('a'), yt('b'), yt('c')], 'end', 0) as { ids: string[] };
    expect(room.moveItems(host.id, [ids[2]!, ids[0]!, ids[1]!]).ok).toBe(true);
    expect(room.queue.map((q) => q.title)).toEqual(['a', 'c', 'b']);
    expect(room.moveItems(host.id, [ids[1]!]).ok).toBe(false);
  });

  it('in host-only mode guests can still suggest, but not jump the line', () => {
    const { room, host, guest } = setup();
    room.updateSettings(host.id, { control: 'host' });
    expect(room.addItems(guest.id, [yt('a')], 'now', 0)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(room.addItems(guest.id, [yt('a')], 'end', 0).ok).toBe(true);
    expect(room.command(guest.id, { type: 'pause', position: 3, itemId: room.playback.itemId! }, 0).ok).toBe(false);
  });
});

describe('playback', () => {
  it('rejects commands aimed at an item that is no longer playing', () => {
    const { room, host } = setup();
    room.addItems(host.id, [yt('a'), yt('b')], 'end', 0);
    const old = room.playback.itemId!;
    room.skip(host.id, 1);
    expect(room.command(host.id, { type: 'pause', position: 5, itemId: old }, 2).ok).toBe(false);
  });

  it('bumps the revision on every change', () => {
    const { room, host } = setup();
    room.addItems(host.id, [yt('a')], 'end', 0);
    const rev = room.playback.rev;
    room.command(host.id, { type: 'seek', position: 30, itemId: room.playback.itemId! }, 1);
    expect(room.playback.rev).toBe(rev + 1);
  });

  it('waits for someone buffering, then resumes by itself', () => {
    const { room, host, guest } = setup();
    room.addItems(host.id, [yt('a')], 'end', 0);
    room.setBuffering(guest.id, true, 1_000);
    expect(room.evaluateHold(1_500)).toBe(false); // a blip is not worth a pause
    expect(room.evaluateHold(2_300)).toBe(true);
    expect(room.playback).toMatchObject({ playing: false, holdFor: 'Sara' });
    room.setBuffering(guest.id, false, 3_000);
    expect(room.evaluateHold(3_000)).toBe(true);
    expect(room.playback.playing).toBe(true);
    expect(room.playback.holdFor).toBeUndefined();
  });

  it('does not resume a pause somebody chose', () => {
    const { room, host, guest } = setup();
    room.addItems(host.id, [yt('a')], 'end', 0);
    room.command(host.id, { type: 'pause', position: 5, itemId: room.playback.itemId! }, 10);
    room.setBuffering(guest.id, false, 11);
    expect(room.evaluateHold(12)).toBe(false);
    expect(room.playback.playing).toBe(false);
  });
});

describe('broadcast', () => {
  it('plays now and ends when the broadcaster drops', () => {
    const { room, host } = setup();
    room.addItems(host.id, [yt('a')], 'end', 0);
    room.startBroadcast(host.id, 'Chrome tab', 'screen', 1);
    expect(room.queue[0]!.source.kind).toBe('broadcast');
    room.disconnect(host.id, 2);
    expect(room.queue.some((q) => q.source.kind === 'broadcast')).toBe(false);
  });
});

describe('chat', () => {
  it('trims, caps and threads replies', () => {
    const { room, host, guest } = setup();
    const first = room.say(host.id, '  hi  ', undefined, 0);
    if (!first.ok) throw new Error('first message refused');
    expect(first.message.text).toBe('hi');
    const reply = room.say(guest.id, 'x'.repeat(900), first.message.id, 1);
    if (!reply.ok) throw new Error('reply refused');
    expect(reply.message.text).toHaveLength(LIMITS.chatLength);
    expect(reply.message.replyTo?.name).toBe('Mo');
    expect(room.say(host.id, '   ', undefined, 2).ok).toBe(false);
  });
});
