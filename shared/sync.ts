import type { PlaybackState } from './protocol.ts';

/** Where the room is right now, given the server's clock. */
export function positionAt(state: PlaybackState, serverNow: number): number {
  if (!state.playing) return state.position;
  const elapsed = Math.max(0, serverNow - state.updatedAt) / 1000;
  return state.position + elapsed * state.rate;
}

/**
 * Estimates the offset between this device's clock and the server's, NTP style.
 * A sample taken over a slow round trip is less trustworthy, so we keep the
 * few fastest and average those instead of trusting the latest.
 */
export class ClockSync {
  private samples: { rtt: number; offset: number }[] = [];
  private readonly keep: number;

  constructor(keep = 5) {
    this.keep = keep;
  }

  add(t0: number, serverNow: number, t1: number): void {
    const rtt = Math.max(0, t1 - t0);
    const offset = serverNow - (t0 + rtt / 2);
    this.samples.push({ rtt, offset });
    this.samples.sort((a, b) => a.rtt - b.rtt);
    if (this.samples.length > this.keep * 3) this.samples.length = this.keep * 3;
  }

  get ready(): boolean {
    return this.samples.length > 0;
  }

  get rtt(): number {
    return this.samples[0]?.rtt ?? 0;
  }

  get offset(): number {
    const best = this.samples.slice(0, this.keep);
    if (best.length === 0) return 0;
    return best.reduce((s, x) => s + x.offset, 0) / best.length;
  }

  serverNow(localNow: number = Date.now()): number {
    return localNow + this.offset;
  }
}

export type Correction =
  | { type: 'none' }
  | { type: 'seek'; to: number }
  | { type: 'rate'; rate: number };

export interface CorrectionPolicy {
  /** Below this, leave it alone: the eye cannot tell. */
  deadband: number;
  /** Above this, jump. Between the two, nudge the speed if the player allows it. */
  seekAbove: number;
  canNudgeRate: boolean;
  /** Largest speed change used while catching up, as a fraction of 1x. */
  maxNudge: number;
}

export const POLICY_SMOOTH: CorrectionPolicy = { deadband: 0.12, seekAbove: 1.5, canNudgeRate: true, maxNudge: 0.08 };
/**
 * YouTube and Vimeo only take coarse speeds, so they seek once the drift is visible.
 * The band is wider because every seek there costs a short rebuffer of its own.
 */
export const POLICY_COARSE: CorrectionPolicy = { deadband: 0.75, seekAbove: 0.75, canNudgeRate: false, maxNudge: 0 };

/**
 * Decides how to bring a player back in line.
 * `local` is where the player is, `target` where the room is, `baseRate` the room's speed.
 * Speed nudging closes the gap in about two seconds without a visible jump.
 */
export function correction(local: number, target: number, baseRate: number, policy: CorrectionPolicy): Correction {
  const drift = local - target; // positive = this player is ahead
  const abs = Math.abs(drift);
  if (abs <= policy.deadband) return policy.canNudgeRate ? { type: 'rate', rate: baseRate } : { type: 'none' };
  if (abs > policy.seekAbove || !policy.canNudgeRate) return { type: 'seek', to: Math.max(0, target) };
  const nudge = Math.min(policy.maxNudge, abs / 2);
  return { type: 'rate', rate: baseRate * (drift > 0 ? 1 - nudge : 1 + nudge) };
}

/** "1:02:03", "12:05", "0:07" */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Reads "1:02:03" or "12:05" back into seconds; null when it is not a timestamp. */
export function parseClock(text: string): number | null {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [, h, mm, ss] = m;
  if (Number(ss) >= 60 || (h !== undefined && Number(mm) >= 60)) return null;
  return Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss);
}
