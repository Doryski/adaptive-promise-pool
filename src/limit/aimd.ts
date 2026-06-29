import type { Limit, LimitConfig, LimitDecision, LimitReducer, LimitState } from "./types"
import { DEFAULT_LIMIT_CONFIG } from "./types"

const avg = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length

const isCongested = (durations: readonly number[], cfg: LimitConfig): boolean => {
  if (durations.length < cfg.stabilityWindow) return false
  const recent = durations.slice(-cfg.stabilityWindow)
  const baseline = durations.slice(-cfg.stabilityWindow * 2, -cfg.stabilityWindow)
  if (baseline.length === 0) return false
  return avg(recent) / avg(baseline) >= cfg.congestionThreshold
}

const decrease = (c: number, cfg: LimitConfig): number =>
  Math.max(cfg.min, Math.floor(c * cfg.decreaseFactor))

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

export const createLimitState = (config: Partial<LimitConfig> = {}): LimitState => {
  const merged: LimitConfig = { ...DEFAULT_LIMIT_CONFIG, ...config }
  return {
    concurrency: merged.initial,
    config: merged,
    durations: [],
    stableCount: 0,
  }
}

export const reduceLimit: LimitReducer = (state, sample) => {
  const c = state.concurrency
  const cfg = state.config

  if (sample.kind === "error" || sample.kind === "rateLimit") {
    const concurrency = decrease(c, cfg)
    const reason = sample.kind === "error" ? "error" : "rateLimit"
    const stableCount = concurrency !== c ? 0 : state.stableCount
    return {
      state: { ...state, concurrency, stableCount },
      decision: decision(concurrency, c, reason, true),
    }
  }

  const durations = [...state.durations, sample.duration].slice(-(cfg.stabilityWindow * 2))

  if (isCongested(durations, cfg)) {
    const concurrency = decrease(c, cfg)
    const stableCount = concurrency !== c ? 0 : state.stableCount
    return {
      state: { ...state, concurrency, durations, stableCount },
      decision: decision(concurrency, c, "latency", true),
    }
  }

  const stableCount = state.stableCount + 1

  if (stableCount >= cfg.stabilityWindow && c < cfg.max) {
    const concurrency = Math.min(cfg.max, c + cfg.increaseStep)
    return {
      state: { ...state, concurrency, durations, stableCount: 0 },
      decision: decision(concurrency, c, "stable", false),
    }
  }

  return {
    state: { ...state, concurrency: c, durations, stableCount },
    decision: decision(c, c, "none", false),
  }
}

/**
 * Creates an AIMD (Additive-Increase / Multiplicative-Decrease) concurrency limit.
 *
 * Grows concurrency by {@link LimitConfig.increaseStep} after each stable window
 * and shrinks it by {@link LimitConfig.decreaseFactor} on congestion. Any
 * unspecified option falls back to {@link DEFAULT_LIMIT_CONFIG}.
 *
 * @param config - Partial overrides for the AIMD tuning parameters.
 */
export const aimd = (config: Partial<LimitConfig> = {}): Limit<LimitState> => ({
  name: "aimd",
  createState: () => createLimitState(config),
  reduce: reduceLimit,
})
