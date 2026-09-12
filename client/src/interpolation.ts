// Buffered interpolation for remote cursors.
//
// Instead of snapping to the latest received point (which teleports under
// jitter) or extrapolating past it (which guesses at the unknown), each
// remote peer's positions are buffered and rendered ~120ms in the past,
// interpolated between the two real received points that bracket that
// render time. Tradeoff: +120ms perceived latency, in exchange for motion
// that's always smooth and never snaps/teleports.

export interface TimedPoint {
  x: number;
  y: number;
  t: number; // client-side send timestamp (Date.now() at the sender)
}

const BUFFER_CAP = 5;
export const DEFAULT_RENDER_DELAY_MS = 120;

export class InterpolationBuffer {
  private points: TimedPoint[] = [];

  push(point: TimedPoint): void {
    this.points.push(point);
    // Keep buffer bounded — no unbounded growth, and old points beyond the
    // cap are useless once we're rendering deeper into the timeline anyway.
    if (this.points.length > BUFFER_CAP) {
      this.points.shift();
    }
  }

  get latest(): TimedPoint | null {
    return this.points.length ? this.points[this.points.length - 1] : null;
  }

  get isEmpty(): boolean {
    return this.points.length === 0;
  }

  getInterpolatedPosition(renderDelay: number = DEFAULT_RENDER_DELAY_MS, now: number = Date.now()): TimedPoint | null {
    if (this.points.length === 0) return null;
    const targetTime = now - renderDelay;
    const bracket = findBracket(this.points, targetTime);

    if (!bracket) {
      // No two points bracket targetTime yet (too new, or buffer too
      // sparse) — fall back to the last known real position rather than
      // extrapolating into the unknown.
      return this.points[this.points.length - 1];
    }

    const [a, b] = bracket;
    if (b.t === a.t) return b;
    const frac = clamp((targetTime - a.t) / (b.t - a.t), 0, 1);
    return {
      x: a.x + (b.x - a.x) * frac,
      y: a.y + (b.y - a.y) * frac,
      t: targetTime,
    };
  }
}

function findBracket(buffer: TimedPoint[], targetTime: number): [TimedPoint, TimedPoint] | null {
  for (let i = 0; i < buffer.length - 1; i++) {
    const a = buffer[i];
    const b = buffer[i + 1];
    if (a.t <= targetTime && targetTime <= b.t) {
      return [a, b];
    }
  }
  return null;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
