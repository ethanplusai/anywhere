import type { Db } from "../db/db.js";
import { sha256Hex } from "./crypto.js";

export interface Rule {
  limit: number;
  windowS: number;
}

/**
 * Sliding-window counters in Postgres, so limits hold across serverless instances and restarts.
 * Each check is one round trip: an upsert on (key, window) that also reads the previous window, whose
 * count is weighted by how much of it still overlaps the sliding window. That removes the double
 * burst a fixed window allows at its edge. Keys are stored hashed (they can contain email addresses).
 */
export class RateLimiter {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one event. Returns null when allowed, or the seconds to wait. */
  async hit(key: string, rule: Rule): Promise<number | null> {
    const w = this.windows(rule);
    const rows = await this.db.query<{ count: number; prev: number }>(
      `WITH hit AS (
         INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
         ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
         RETURNING count)
       SELECT hit.count AS count,
              COALESCE((SELECT r.count FROM rate_limits r WHERE r.key = $1 AND r.window_start = $3), 0) AS prev
         FROM hit`,
      [hashKey(key), w.start, w.prevStart],
    );
    this.maybePurge();
    return this.verdict(w, Number(rows[0]?.count ?? 1), Number(rows[0]?.prev ?? 0), rule);
  }

  /** Checks without counting (for limits that only count failures). */
  async peek(key: string, rule: Rule): Promise<number | null> {
    const w = this.windows(rule);
    const rows = await this.db.query<{ window_start: string; count: number }>(
      "SELECT window_start, count FROM rate_limits WHERE key = $1 AND window_start IN ($2, $3)",
      [hashKey(key), w.start, w.prevStart],
    );
    let count = 0;
    let prev = 0;
    for (const r of rows) {
      if (Number(r.window_start) === w.start) count = Number(r.count);
      else prev = Number(r.count);
    }
    // A peek asks "would one more be allowed", so it compares against the limit before adding one.
    return this.verdict(w, count + 1, prev, rule);
  }

  private windows(rule: Rule) {
    const now = this.now();
    const ms = rule.windowS * 1000;
    const start = Math.floor(now / ms) * ms;
    return { now, ms, start, prevStart: start - ms };
  }

  private verdict(w: { now: number; ms: number; start: number }, count: number, prev: number, rule: Rule): number | null {
    const overlap = 1 - (w.now - w.start) / w.ms;
    const estimate = count + prev * overlap;
    if (estimate <= rule.limit) return null;
    return Math.max(1, Math.ceil((w.start + w.ms - w.now) / 1000));
  }

  /** Old windows are deleted now and then by whichever request comes along; purgeExpired does it too. */
  private maybePurge() {
    if (Math.random() >= 0.002) return;
    this.db
      .query("DELETE FROM rate_limits WHERE window_start < $1", [this.now() - 2 * 24 * 3600 * 1000])
      .catch((err: unknown) => console.error("rate limit purge failed:", (err as Error).message));
  }
}

function hashKey(key: string): string {
  return sha256Hex(`ratelimit:${key}`).slice(0, 40);
}

/**
 * At most `max` concurrent tasks per key in this process. This bounds memory, which is a property of
 * the process, so a process-local count is the right scope; nothing is kept between requests.
 */
export class ConcurrencyGate {
  private active = new Map<string, number>();
  constructor(private readonly max: number) {}

  tryEnter(key: string): (() => void) | null {
    const n = this.active.get(key) ?? 0;
    if (n >= this.max) return null;
    this.active.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.active.get(key) ?? 1) - 1;
      if (left <= 0) this.active.delete(key);
      else this.active.set(key, left);
    };
  }
}
