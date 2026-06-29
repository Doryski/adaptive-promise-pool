import type { BaseLimitState, ConcurrencyBounds, Limit, LimitDecision } from "./types"
import { DEFAULT_BOUNDS } from "./types"

/**
 * Configuration for the Gradient2 limiter.
 *
 * Gradient2 compares a short-term RTT against a long-term baseline RTT and
 * scales an EMA-smoothed limit estimate by their gradient, adding a small queue
 * headroom term. It also extends {@link ConcurrencyBounds} (`initial` 5,
 * `min` 1, `max` Infinity).
 */
export type Gradient2Config = ConcurrencyBounds & {
  /**
   * EMA factor for the limit estimate. Higher = reacts faster but noisier;
   * lower = smoother but slower.
   * @default 0.15
   */
  smoothing: number
  /**
   * Window (in samples) over which the long-term baseline RTT is tracked.
   * Larger = more stable baseline.
   * @default 600
   */
  longWindow: number
  /**
   * Acceptable RTT inflation ratio (short vs. long) before backing off.
   * Higher = tolerates more latency growth before shrinking.
   * @default 1.15
   */
  rttTolerance: number
  /**
   * Multiplicative shrink applied to the estimate on hard congestion
   * (errors/rate limits), e.g. `0.5` halves it. Lower = more aggressive backoff.
   * @default 0.5
   */
  decreaseFactor: number
  /**
   * Number of RTT samples gathered before each adaptation decision. Higher =
   * smoother/slower adaptation.
   * @default 3
   */
  probeWindow: number
  /**
   * Queue/headroom term added to the estimated limit, allowing growth above the
   * pure gradient estimate. Higher = more headroom.
   * @default 2
   */
  queueSize: number
}

export type Gradient2State = BaseLimitState & {
  config: Gradient2Config
  longRtt: number
  estimatedLimit: number
  shortSum: number
  shortCount: number
}

export const DEFAULT_GRADIENT2_CONFIG = {
  ...DEFAULT_BOUNDS,
  smoothing: 0.15,
  longWindow: 600,
  rttTolerance: 1.15,
  decreaseFactor: 0.5,
  probeWindow: 3,
  queueSize: 2,
} as const satisfies Gradient2Config

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const decision = (
  concurrency: number,
  previous: number,
  reason: LimitDecision["reason"],
  congestion: boolean,
): LimitDecision => ({
  concurrency,
  reason,
  congestion,
  changed: concurrency !== previous,
})

export const createGradient2State = (config: Partial<Gradient2Config> = {}): Gradient2State => {
  const merged: Gradient2Config = { ...DEFAULT_GRADIENT2_CONFIG, ...config }
  return {
    concurrency: merged.initial,
    config: merged,
    longRtt: 0,
    estimatedLimit: merged.initial,
    shortSum: 0,
    shortCount: 0,
  }
}

const reduceCongestion = (
  state: Gradient2State,
  reason: Extract<LimitDecision["reason"], "error" | "rateLimit">,
): { state: Gradient2State; decision: LimitDecision } => {
  const { config } = state
  const estimatedLimit = Math.max(config.min, state.estimatedLimit * config.decreaseFactor)
  const concurrency = clamp(Math.floor(estimatedLimit), config.min, config.max)
  return {
    state: { ...state, estimatedLimit, concurrency, shortSum: 0, shortCount: 0 },
    decision: decision(concurrency, state.concurrency, reason, true),
  }
}

const seedLongRtt = (longRtt: number, shortRtt: number, longWindow: number): number => {
  if (longRtt <= 0) return shortRtt
  const weight = 1 / longWindow
  const blended = longRtt * (1 - weight) + shortRtt * weight
  if (shortRtt < blended) return Math.min(blended, shortRtt + (blended - shortRtt) * 0.5)
  return blended
}

const successReason = (
  next: number,
  previous: number,
): { reason: LimitDecision["reason"]; congestion: boolean } => {
  if (next > previous) return { reason: "stable", congestion: false }
  if (next < previous) return { reason: "latency", congestion: true }
  return { reason: "none", congestion: false }
}

export const reduceGradient2 = (
  state: Gradient2State,
  sample: { kind: "success"; duration: number } | { kind: "error" } | { kind: "rateLimit" },
): { state: Gradient2State; decision: LimitDecision } => {
  if (sample.kind === "error") return reduceCongestion(state, "error")
  if (sample.kind === "rateLimit") return reduceCongestion(state, "rateLimit")

  const { config } = state
  const shortSum = state.shortSum + Math.max(1, sample.duration)
  const shortCount = state.shortCount + 1

  if (shortCount < config.probeWindow) {
    return {
      state: { ...state, shortSum, shortCount },
      decision: decision(state.concurrency, state.concurrency, "none", false),
    }
  }

  const shortRtt = shortSum / shortCount
  const longRtt = seedLongRtt(state.longRtt, shortRtt, config.longWindow)

  const gradient = clamp((config.rttTolerance * longRtt) / shortRtt, 0.5, 1)
  const newEstimatedLimit = state.estimatedLimit * gradient + config.queueSize
  const smoothed = state.estimatedLimit * (1 - config.smoothing) + newEstimatedLimit * config.smoothing
  const estimatedLimit = clamp(smoothed, config.min, config.max)
  const concurrency = clamp(Math.floor(estimatedLimit), config.min, config.max)

  const { reason, congestion } = successReason(concurrency, state.concurrency)
  return {
    state: { ...state, longRtt, estimatedLimit, concurrency, shortSum: 0, shortCount: 0 },
    decision: decision(concurrency, state.concurrency, reason, congestion),
  }
}

/**
 * Creates a Gradient2 concurrency limit.
 *
 * Scales an EMA-smoothed limit estimate by the ratio of long-term to short-term
 * RTT (plus a queue headroom term), and multiplicatively backs off on errors or
 * rate limits. Any unspecified option falls back to
 * {@link DEFAULT_GRADIENT2_CONFIG}.
 *
 * @param config - Partial overrides for the Gradient2 tuning parameters.
 */
export const gradient2 = (config: Partial<Gradient2Config> = {}): Limit<Gradient2State> => ({
  name: "gradient2",
  createState: () => createGradient2State(config),
  reduce: reduceGradient2,
})
