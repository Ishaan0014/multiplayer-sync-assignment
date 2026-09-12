// Live bandwidth readout: turns the "we throttled the network" claim into
// a visible number. Tracks two series over a rolling 1s window —
//   naive:  what raw mousemove (60-120Hz, estimated at 100Hz) would have cost
//   actual: what actually went out on the wire post-throttle/chaos-drop
// so the throttling win is provable, not just asserted.

const WINDOW_MS = 1000;
const ESTIMATED_RAW_HZ = 100; // representative point in the 60-120Hz mousemove range
const ESTIMATED_CURSOR_MSG_BYTES = 64; // approx JSON size of a {type:"cursor",...} message

interface Sample {
  t: number;
  bytes: number;
}

class RollingByteRate {
  private samples: Sample[] = [];

  record(bytes: number, now: number = Date.now()): void {
    this.samples.push({ t: now, bytes });
    this.prune(now);
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    while (this.samples.length && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
  }

  bytesPerSecond(now: number = Date.now()): number {
    this.prune(now);
    const total = this.samples.reduce((sum, s) => sum + s.bytes, 0);
    return total; // window is exactly 1s, so total bytes == bytes/sec
  }
}

export class NetStats {
  private actualSent = new RollingByteRate();
  private actualReceived = new RollingByteRate();
  private moveEventsThisWindow: number[] = [];

  recordSentBytes(bytes: number): void {
    this.actualSent.record(bytes);
  }

  recordReceivedBytes(bytes: number): void {
    this.actualReceived.record(bytes);
  }

  /** Call on every raw mousemove (pre-throttle) so we can estimate naive cost. */
  recordRawMoveEvent(now: number = Date.now()): void {
    this.moveEventsThisWindow.push(now);
    const cutoff = now - WINDOW_MS;
    while (this.moveEventsThisWindow.length && this.moveEventsThisWindow[0] < cutoff) {
      this.moveEventsThisWindow.shift();
    }
  }

  snapshot(now: number = Date.now()): { naiveBytesPerSec: number; actualSentBytesPerSec: number; actualReceivedBytesPerSec: number } {
    const measuredRawHz = this.moveEventsThisWindow.length; // events in the last 1s window == Hz
    const effectiveHz = measuredRawHz > 0 ? measuredRawHz : ESTIMATED_RAW_HZ;
    return {
      naiveBytesPerSec: effectiveHz * ESTIMATED_CURSOR_MSG_BYTES,
      actualSentBytesPerSec: this.actualSent.bytesPerSecond(now),
      actualReceivedBytesPerSec: this.actualReceived.bytesPerSecond(now),
    };
  }
}
