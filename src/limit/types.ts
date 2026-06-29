/**
 * Configuration for the AIMD (Additive-Increase / Multiplicative-Decrease) limiter.
 *
 * The limiter additively grows concurrency while latency stays stable and
 * multiplicatively shrinks it on congestion (errors, rate limits, or latency
 * inflation beyond {@link LimitConfig.congestionThreshold}).
 */
export type LimitConfig = {
  /**
   * Starting concurrency when the limiter is created.
   * @default 5
   */
  initial: number
  /**
   * Hard floor for concurrency; it never drops below this.
   * @default 1
   */
  min: number
  /**
   * Hard ceiling for concurrency. `Infinity` means the algorithm self-limits;
   * set a finite value to enforce a fixed upper bound.
   * @default Infinity
   */
  max: number
  /**
   * Additive concurrency increase applied per stable window. Higher = faster growth.
   * @default 2
   */
  increaseStep: number
  /**
   * Multiplicative shrink applied on congestion (e.g. `0.55` keeps ~55% of the
   * current limit). Lower = more aggressive backoff.
   * @default 0.55
   */
  decreaseFactor: number
  /**
   * Recent/baseline mean-duration ratio that triggers a decrease. Lower = more
   * sensitive to latency rises.
   * @default 1.4
   */
  congestionThreshold: number
  /**
   * Consecutive stable samples required before increasing, and the comparison
   * window size used to detect congestion. Higher = smoother/slower adaptation.
   * @default 4
   */
  stabilityWindow: number
}

export const DEFAULT_LIMIT_CONFIG = {
  initial: 5,
  min: 1,
  max: Number.POSITIVE_INFINITY,
  increaseStep: 2,
  decreaseFactor: 0.55,
  congestionThreshold: 1.4,
  stabilityWindow: 4,
} as const satisfies LimitConfig

export type Sample =
  | { kind: "success"; duration: number }
  | { kind: "error" }
  | { kind: "rateLimit" }

export type SampleKind = Sample["kind"]

export type LimitState = {
  concurrency: number
  config: LimitConfig
  durations: readonly number[]
  stableCount: number
}

export const CHANGE_REASONS = ["stable", "latency", "error", "rateLimit", "none"] as const
export type ChangeReason = (typeof CHANGE_REASONS)[number]

export type LimitDecision = {
  concurrency: number
  reason: ChangeReason
  congestion: boolean
  changed: boolean
  /** Algorithm-specific internals exposed for tracing (e.g. Vegas `queue`/`baseRtt`/`probeRtt`). */
  metrics?: Readonly<Record<string, number>>
}

export type LimitReducer = (
  state: LimitState,
  sample: Sample,
) => { state: LimitState; decision: LimitDecision }

export type BaseLimitState = { concurrency: number }

export type ConcurrencyBounds = {
  initial: number
  min: number
  max: number
}

export const DEFAULT_BOUNDS = {
  initial: 5,
  min: 1,
  max: Number.POSITIVE_INFINITY,
} as const satisfies ConcurrencyBounds

export type Limit<S extends BaseLimitState = BaseLimitState> = {
  readonly name: string
  createState: () => S
  reduce: (state: S, sample: Sample) => { state: S; decision: LimitDecision }
}

export type LimitStep = {
  readonly concurrency: number
  readonly step: (sample: Sample) => { next: LimitStep; decision: LimitDecision }
}

export const startLimit = <S extends BaseLimitState>(limit: Limit<S>): LimitStep => {
  const wrap = (state: S): LimitStep => ({
    concurrency: state.concurrency,
    step: (sample) => {
      const { state: next, decision } = limit.reduce(state, sample)
      return { next: wrap(next), decision }
    },
  })
  return wrap(limit.createState())
}
