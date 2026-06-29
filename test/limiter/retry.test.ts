import { describe, expect, it } from "vitest"

import { computeBackoff, resolveRetryConfig } from "../../src/limiter/retry"
import type { ResolvedRetryConfig } from "../../src/limiter/retry"

describe("resolveRetryConfig", () => {
  it("returns defaults when no config is given", () => {
    expect(resolveRetryConfig()).toEqual({
      retries: 3,
      backoff: "exponential",
      jitter: true,
      baseDelay: 100,
      maxDelay: 30_000,
      maxRateLimitRetries: Number.POSITIVE_INFINITY,
      maxRetryAfter: Number.POSITIVE_INFINITY,
    })
  })

  it("returns defaults for an empty config object", () => {
    expect(resolveRetryConfig({})).toEqual({
      retries: 3,
      backoff: "exponential",
      jitter: true,
      baseDelay: 100,
      maxDelay: 30_000,
      maxRateLimitRetries: Number.POSITIVE_INFINITY,
      maxRetryAfter: Number.POSITIVE_INFINITY,
    })
  })

  it("keeps other defaults when only retries is set", () => {
    expect(resolveRetryConfig({ retries: 7 })).toEqual({
      retries: 7,
      backoff: "exponential",
      jitter: true,
      baseDelay: 100,
      maxDelay: 30_000,
      maxRateLimitRetries: Number.POSITIVE_INFINITY,
      maxRetryAfter: Number.POSITIVE_INFINITY,
    })
  })

  it("maps minDelay to baseDelay", () => {
    expect(resolveRetryConfig({ minDelay: 250 }).baseDelay).toBe(250)
  })

  it("applies all overrides", () => {
    expect(
      resolveRetryConfig({
        retries: 1,
        backoff: "linear",
        jitter: false,
        minDelay: 50,
        maxDelay: 5_000,
      }),
    ).toEqual({
      retries: 1,
      backoff: "linear",
      jitter: false,
      baseDelay: 50,
      maxDelay: 5_000,
      maxRateLimitRetries: Number.POSITIVE_INFINITY,
      maxRetryAfter: Number.POSITIVE_INFINITY,
    })
  })

  it("defaults maxRetryAfter to Infinity and respects an override", () => {
    expect(resolveRetryConfig().maxRetryAfter).toBe(Number.POSITIVE_INFINITY)
    expect(resolveRetryConfig({}).maxRetryAfter).toBe(Number.POSITIVE_INFINITY)
    expect(resolveRetryConfig({ maxRetryAfter: 50 }).maxRetryAfter).toBe(50)
  })

  it("preserves a zero retries override", () => {
    expect(resolveRetryConfig({ retries: 0 }).retries).toBe(0)
  })

  it("preserves a false jitter override", () => {
    expect(resolveRetryConfig({ jitter: false }).jitter).toBe(false)
  })
})

const cfg = (overrides: Partial<ResolvedRetryConfig> = {}): ResolvedRetryConfig => ({
  retries: 3,
  backoff: "exponential",
  jitter: false,
  baseDelay: 100,
  maxDelay: 30_000,
  maxRateLimitRetries: Number.POSITIVE_INFINITY,
  maxRetryAfter: Number.POSITIVE_INFINITY,
  ...overrides,
})

describe("computeBackoff base growth (jitter off)", () => {
  it("constant stays at baseDelay across attempts", () => {
    const c = cfg({ backoff: "constant" })
    expect([1, 2, 3, 4].map((a) => computeBackoff(a, c))).toEqual([100, 100, 100, 100])
  })

  it("linear scales with attempt", () => {
    const c = cfg({ backoff: "linear" })
    expect([1, 2, 3, 4].map((a) => computeBackoff(a, c))).toEqual([100, 200, 300, 400])
  })

  it("exponential doubles each attempt", () => {
    const c = cfg({ backoff: "exponential" })
    expect([1, 2, 3, 4].map((a) => computeBackoff(a, c))).toEqual([100, 200, 400, 800])
  })
})

describe("computeBackoff clamping", () => {
  it("caps exponential base at maxDelay", () => {
    const c = cfg({ backoff: "exponential", baseDelay: 1_000, maxDelay: 30_000 })
    expect(computeBackoff(1, c)).toBe(1_000)
    expect(computeBackoff(5, c)).toBe(16_000)
    expect(computeBackoff(6, c)).toBe(30_000)
    expect(computeBackoff(10, c)).toBe(30_000)
  })

  it("caps linear base at maxDelay", () => {
    const c = cfg({ backoff: "linear", baseDelay: 100, maxDelay: 250 })
    expect([1, 2, 3, 4].map((a) => computeBackoff(a, c))).toEqual([100, 200, 250, 250])
  })
})

describe("computeBackoff jitter (full jitter)", () => {
  it("rng() = 0 yields 0", () => {
    const c = cfg({ backoff: "exponential", jitter: true })
    expect(computeBackoff(3, c, () => 0)).toBe(0)
  })

  it("rng() = 1 yields the clamped base", () => {
    const c = cfg({ backoff: "exponential", jitter: true })
    expect(computeBackoff(3, c, () => 1)).toBe(400)
  })

  it("rng() = 0.5 yields half the clamped base", () => {
    const c = cfg({ backoff: "exponential", jitter: true })
    expect(computeBackoff(3, c, () => 0.5)).toBe(200)
  })

  it("applies jitter to the clamped base, not the raw base", () => {
    const c = cfg({ backoff: "exponential", baseDelay: 1_000, maxDelay: 30_000, jitter: true })
    expect(computeBackoff(10, c, () => 1)).toBe(30_000)
    expect(computeBackoff(10, c, () => 0.5)).toBe(15_000)
  })
})

describe("computeBackoff attempt guard", () => {
  it("treats attempt < 1 as attempt 1", () => {
    const c = cfg({ backoff: "exponential" })
    expect(computeBackoff(0, c)).toBe(computeBackoff(1, c))
    expect(computeBackoff(-5, c)).toBe(computeBackoff(1, c))
  })

  it("guards attempt < 1 for linear too", () => {
    const c = cfg({ backoff: "linear" })
    expect(computeBackoff(0, c)).toBe(100)
  })
})

describe("computeBackoff invariants", () => {
  const strategies = ["exponential", "linear", "constant"] as const

  it("always returns a finite value within [0, maxDelay]", () => {
    const rngs = [() => 0, () => 0.25, () => 0.5, () => 1, Math.random]
    for (const backoff of strategies) {
      for (const jitter of [true, false]) {
        const c = cfg({ backoff, jitter, baseDelay: 500, maxDelay: 10_000 })
        for (let attempt = -2; attempt <= 12; attempt++) {
          for (const rng of rngs) {
            const delay = computeBackoff(attempt, c, rng)
            expect(Number.isFinite(delay)).toBe(true)
            expect(delay).toBeGreaterThanOrEqual(0)
            expect(delay).toBeLessThanOrEqual(c.maxDelay)
          }
        }
      }
    }
  })

  it("returns 0 when base computation overflows to a non-finite value", () => {
    const c = cfg({ backoff: "exponential", baseDelay: 100, maxDelay: Number.POSITIVE_INFINITY, jitter: false })
    expect(computeBackoff(2_000, c)).toBe(0)
  })
})
