/**
 * The official clock (PRD-007 §5.3): Burnout League time comes from the
 * server. The device clock is never trusted; we only use it to measure how
 * far off it is.
 *
 * offset = serverTime − midpoint of the request, so a round trip that takes
 * 400 ms is still accurate to about ±200 ms.
 */
export interface TimeSample {
  sentAt: number;
  receivedAt: number;
  serverTime: number;
}

export function offsetFrom(s: TimeSample): number {
  return s.serverTime - (s.sentAt + s.receivedAt) / 2;
}

/**
 * Picks the sample with the shortest round trip: it has the smallest
 * uncertainty. Returns null for no samples.
 */
export function bestOffset(samples: TimeSample[]): number | null {
  if (!samples.length) return null;
  const best = samples.reduce((a, b) => (b.receivedAt - b.sentAt < a.receivedAt - a.sentAt ? b : a));
  return offsetFrom(best);
}

type Listener = () => void;

export class ServerClock {
  private offsetMs = 0;
  private synced = false;
  private listeners = new Set<Listener>();

  constructor(private readonly deviceNow: () => number = () => Date.now()) {}

  now(): number {
    return this.deviceNow() + this.offsetMs;
  }

  get isSynced(): boolean {
    return this.synced;
  }

  get offset(): number {
    return this.offsetMs;
  }

  setOffset(ms: number): void {
    this.offsetMs = ms;
    this.synced = true;
    this.listeners.forEach((l) => l());
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Takes a few samples from GET /v1/time and keeps the tightest. */
  async sync(fetchTime: () => Promise<string>, samples = 3): Promise<void> {
    const got: TimeSample[] = [];
    for (let i = 0; i < samples; i++) {
      try {
        const sentAt = this.deviceNow();
        const iso = await fetchTime();
        const receivedAt = this.deviceNow();
        const serverTime = Date.parse(iso);
        if (Number.isFinite(serverTime)) got.push({ sentAt, receivedAt, serverTime });
      } catch {
        /* keep the last offset; the next sync tries again */
      }
    }
    const off = bestOffset(got);
    if (off !== null) this.setOffset(off);
  }
}

export const serverClock = new ServerClock();
