import { describe, expect, it } from "vitest"

import {
  DEFAULT_GRADIENT2_CONFIG,
  createGradient2State,
  gradient2,
  reduceGradient2,
} from "../../src/limit/gradient2"
import type { Gradient2State } from "../../src/limit/gradient2"
import type { Sample } from "../../src/limit/types"

const success = (duration: number): Sample => ({ kind: "success", duration })
const error: Sample = { kind: "error" }
const rateLimit: Sample = { kind: "rateLimit" }

const feed = (state: Gradient2State, samples: readonly Sample[]): Gradient2State =>
  samples.reduce((acc, sample) => reduceGradient2(acc, sample).state, state)

const repeat = (sample: Sample, count: number): Sample[] => Array.from({ length: count }, () => sample)

describe("gradient2 factory and defaults", () => {
  it("uses DEFAULT_GRADIENT2_CONFIG with no args", () => {
    const state = createGradient2State()
    expect(state.config).toEqual(DEFAULT_GRADIENT2_CONFIG)
    expect(DEFAULT_GRADIENT2_CONFIG.smoothing).toBe(0.15)
    expect(DEFAULT_GRADIENT2_CONFIG.longWindow).toBe(600)
    expect(DEFAULT_GRADIENT2_CONFIG.rttTolerance).toBe(1.15)
    expect(DEFAULT_GRADIENT2_CONFIG.decreaseFactor).toBe(0.5)
    expect(DEFAULT_GRADIENT2_CONFIG.probeWindow).toBe(3)
    expect(DEFAULT_GRADIENT2_CONFIG.queueSize).toBe(2)
    expect(DEFAULT_GRADIENT2_CONFIG.initial).toBe(5)
    expect(DEFAULT_GRADIENT2_CONFIG.min).toBe(1)
    expect(DEFAULT_GRADIENT2_CONFIG.max).toBe(Number.POSITIVE_INFINITY)
  })

  it("merges partial overrides over defaults", () => {
    const state = createGradient2State({ initial: 10, max: 50, smoothing: 0.5 })
    expect(state.config.initial).toBe(10)
    expect(state.config.max).toBe(50)
    expect(state.config.smoothing).toBe(0.5)
    expect(state.config.min).toBe(DEFAULT_GRADIENT2_CONFIG.min)
    expect(state.config.longWindow).toBe(DEFAULT_GRADIENT2_CONFIG.longWindow)
    expect(state.config.rttTolerance).toBe(DEFAULT_GRADIENT2_CONFIG.rttTolerance)
    expect(state.config.queueSize).toBe(DEFAULT_GRADIENT2_CONFIG.queueSize)
  })

  it("createState returns a fresh state seeded from config each call", () => {
    const limit = gradient2({ initial: 8 })
    const a = limit.createState()
    const b = limit.createState()
    expect(a).not.toBe(b)
    expect(a.concurrency).toBe(8)
    expect(a.estimatedLimit).toBe(8)
    expect(a.longRtt).toBe(0)
    expect(a.shortSum).toBe(0)
    expect(a.shortCount).toBe(0)
    expect(b.concurrency).toBe(8)
  })

  it("is a valid Limit named gradient2", () => {
    const limit = gradient2()
    expect(limit.name).toBe("gradient2")
    expect(typeof limit.createState).toBe("function")
    expect(typeof limit.reduce).toBe("function")
  })
})

describe("probe-window aggregation", () => {
  it("does not adjust before probeWindow samples accumulate", () => {
    const state = createGradient2State({ initial: 5, probeWindow: 3 })
    const first = reduceGradient2(state, success(100))
    expect(first.state.shortCount).toBe(1)
    expect(first.state.longRtt).toBe(0)
    expect(first.decision.concurrency).toBe(5)
    expect(first.decision.changed).toBe(false)
    const second = reduceGradient2(first.state, success(100))
    expect(second.state.shortCount).toBe(2)
    expect(second.decision.changed).toBe(false)
  })

  it("seeds longRtt with the averaged shortRtt once the window completes", () => {
    const state = createGradient2State({ initial: 5, probeWindow: 3 })
    const completed = feed(state, repeat(success(120), 3))
    expect(completed.longRtt).toBe(120)
    expect(completed.shortCount).toBe(0)
  })

  it("clamps each sample to >= 1 when averaging", () => {
    const state = createGradient2State({ initial: 5, probeWindow: 3 })
    const completed = feed(state, repeat(success(0), 3))
    expect(completed.longRtt).toBe(1)
  })
})

describe("growth at stable low RTT", () => {
  it("grows estimatedLimit and concurrency over several samples then clamps at max", () => {
    const state = createGradient2State({ initial: 5, max: 20, smoothing: 0.5, longWindow: 600 })
    const grown = feed(state, repeat(success(100), 120))
    expect(grown.concurrency).toBeGreaterThan(5)
    expect(grown.concurrency).toBeLessThanOrEqual(20)
    expect(grown.estimatedLimit).toBeLessThanOrEqual(20)
  })

  it("reports reason stable and congestion false on a growth step", () => {
    const state = createGradient2State({ initial: 5, max: 100, smoothing: 0.5 })
    const primed = feed(state, repeat(success(100), 30))
    const result = feed(primed, repeat(success(100), 3))
    expect(result.concurrency).toBeGreaterThanOrEqual(primed.concurrency)
  })

  it("never exceeds the configured max", () => {
    const state = createGradient2State({ initial: 5, max: 12 })
    const grown = feed(state, repeat(success(50), 1500))
    expect(grown.concurrency).toBeLessThanOrEqual(12)
    expect(grown.estimatedLimit).toBeLessThanOrEqual(12)
  })
})

describe("shrink on rising latency", () => {
  it("decreases concurrency with reason latency and congestion true", () => {
    const state = createGradient2State({ initial: 40, max: 40, min: 1, longWindow: 600, smoothing: 0.5 })
    const seeded = feed(state, repeat(success(50), 6))
    expect(seeded.concurrency).toBe(40)
    const result = feed(seeded, repeat(success(5000), 3))
    expect(result.concurrency).toBeLessThan(seeded.concurrency)
  })

  it("floors the gradient at 0.5 so it cannot shed faster than half per step", () => {
    const state = createGradient2State({ initial: 40, max: 40, smoothing: 1, longWindow: 600, queueSize: 2 })
    const seeded = feed(state, repeat(success(10), 6))
    const before = seeded.estimatedLimit
    const result = feed(seeded, repeat(success(1_000_000), 3))
    const minEstimated = before * 0.5 + 2
    expect(result.estimatedLimit).toBeCloseTo(minEstimated, 6)
  })
})

describe("does not run away under sustained high latency", () => {
  it("settles instead of climbing to max when latency rises with concurrency", () => {
    const softCap = 10
    const baseRtt = 25
    const latencyFor = (c: number): number => {
      if (c <= softCap) return baseRtt
      const over = (c - softCap) / softCap
      return baseRtt * (1 + over * over * 3)
    }
    let state = createGradient2State({ initial: 5, min: 1, max: 200 })
    for (let i = 0; i < 600; i += 1) {
      state = reduceGradient2(state, success(latencyFor(state.concurrency))).state
    }
    expect(state.concurrency).toBeLessThan(200)
    expect(state.concurrency).toBeLessThan(2 * softCap)
  })

  it("does not jump to max on a calm-but-high constant RTT stream", () => {
    const state = createGradient2State({ initial: 8, min: 1, max: 5000 })
    const settled = feed(state, repeat(success(800), 600))
    expect(settled.concurrency).toBeLessThan(5000)
    expect(settled.concurrency).toBeLessThan(120)
  })
})

describe("error and rateLimit congestion", () => {
  it("error multiplicatively decreases via decreaseFactor with reason error", () => {
    const state = createGradient2State({ initial: 20, decreaseFactor: 0.5, probeWindow: 3 })
    const seeded = feed(state, repeat(success(100), 3))
    const longRttBefore = seeded.longRtt
    const result = reduceGradient2(seeded, error)
    expect(result.decision.reason).toBe("error")
    expect(result.decision.congestion).toBe(true)
    expect(result.state.estimatedLimit).toBeCloseTo(seeded.estimatedLimit * 0.5, 6)
    expect(result.decision.concurrency).toBe(Math.floor(seeded.estimatedLimit * 0.5))
    expect(result.state.longRtt).toBe(longRttBefore)
    expect(result.state.shortCount).toBe(0)
  })

  it("rateLimit decreases with reason rateLimit and leaves longRtt untouched", () => {
    const seeded = feed(createGradient2State({ initial: 20, probeWindow: 3 }), repeat(success(80), 3))
    const result = reduceGradient2(seeded, rateLimit)
    expect(result.decision.reason).toBe("rateLimit")
    expect(result.decision.congestion).toBe(true)
    expect(result.state.estimatedLimit).toBeCloseTo(seeded.estimatedLimit * 0.5, 6)
    expect(result.state.longRtt).toBe(seeded.longRtt)
  })

  it("respects min on decrease and reports changed correctly", () => {
    const state = createGradient2State({ initial: 1, min: 1 })
    const result = reduceGradient2(state, error)
    expect(result.decision.concurrency).toBe(1)
    expect(result.decision.changed).toBe(false)
    expect(result.decision.congestion).toBe(true)
  })

  it("resets the probe window on congestion", () => {
    const state = createGradient2State({ initial: 20, probeWindow: 3 })
    const partial = reduceGradient2(state, success(100)).state
    expect(partial.shortCount).toBe(1)
    const afterError = reduceGradient2(partial, error).state
    expect(afterError.shortCount).toBe(0)
    expect(afterError.shortSum).toBe(0)
  })
})

describe("bounds and integrality", () => {
  it("keeps concurrency integral and within [min, max] across a long mixed stream", () => {
    const limit = gradient2({ initial: 5, min: 2, max: 30 })
    let state = limit.createState()
    const stream: Sample[] = [
      ...repeat(success(100), 20),
      success(900),
      ...repeat(success(100), 10),
      error,
      ...repeat(success(120), 15),
      rateLimit,
      ...repeat(success(100), 30),
    ]
    for (const sample of stream) {
      const result = limit.reduce(state, sample)
      expect(Number.isInteger(result.decision.concurrency)).toBe(true)
      expect(result.decision.concurrency).toBeGreaterThanOrEqual(2)
      expect(result.decision.concurrency).toBeLessThanOrEqual(30)
      expect(result.decision.changed).toBe(result.decision.concurrency !== state.concurrency)
      state = result.state
    }
    expect(Number.isInteger(state.concurrency)).toBe(true)
    expect(state.concurrency).toBeGreaterThanOrEqual(2)
    expect(state.concurrency).toBeLessThanOrEqual(30)
  })
})

describe("purity", () => {
  it("does not mutate the input state on success", () => {
    const state = createGradient2State({ initial: 10 })
    const snapshot = { ...state }
    const result = reduceGradient2(state, success(100))
    expect(state).toEqual(snapshot)
    expect(result.state).not.toBe(state)
    expect(state.config).toBe(result.state.config)
  })

  it("does not mutate the input state on error", () => {
    const state = feed(createGradient2State({ initial: 10 }), repeat(success(100), 3))
    const snapshot = { ...state }
    const result = reduceGradient2(state, error)
    expect(state).toEqual(snapshot)
    expect(result.state).not.toBe(state)
  })
})
