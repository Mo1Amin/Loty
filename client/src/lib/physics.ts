// Gesture physics shared by the sheet, the mini player and anything else you can throw.

/**
 * Where a throw would come to rest, given release velocity in px/s.
 * Same exponential decay UIScrollView uses (deceleration rate 0.998 per ms).
 */
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Resistance past an edge: follows the finger less and less, never stops dead. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  const sign = Math.sign(overshoot);
  const x = Math.abs(overshoot);
  return sign * (1 - 1 / ((x * constant) / dimension + 1)) * dimension;
}

/** The target closest to where the motion would have ended. */
export function nearest<T extends { x: number; y: number }>(targets: T[], x: number, y: number): T {
  let best = targets[0]!;
  let bestD = Infinity;
  for (const t of targets) {
    const d = (t.x - x) ** 2 + (t.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/**
 * Spring settings in Motion's terms, mapped from Apple's (damping ratio, response).
 * bounce = 1 − damping ratio; visualDuration ≈ response.
 */
export const springs = {
  /** Reposition: critically damped, no bounce. */
  move: { type: 'spring', bounce: 0, visualDuration: 0.4 },
  /** Sheets and drawers. */
  sheet: { type: 'spring', bounce: 0, visualDuration: 0.32 },
  /** Small UI: thumbs, pills, toggles. */
  snappy: { type: 'spring', bounce: 0, visualDuration: 0.22 },
} as const;

/** Bounce only when the gesture carried momentum: a flick earns a little, a slow drop none. */
export function bounceFor(velocity: number): number {
  return Math.min(0.2, Math.abs(velocity) / 5000);
}

/** Tracks pointer velocity over the last ~100 ms, the way UIKit does. */
export class VelocityTracker {
  private samples: { t: number; x: number; y: number }[] = [];

  add(x: number, y: number, t = performance.now()) {
    this.samples.push({ t, x, y });
    while (this.samples.length > 2 && t - this.samples[0]!.t > 100) this.samples.shift();
  }

  reset() {
    this.samples = [];
  }

  /** px/s */
  get(): { x: number; y: number } {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.t === first.t) return { x: 0, y: 0 };
    const dt = (last.t - first.t) / 1000;
    return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
  }
}
