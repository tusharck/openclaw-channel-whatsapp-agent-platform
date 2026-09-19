/**
 * A minimal rolling-window rate limiter.
 *
 * The Agent Platform enforces per-agent rolling 60s windows: outbound messages
 * 12/min, read receipts + typing 12/min, update polls 15/min, media 12/min per
 * method. We throttle client-side to stay under those limits and avoid 429s.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Token-free sliding-window limiter: at most `max` acquisitions per `windowMs`. */
export class RollingWindowLimiter {
  private readonly hits: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number = 60_000,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Wait until a slot is free, then consume it. */
  async acquire(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      this.evict(now);
      if (this.hits.length < this.max) {
        this.hits.push(now);
        return;
      }
      const oldest = this.hits[0];
      const waitMs = Math.max(1, oldest + this.windowMs - now);
      await this.clock.sleep(waitMs);
    }
  }

  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.hits.length > 0 && this.hits[0] <= cutoff) this.hits.shift();
  }
}

/** Smallest backoff we will ever wait, so jitter can't produce a ~0ms hot retry. */
export const MIN_BACKOFF_MS = 250;

/**
 * Exponential backoff with full jitter, capped, and floored at MIN_BACKOFF_MS.
 * Full jitter can otherwise return values near 0, turning a retry loop into a
 * tight spin against the API.
 */
export function backoffDelay(attempt: number, baseMs = 1_000, capMs = 30_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  const jittered = Math.floor(Math.random() * exp);
  return Math.min(capMs, Math.max(MIN_BACKOFF_MS, jittered));
}
