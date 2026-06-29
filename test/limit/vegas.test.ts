import { describe, expect, it } from "vitest"

import { DEFAULT_VEGAS_CONFIG, createVegasState, reduceVegas, vegas } from "../../src/limit/vegas"
import type { VegasState } from "../../src/limit/vegas"
import type { Sample } from "../../src/limit/types"
import { DEFAULT_BOUNDS } from "../../src/limit/types"

const success = (duration: number): Sample => ({ kind: "success", duration })
const error: Sample = { kind: "error" }
const rateLimit: Sample = { kind: "rateLimit" }

const feed = (state: VegasState, samples: readonly Sample[]): VegasState =>
  samples.reduce((acc, sample) => reduceVegas(acc, sample).state, state)

describe("vegas() factory", () => {
  it("uses DEFAULT_VEGAS_CONFIG with no args", () => {
    const limit = vegas()
    const state = limit.createState()
    expect(state.config).toEqual(DEFAULT_VEGAS_CONFIG)
    expect(state.concurrency).toBe(DEFAULT_VEGAS_CONFIG.initial)
    expect(state.recentRtts).toEqual([])
    expect(state.samplesSinceChange).toBe(0)
  })

  it("exposes the documented default config values", () => {
    expect(DEFAULT_VEGAS_CONFIG).toEqual({
      ...DEFAULT_BOUNDS,
      alpha: 1,
      beta: 2,
      decreaseFactor: 0.5,
      probeWindow: 5,
      baseRttWindow: 100,
      baseRttQuantile: 0.3,
    })
  })

  it("defers adjustment until probeWindow samples then increases (default probeWindow 5)", () => {
    const state = createVegasState({ initial: 5, max: 20 })

    const r1 = reduceVegas(state, success(100))
    expect(r1.state.concurrency).toBe(5)
    expect(r1.decision.reason).toBe("none")
    expect(r1.decision.changed).toBe(false)

    const r4 = feed(r1.state, [success(100), success(100), success(100)])
    expect(r4.concurrency).toBe(5)

    const r5 = reduceVegas(r4, success(100))
    expect(r5.state.concurrency).toBe(6)
    expect(r5.decision.reason).toBe("stable")
    expect(r5.decision.changed).toBe(true)
  })

  it("merges a partial config over the defaults", () => {
    const limit = vegas({ alpha: 1, max: 10, decreaseFactor: 0.25 })
    const state = limit.createState()
    expect(state.config).toEqual({
      ...DEFAULT_VEGAS_CONFIG,
      alpha: 1,
      max: 10,
      decreaseFactor: 0.25,
    })
    expect(state.concurrency).toBe(DEFAULT_VEGAS_CONFIG.initial)
  })

  it("honours a custom initial concurrency", () => {
    const state = vegas({ initial: 3 }).createState()
    expect(state.concurrency).toBe(3)
  })

  it("is a valid Limit with name 'vegas', createState and reduce", () => {
    const limit = vegas()
    expect(limit.name).toBe("vegas")
    expect(typeof limit.createState).toBe("function")
    expect(typeof limit.reduce).toBe("function")
  })
})

describe("createVegasState()", () => {
  it("returns a fresh independent state on each call", () => {
    const limit = vegas()
    const a = limit.createState()
    const b = limit.createState()
    expect(a).not.toBe(b)
    expect(a.config).not.toBe(b.config)
    const mutated = reduceVegas(a, success(100)).state
    expect(mutated).not.toBe(a)
    expect(b.recentRtts).toEqual([])
  })

  it("never mutates the input state or its arrays", () => {
    const state = feed(createVegasState(), [success(50), success(70)])
    const snapshot = structuredClone(state)
    const rttsRef = state.recentRtts
    reduceVegas(state, success(60))
    reduceVegas(state, error)
    reduceVegas(state, rateLimit)
    expect(state).toEqual(snapshot)
    expect(state.recentRtts).toBe(rttsRef)
    expect(state.recentRtts).toEqual(snapshot.recentRtts)
  })
})

describe("reduceVegas — additive increase", () => {
  it("grows concurrency by 1 per probe when queue < alpha", () => {
    const state = createVegasState({ initial: 5, max: 20, alpha: 1, beta: 2, probeWindow: 1 })
    const r1 = reduceVegas(state, success(100))
    expect(r1.state.recentRtts).toEqual([100])
    expect(r1.state.concurrency).toBe(6)
    expect(r1.decision).toMatchObject({
      concurrency: 6,
      reason: "stable",
      congestion: false,
      changed: true,
    })
    expect(r1.state.samplesSinceChange).toBe(0)

    const r2 = reduceVegas(r1.state, success(100))
    expect(r2.state.concurrency).toBe(7)
    expect(r2.decision.reason).toBe("stable")
  })

  it("clamps the increase at max and reports changed=false at the ceiling", () => {
    const ceil = feed(createVegasState({ initial: 5, max: 6, alpha: 1, beta: 2, probeWindow: 1 }), [
      success(100),
      success(100),
    ])
    expect(ceil.concurrency).toBe(6)
    const atMax = reduceVegas(ceil, success(100))
    expect(atMax.state.concurrency).toBe(6)
    expect(atMax.decision.changed).toBe(false)
    expect(atMax.decision.reason).toBe("none")
  })
})

describe("reduceVegas — latency back-off", () => {
  it("drops concurrency by 1 with reason 'latency' when queue > beta", () => {
    const established = feed(
      createVegasState({ initial: 10, max: 50, alpha: 1, beta: 2, probeWindow: 1, baseRttQuantile: 0 }),
      [success(100)],
    )
    expect(established.recentRtts).toEqual([100])
    const concurrencyBefore = established.concurrency

    const slow = reduceVegas(established, success(1000))
    expect(slow.state.concurrency).toBe(concurrencyBefore - 1)
    expect(Math.min(...slow.state.recentRtts)).toBe(100)
    expect(slow.decision).toMatchObject({
      reason: "latency",
      congestion: true,
      changed: true,
    })
  })

  it("clamps the decrease at min when queue > beta", () => {
    const established = feed(
      createVegasState({ initial: 6, min: 5, alpha: 1, beta: 2, probeWindow: 1, baseRttQuantile: 0 }),
      [success(100)],
    )
    const concurrencyBefore = established.concurrency
    const slow = reduceVegas(established, success(2000))
    expect(slow.state.concurrency).toBe(concurrencyBefore - 1)
    expect(slow.state.concurrency).toBeGreaterThanOrEqual(5)
    expect(slow.decision.reason).toBe("latency")
  })

  it("reports changed=false when already at min and queue > beta", () => {
    const state: VegasState = {
      ...createVegasState({ initial: 5, min: 5, alpha: 1, beta: 2, probeWindow: 1, baseRttQuantile: 0 }),
      recentRtts: [100],
    }
    const slow = reduceVegas(state, success(2000))
    expect(slow.state.concurrency).toBe(5)
    expect(slow.decision.reason).toBe("latency")
    expect(slow.decision.changed).toBe(false)
  })

  it("holds with reason 'none' when alpha <= queue <= beta", () => {
    const established = feed(
      createVegasState({ initial: 10, alpha: 1, beta: 4, probeWindow: 1, baseRttQuantile: 0 }),
      [success(100)],
    )
    const concurrencyBefore = established.concurrency
    const moderate = reduceVegas(established, success(150))
    expect(moderate.state.concurrency).toBe(concurrencyBefore)
    expect(moderate.decision.reason).toBe("none")
    expect(moderate.decision.congestion).toBe(false)
    expect(moderate.decision.changed).toBe(false)
    expect(moderate.state.samplesSinceChange).toBe(0)
  })
})

describe("reduceVegas — error and rateLimit", () => {
  it("multiplicatively decreases on error with reason 'error'", () => {
    const established = feed(createVegasState({ initial: 10 }), [success(100)])
    const result = reduceVegas(established, error)
    expect(result.state.concurrency).toBe(Math.floor(established.concurrency * 0.5))
    expect(result.state.recentRtts).toEqual([100])
    expect(result.state.samplesSinceChange).toBe(0)
    expect(result.decision).toMatchObject({
      reason: "error",
      congestion: true,
      changed: true,
    })
  })

  it("multiplicatively decreases on rateLimit with reason 'rateLimit'", () => {
    const result = reduceVegas(createVegasState({ initial: 8 }), rateLimit)
    expect(result.state.concurrency).toBe(4)
    expect(result.state.recentRtts).toEqual([])
    expect(result.decision.reason).toBe("rateLimit")
    expect(result.decision.congestion).toBe(true)
  })

  it("resets samplesSinceChange and clamps at min", () => {
    const state: VegasState = { ...createVegasState({ initial: 1, min: 1 }), samplesSinceChange: 3 }
    const result = reduceVegas(state, error)
    expect(result.state.concurrency).toBe(1)
    expect(result.state.samplesSinceChange).toBe(0)
    expect(result.decision.changed).toBe(false)
  })
})

describe("reduceVegas — probeWindow", () => {
  it("defers adjustment for two samples then acts on the third (probeWindow 3)", () => {
    const state = createVegasState({ initial: 5, max: 20, probeWindow: 3 })

    const r1 = reduceVegas(state, success(100))
    expect(r1.state.concurrency).toBe(5)
    expect(r1.state.samplesSinceChange).toBe(1)
    expect(r1.state.recentRtts).toEqual([100])
    expect(r1.decision.reason).toBe("none")

    const r2 = reduceVegas(r1.state, success(100))
    expect(r2.state.concurrency).toBe(5)
    expect(r2.state.samplesSinceChange).toBe(2)
    expect(r2.state.recentRtts).toEqual([100, 100])
    expect(r2.decision.reason).toBe("none")

    const r3 = reduceVegas(r2.state, success(100))
    expect(r3.state.concurrency).toBe(6)
    expect(r3.state.samplesSinceChange).toBe(0)
    expect(r3.decision.reason).toBe("stable")
  })

  it("averages the last probeWindow durations as the current RTT", () => {
    const state: VegasState = {
      ...createVegasState({ initial: 10, alpha: 1, beta: 2, probeWindow: 2, baseRttQuantile: 0 }),
      recentRtts: [100],
      samplesSinceChange: 1,
    }
    const next = reduceVegas(state, success(900))
    expect(next.state.recentRtts).toEqual([100, 900])
    expect(next.state.concurrency).toBe(9)
    expect(next.decision.reason).toBe("latency")
    expect(next.decision.congestion).toBe(true)
  })
})

describe("reduceVegas — windowed-min baseline", () => {
  it("caps recentRtts at baseRttWindow keeping the newest samples", () => {
    const state = feed(createVegasState({ baseRttWindow: 3, probeWindow: 1 }), [
      success(10),
      success(20),
      success(30),
      success(40),
    ])
    expect(state.recentRtts).toEqual([20, 30, 40])
  })

  it("recovers the baseline as low samples age out of the window", () => {
    const config = {
      initial: 10,
      max: 50,
      min: 1,
      alpha: 1,
      beta: 2,
      probeWindow: 1,
      baseRttWindow: 4,
      baseRttQuantile: 0,
    }

    const low = feed(createVegasState(config), [success(10), success(10)])
    expect(Math.min(...low.recentRtts)).toBe(10)

    const highRtt = 500
    const aged = feed(low, [success(highRtt), success(highRtt), success(highRtt), success(highRtt)])
    expect(aged.recentRtts).toEqual([highRtt, highRtt, highRtt, highRtt])
    expect(Math.min(...aged.recentRtts)).toBe(highRtt)

    const stableConcurrency = aged.concurrency
    const next = reduceVegas(aged, success(highRtt))
    expect(Math.min(...next.state.recentRtts)).toBe(highRtt)
    expect(next.decision.reason).toBe("stable")
    expect(next.state.concurrency).toBe(stableConcurrency + 1)
  })
})

describe("reduceVegas — quantile baseline robustness", () => {
  it("ignores a single anomalously-low RTT outlier when estimating the baseline", () => {
    const normal = 1000
    const outlier = 10
    const state: VegasState = {
      ...createVegasState({
        initial: 10,
        max: 50,
        min: 1,
        alpha: 1,
        beta: 2,
        probeWindow: 1,
        baseRttWindow: 100,
        baseRttQuantile: 0.3,
      }),
      recentRtts: [outlier, normal, normal, normal, normal, normal, normal],
      samplesSinceChange: 0,
    }

    const next = reduceVegas(state, success(normal))

    expect(next.decision.reason).toBe("stable")
    expect(next.state.concurrency).toBe(11)
    expect(next.decision.congestion).toBe(false)
  })

  it("treats the low outlier as the baseline when baseRttQuantile is 0 (contrast)", () => {
    const normal = 1000
    const outlier = 10
    const state: VegasState = {
      ...createVegasState({
        initial: 10,
        max: 50,
        min: 1,
        alpha: 1,
        beta: 2,
        probeWindow: 1,
        baseRttWindow: 100,
        baseRttQuantile: 0,
      }),
      recentRtts: [outlier, normal, normal, normal, normal, normal, normal],
      samplesSinceChange: 0,
    }

    const next = reduceVegas(state, success(normal))

    expect(next.decision.reason).toBe("latency")
    expect(next.state.concurrency).toBe(9)
  })
})

describe("reduceVegas — queue estimation edge cases", () => {
  it("treats rtt <= 0 as zero queue (triggers increase)", () => {
    const result = reduceVegas(
      createVegasState({ initial: 5, max: 20, alpha: 1, beta: 2, probeWindow: 1 }),
      success(0),
    )
    expect(result.state.concurrency).toBe(6)
    expect(result.decision.reason).toBe("stable")
  })
})

describe("integration — threaded reduces stay within bounds", () => {
  it("keeps concurrency within [min, max] across a mixed stream", () => {
    const limit = vegas({ initial: 5, min: 2, max: 12 })
    const stream: readonly Sample[] = [
      success(100),
      success(100),
      success(2000),
      error,
      success(100),
      rateLimit,
      success(100),
      success(100),
      success(3000),
    ]

    let state = limit.createState()
    for (const sample of stream) {
      const result = limit.reduce(state, sample)
      expect(result.state.concurrency).toBeGreaterThanOrEqual(2)
      expect(result.state.concurrency).toBeLessThanOrEqual(12)
      state = result.state
    }
  })
})
