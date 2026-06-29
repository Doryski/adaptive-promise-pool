import type { BackoffStrategy, RetryConfig } from "../types"

/** Fully-resolved retry settings with every {@link RetryConfig} default applied. */
export type ResolvedRetryConfig = {
  /** Max retries per task on non-rate-limit errors. @default 3 */
  retries: number
  /** Delay growth strategy across attempts. @default "exponential" */
  backoff: BackoffStrategy
  /** Randomize each backoff delay between 0 and its computed value. @default true */
  jitter: boolean
  /** Base/minimum backoff delay in ms (maps to `RetryConfig.minDelay`). @default 100 */
  baseDelay: number
  /** Upper bound for any single backoff delay in ms. @default 30000 */
  maxDelay: number
  /** Max retries per task triggered by rate-limit errors. @default Infinity */
  maxRateLimitRetries: number
  /** Cap in ms on how long one Retry-After header may pause the pool. @default Infinity */
  maxRetryAfter: number
}

const DEFAULTS: ResolvedRetryConfig = {
  retries: 3,
  backoff: "exponential",
  jitter: true,
  baseDelay: 100,
  maxDelay: 30_000,
  maxRateLimitRetries: Number.POSITIVE_INFINITY,
  maxRetryAfter: Number.POSITIVE_INFINITY,
}

/** Resolve a partial {@link RetryConfig}, filling unset fields from defaults. */
export const resolveRetryConfig = (config?: RetryConfig): ResolvedRetryConfig => ({
  retries: config?.retries ?? DEFAULTS.retries,
  backoff: config?.backoff ?? DEFAULTS.backoff,
  jitter: config?.jitter ?? DEFAULTS.jitter,
  baseDelay: config?.minDelay ?? DEFAULTS.baseDelay,
  maxDelay: config?.maxDelay ?? DEFAULTS.maxDelay,
  maxRateLimitRetries: config?.maxRateLimitRetries ?? DEFAULTS.maxRateLimitRetries,
  maxRetryAfter: config?.maxRetryAfter ?? DEFAULTS.maxRetryAfter,
})

const BASE_DELAY: Record<BackoffStrategy, (baseDelay: number, attempt: number) => number> = {
  constant: (baseDelay) => baseDelay,
  linear: (baseDelay, attempt) => baseDelay * attempt,
  exponential: (baseDelay, attempt) => baseDelay * 2 ** (attempt - 1),
}

/** Compute the backoff delay in ms for a given attempt, applying jitter and the maxDelay clamp. */
export const computeBackoff = (
  attempt: number,
  config: ResolvedRetryConfig,
  rng: () => number = Math.random,
): number => {
  const safeAttempt = attempt < 1 ? 1 : attempt
  const base = BASE_DELAY[config.backoff](config.baseDelay, safeAttempt)
  const raw = Math.min(base, config.maxDelay)
  const delay = config.jitter ? rng() * raw : raw

  if (!Number.isFinite(delay) || delay < 0) return 0
  return Math.min(delay, config.maxDelay)
}
