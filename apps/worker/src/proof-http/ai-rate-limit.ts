/**
 * In-process cost guard for the paid AI routes: a global concurrency cap plus a token bucket.
 * It bounds spend from any caller that can reach the worker; it is not authentication, and it is
 * per process (several workers each enforce their own budget).
 */
export const DEFAULT_AI_MAX_CONCURRENT = 4;
export const DEFAULT_AI_RATE_PER_MINUTE = 20;

export type AiLimiterOptions = Readonly<{
  maxConcurrent: number;
  /** Sustained provider calls per minute; also the burst capacity of the bucket. */
  ratePerMinute: number;
  /** Injectable clock in milliseconds; defaults to `Date.now`. */
  nowMs?: () => number;
}>;

export type AiAdmission =
  | Readonly<{ ok: true; release: () => void }>
  | Readonly<{
      ok: false;
      code: "ai-rate-limited" | "ai-concurrency-limited";
      retryAfterSeconds: number;
    }>;

export interface AiLimiter {
  /** Reserve budget for one provider call. Call only when a provider call will really happen. */
  tryAcquire(): AiAdmission;
}

export function createAiLimiter(options: Partial<AiLimiterOptions> = {}): AiLimiter {
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_AI_MAX_CONCURRENT;
  const ratePerMinute = options.ratePerMinute ?? DEFAULT_AI_RATE_PER_MINUTE;
  const nowMs = options.nowMs ?? Date.now;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("PROOF_AI_MAX_CONCURRENT must be a positive integer.");
  }
  if (!Number.isSafeInteger(ratePerMinute) || ratePerMinute < 1) {
    throw new Error("PROOF_AI_RATE_PER_MINUTE must be a positive integer.");
  }
  const refillPerMs = ratePerMinute / 60_000;
  let tokens = ratePerMinute;
  let lastRefill = nowMs();
  let inFlight = 0;

  return {
    tryAcquire() {
      const now = nowMs();
      if (now > lastRefill) {
        tokens = Math.min(ratePerMinute, tokens + (now - lastRefill) * refillPerMs);
        lastRefill = now;
      }
      if (inFlight >= maxConcurrent) {
        return { ok: false, code: "ai-concurrency-limited", retryAfterSeconds: 1 };
      }
      if (tokens < 1) {
        return {
          ok: false,
          code: "ai-rate-limited",
          retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000)),
        };
      }
      tokens -= 1;
      inFlight += 1;
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          inFlight -= 1;
        },
      };
    },
  };
}
