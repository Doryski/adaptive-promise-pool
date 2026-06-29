import type { BaseLimitState, ConcurrencyBounds, Limit, LimitDecision } from "./types"
import { DEFAULT_BOUNDS } from "./types"

/**
 * Configuration for the TCP-Vegas-style limiter.
 *
 * Vegas estimates a "queue" from the gap between the current RTT and a measured
 * no-load baseline RTT, then nudges concurrency by ±1 to keep that queue between
 * {@link VegasConfig.alpha} and {@link VegasConfig.beta}. It also extends
 * {@link ConcurrencyBounds} (`initial` 5, `min` 1, `max` Infinity).
 */
export type VegasConfig = ConcurrencyBounds & {
  /**
   * Lower queue threshold; when the estimated queue is below it, concurrency
   * increases by 1. Higher = more aggressive growth.
   * @default 1
   */
  alpha: number
  /**
   * Upper queue threshold; when the estimated queue exceeds it, concurrency
   * decreases by 1. Lower = more cautious.
   * @default 2
   */
  beta: number
  /**
   * Multiplicative shrink applied on hard congestion (errors/rate limits),
   * e.g. `0.5` halves concurrency. Lower = more aggressive backoff.
   * @default 0.5
   */
  decreaseFactor: number
  /**
   * Number of RTT samples gathered before each adaptation decision. Higher =
   * smoother/slower adaptation.
   * @default 5
   */
  probeWindow: number
  /**
   * Rolling window size of recent RTTs kept for estimating the baseline.
   * @default 100
   */
  baseRttWindow: number
  /**
   * Quantile of observed RTTs used as the no-load baseline. Lower = more robust
   * to slow-tail jitter.
   * @default 0.3
   */
  baseRttQuantile: number
}

export type VegasState = BaseLimitState & {
  config: VegasConfig
  recentRtts: readonly number[]
  samplesSinceChange: number
}

export const DEFAULT_VEGAS_CONFIG = {
  ...DEFAULT_BOUNDS,
  alpha: 1,
  beta: 2,
  decreaseFactor: 0.5,
  probeWindow: 5,
  baseRttWindow: 100,
  baseRttQuantile: 0.3,
} as const satisfies VegasConfig

const decision = (
  concurrency: number,
  previous: number,
  reason: LimitDecision["reason"],
  congestion: boolean,
  metrics?: LimitDecision["metrics"],
): LimitDecision => ({
  concurrency,
  reason,
  congestion,
  changed: concurrency !== previous,
  ...(metrics ? { metrics } : {}),
})

const multiplicativeDecrease = (concurrency: number, config: VegasConfig): number =>
  Math.max(config.min, Math.floor(concurrency * config.decreaseFactor))

const average = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length

const quantile = (values: readonly number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
  return sorted[index] ?? sorted[0] ?? 0
}

const estimateQueue = (concurrency: number, baseRtt: number, rtt: number): number => {
  if (rtt <= 0) return 0
  const effectiveRtt = Math.max(1, rtt)
  return concurrency * (1 - baseRtt / effectiveRtt)
}

export const createVegasState = (config: Partial<VegasConfig> = {}): VegasState => {
  const merged: VegasConfig = { ...DEFAULT_VEGAS_CONFIG, ...config }
  return {
    concurrency: merged.initial,
    config: merged,
    recentRtts: [],
    samplesSinceChange: 0,
  }
}

const reduceCongestion = (
  state: VegasState,
  reason: Extract<LimitDecision["reason"], "error" | "rateLimit">,
): { state: VegasState; decision: LimitDecision } => {
  const concurrency = multiplicativeDecrease(state.concurrency, state.config)
  return {
    state: { ...state, concurrency, samplesSinceChange: 0 },
    decision: decision(concurrency, state.concurrency, reason, true),
  }
}

export const reduceVegas = (
  state: VegasState,
  sample: { kind: "success"; duration: number } | { kind: "error" } | { kind: "rateLimit" },
): { state: VegasState; decision: LimitDecision } => {
  if (sample.kind === "error") return reduceCongestion(state, "error")
  if (sample.kind === "rateLimit") return reduceCongestion(state, "rateLimit")

  const { concurrency, config } = state
  const recentRtts = [...state.recentRtts, sample.duration].slice(-config.baseRttWindow)
  const samples = state.samplesSinceChange + 1

  if (samples < config.probeWindow) {
    return {
      state: { ...state, recentRtts, samplesSinceChange: samples },
      decision: decision(concurrency, concurrency, "none", false),
    }
  }

  const baseRtt = quantile(recentRtts, config.baseRttQuantile)
  const probeRtt = average(recentRtts.slice(-config.probeWindow))
  const queue = estimateQueue(concurrency, baseRtt, probeRtt)
  const metrics = { queue, baseRtt, probeRtt }

  if (queue < config.alpha && concurrency < config.max) {
    const next = Math.min(config.max, concurrency + 1)
    return {
      state: { ...state, concurrency: next, recentRtts, samplesSinceChange: 0 },
      decision: decision(next, concurrency, "stable", false, metrics),
    }
  }

  if (queue > config.beta) {
    const next = Math.max(config.min, concurrency - 1)
    return {
      state: { ...state, concurrency: next, recentRtts, samplesSinceChange: 0 },
      decision: decision(next, concurrency, "latency", true, metrics),
    }
  }

  return {
    state: { ...state, recentRtts, samplesSinceChange: 0 },
    decision: decision(concurrency, concurrency, "none", false, metrics),
  }
}

/**
 * Creates a TCP-Vegas-style concurrency limit.
 *
 * Adjusts concurrency by ±1 to keep the estimated queue (derived from RTT vs.
 * baseline RTT) within `[alpha, beta]`, and multiplicatively backs off on
 * errors or rate limits. Any unspecified option falls back to
 * {@link DEFAULT_VEGAS_CONFIG}.
 *
 * @param config - Partial overrides for the Vegas tuning parameters.
 */
export const vegas = (config: Partial<VegasConfig> = {}): Limit<VegasState> => ({
  name: "vegas",
  createState: () => createVegasState(config),
  reduce: reduceVegas,
})
