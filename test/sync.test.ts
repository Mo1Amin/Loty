import { describe, expect, it } from 'vitest';
import { ClockSync, correction, formatTime, parseClock, POLICY_COARSE, POLICY_SMOOTH, positionAt } from '../shared/sync.ts';
import type { PlaybackState } from '../shared/protocol.ts';

const base: PlaybackState = { itemId: 'a', playing: true, position: 10, rate: 1, updatedAt: 1_000, rev: 1 };

describe('positionAt', () => {
  it('advances while playing, at the room speed', () => {
    expect(positionAt(base, 3_000)).toBe(12);
    expect(positionAt({ ...base, rate: 1.5 }, 3_000)).toBe(13);
  });
  it('holds still while paused', () => {
    expect(positionAt({ ...base, playing: false }, 9_000)).toBe(10);
  });
  it('never goes backwards when the clock estimate is slightly behind', () => {
    expect(positionAt(base, 900)).toBe(10);
  });
});

describe('ClockSync', () => {
  it('prefers fast round trips over recent ones', () => {
    const c = new ClockSync(1);
    c.add(0, 5_050, 100);      // rtt 100 → offset 5000
    c.add(1_000, 7_000, 1_900); // rtt 900 → offset 5550, less trustworthy
    expect(c.offset).toBe(5_000);
    expect(c.serverNow(10)).toBe(5_010);
  });
});

describe('correction', () => {
  it('leaves small drift alone', () => {
    expect(correction(10.05, 10, 1, POLICY_SMOOTH)).toEqual({ type: 'rate', rate: 1 });
    expect(correction(10.5, 10, 1, POLICY_COARSE)).toEqual({ type: 'none' });
  });
  it('slows a player that is slightly ahead instead of jumping', () => {
    const c = correction(10.6, 10, 1, POLICY_SMOOTH);
    expect(c.type).toBe('rate');
    if (c.type === 'rate') expect(c.rate).toBeLessThan(1);
  });
  it('speeds up a player that is slightly behind, within the nudge cap', () => {
    const c = correction(9, 10, 1, POLICY_SMOOTH);
    expect(c).toEqual({ type: 'rate', rate: 1.08 });
  });
  it('seeks when far off', () => {
    expect(correction(20, 10, 1, POLICY_SMOOTH)).toEqual({ type: 'seek', to: 10 });
    expect(correction(11, 10, 1, POLICY_COARSE)).toEqual({ type: 'seek', to: 10 });
  });
});

describe('clock text', () => {
  it('formats and parses', () => {
    expect(formatTime(3723)).toBe('1:02:03');
    expect(formatTime(65)).toBe('1:05');
    expect(parseClock('1:02:03')).toBe(3723);
    expect(parseClock('12:05')).toBe(725);
    expect(parseClock('12:75')).toBeNull();
    expect(parseClock('hello')).toBeNull();
  });
});
