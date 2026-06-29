import { describe, expect, it } from "vitest"

import { createLimitState, reduceLimit } from "../../src/limit/aimd"
import { DEFAULT_LIMIT_CONFIG } from "../../src/limit/types"
import type { LimitState, Sample } from "../../src/limit/types"

const success = (duration: number): Sample => ({ kind: "success", duration })
const error: Sample = { kind: "error" }
const rateLimit: Sample = { kind: "rateLimit" }

const feed = (state: LimitState, samples: readonly Sample[]): LimitState =>
  samples.reduce((acc, sample) => reduceLimit(acc, sample).state, state)

describe("createLimitState", () => {
  it("uses DEFAULT_LIMIT_CONFIG with no args", () => {
    const state = createLimitState()
    expect(state.config).toEqual(DEFAULT_LIMIT_CONFIG)
    expect(state.concurrency).toBe(DEFAULT_LIMIT_CONFIG.initial)
    expect(state.durations).toEqual([])
    expect(state.stableCount).toBe(0)
  })

  it("merges partial overrides over defaults", () => {
    const state = createLimitState({ initial: 10, max: 20 })
    expect(state.concurrency).toBe(10)
    expect(state.config.max).toBe(20)
    expect(state.config.initial).toBe(10)
    expect(state.config.min).toBe(DEFAULT_LIMIT_CONFIG.min)
    expect(state.config.decreaseFactor).toBe(DEFAULT_LIMIT_CONFIG.decreaseFactor)
  })
})

describe("additive increase", () => {
  it("fires only after stabilityWindow consecutive stable successes, then resets", () => {
    const state = createLimitState({ initial: 5, stabilityWindow: 4 })

    let current = state
    const reasons: string[] = []
    for (let i = 0; i < 4; i++) {
      const result = reduceLimit(current, success(100))
      reasons.push(result.decision.reason)
      current = result.state
    }

    expect(reasons).toEqual(["none", "none", "none", "stable"])
    expect(current.concurrency).toBe(7)
    expect(current.stableCount).toBe(0)
  })

  it("does not increase before the window is reached", () => {
    const state = createLimitState({ initial: 5, stabilityWindow: 4 })
    const after3 = feed(state, [success(100), success(100), success(100)])
    expect(after3.concurrency).toBe(5)
    expect(after3.stableCount).toBe(3)
  })

  it("respects the max clamp on increase", () => {
    const state = createLimitState({ initial: 5, max: 6, stabilityWindow: 4, increaseStep: 2 })
    const result = reduceLimit(feed(state, [success(1), success(1), success(1)]), success(1))
    expect(result.decision.reason).toBe("stable")
    expect(result.decision.concurrency).toBe(6)
    expect(result.decision.changed).toBe(true)
  })

  it("stays put with reason none when already at max", () => {
    const state: LimitState = {
      ...createLimitState({ initial: 6, max: 6, stabilityWindow: 4 }),
      stableCount: 3,
    }
    const result = reduceLimit(state, success(1))
    expect(result.decision.reason).toBe("none")
    expect(result.decision.concurrency).toBe(6)
    expect(result.decision.changed).toBe(false)
    expect(result.state.stableCount).toBe(4)
  })
})

describe("latency congestion", () => {
  it("triggers ×0.55 floor decrease with reason latency", () => {
    const state = createLimitState({
      initial: 10,
      max: 10,
      stabilityWindow: 2,
      congestionThreshold: 1.4,
    })
    const primed = feed(state, [success(100), success(100)])
    expect(primed.concurrency).toBe(10)
    const result = reduceLimit(primed, success(300))

    expect(result.decision.reason).toBe("latency")
    expect(result.decision.congestion).toBe(true)
    expect(result.decision.concurrency).toBe(Math.floor(10 * 0.55))
    expect(result.decision.changed).toBe(true)
    expect(result.state.stableCount).toBe(0)
  })

  it("does not congest when ratio is below threshold", () => {
    const state = createLimitState({
      initial: 10,
      max: 10,
      stabilityWindow: 2,
      congestionThreshold: 1.4,
    })
    const primed = feed(state, [success(100), success(100)])
    const result = reduceLimit(primed, success(120))
    expect(result.decision.reason).not.toBe("latency")
    expect(result.decision.congestion).toBe(false)
  })

  it("does not congest when baseline window is empty", () => {
    const state = createLimitState({ initial: 10, max: 10, stabilityWindow: 2 })
    const result = reduceLimit(feed(state, [success(100)]), success(1000))
    expect(result.decision.reason).not.toBe("latency")
    expect(result.decision.congestion).toBe(false)
  })

  it("caps durations at stabilityWindow * 2", () => {
    const state = createLimitState({ initial: 10, stabilityWindow: 2 })
    const fed = feed(state, [success(1), success(2), success(3), success(4), success(5)])
    expect(fed.durations).toEqual([2, 3, 4, 5])
  })
})

describe("error sample", () => {
  it("decreases, sets reason error, resets stableCount, leaves durations untouched", () => {
    const base = feed(createLimitState({ initial: 10 }), [success(50), success(50)])
    const stateWithCount: LimitState = { ...base, stableCount: 3 }
    const result = reduceLimit(stateWithCount, error)

    expect(result.decision.reason).toBe("error")
    expect(result.decision.congestion).toBe(true)
    expect(result.decision.concurrency).toBe(Math.floor(10 * 0.55))
    expect(result.state.stableCount).toBe(0)
    expect(result.state.durations).toEqual(base.durations)
  })
})

describe("rateLimit sample", () => {
  it("decreases with reason rateLimit", () => {
    const state = createLimitState({ initial: 10 })
    const result = reduceLimit(state, rateLimit)
    expect(result.decision.reason).toBe("rateLimit")
    expect(result.decision.congestion).toBe(true)
    expect(result.decision.concurrency).toBe(Math.floor(10 * 0.55))
    expect(result.state.stableCount).toBe(0)
    expect(result.state.durations).toEqual([])
  })
})

describe("min clamp and changed flag", () => {
  it("never decreases below min", () => {
    const state = createLimitState({ initial: 1, min: 1 })
    const result = reduceLimit(state, error)
    expect(result.decision.concurrency).toBe(1)
    expect(result.decision.changed).toBe(false)
  })

  it("reports changed=false when a decrease leaves concurrency at min", () => {
    const state = createLimitState({ initial: 1, min: 1 })
    const result = reduceLimit(state, rateLimit)
    expect(result.decision.concurrency).toBe(1)
    expect(result.decision.changed).toBe(false)
    expect(result.decision.congestion).toBe(true)
  })
})

describe("purity", () => {
  it("does not mutate the input state", () => {
    const state = createLimitState({ initial: 10, stabilityWindow: 2 })
    const original = { ...state, durations: [...state.durations] }
    const result = reduceLimit(state, success(100))

    expect(state).toEqual(original)
    expect(state.durations).toEqual([])
    expect(result.state).not.toBe(state)
    expect(result.state.durations).not.toBe(state.durations)
    expect(state.config).toBe(result.state.config)
  })

  it("does not mutate durations on error", () => {
    const base = feed(createLimitState({ initial: 10 }), [success(1), success(2)])
    const durationsRef = base.durations
    reduceLimit(base, error)
    expect(base.durations).toBe(durationsRef)
    expect(base.durations).toEqual([1, 2])
  })
})
