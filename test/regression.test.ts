import { describe, expect, it } from "vitest"

import { aimd, reduceLimit } from "../src/limit/aimd"
import { DEFAULT_LIMIT_CONFIG, startLimit } from "../src/limit/types"
import type { LimitState } from "../src/limit/types"
import { execute } from "../src/limiter/executor"
import type { ExecutorOptions } from "../src/limiter/executor"
import { resolveRetryConfig } from "../src/limiter/retry"
import { RateLimitError } from "../src/errors"
import { adaptiveMap } from "../src/pool"

describe("aimd: stableCount preserved when decrease is a no-op at min", () => {
  const atMin: LimitState = {
    concurrency: 1,
    config: { ...DEFAULT_LIMIT_CONFIG, min: 1 },
    durations: [],
    stableCount: 2,
  }

  it("error at min keeps stableCount and reports no change", () => {
    const { state, decision } = reduceLimit(atMin, { kind: "error" })
    expect(decision.changed).toBe(false)
    expect(decision.congestion).toBe(true)
    expect(state.stableCount).toBe(2)
  })

  it("rateLimit at min keeps stableCount", () => {
    const { state } = reduceLimit(atMin, { kind: "rateLimit" })
    expect(state.stableCount).toBe(2)
  })

  it("error above min still resets stableCount", () => {
    const above: LimitState = { ...atMin, concurrency: 10 }
    const { state, decision } = reduceLimit(above, { kind: "error" })
    expect(decision.changed).toBe(true)
    expect(state.stableCount).toBe(0)
  })
})

describe("executor: no item is lost while concurrency shrinks mid-run", () => {
  it("accounts for every input item exactly once under heavy decrease", async () => {
    const total = 60
    const items = Array.from({ length: total }, (_, i) => i)
    const seen = new Set<number>()
    const retried = new Set<number>()

    const options: ExecutorOptions<number, number> = {
      source: items,
      processor: (item) => {
        seen.add(item)
        return new Promise<number>((resolve, reject) => {
          setTimeout(() => {
            if (item % 2 === 0 && !retried.has(item)) {
              retried.add(item)
              reject(new Error(`transient ${item}`))
            } else {
              resolve(item * 10)
            }
          }, item % 2 === 0 ? 1 : 5)
        })
      },
      limit: startLimit(aimd({ ...DEFAULT_LIMIT_CONFIG, initial: 16, min: 1, max: 16 })),
      adapt: { latency: true, errors: true, rateLimit: true },
      retry: resolveRetryConfig({ retries: 2, jitter: false, minDelay: 1 }),
    }

    const { results, errors } = await execute(options)

    expect(seen.size).toBe(total)
    expect(results.length + errors.length).toBe(total)
    expect(errors).toEqual([])
    expect([...results].sort((a, b) => a - b)).toEqual(items.map((i) => i * 10))
  })
})

describe("executor: synchronous processors never deadlock", () => {
  it("resolves a single synchronous item", async () => {
    const r = await adaptiveMap([1], (x) => x * 2)
    expect(r.results).toEqual([2])
  }, 4000)

  it("resolves a synchronous 429-then-success (no retry budget consumed)", async () => {
    const r = await adaptiveMap(
      [1],
      (x, ctx) => {
        if (ctx.attempt === 1) throw new RateLimitError({ retryAfter: "0" })
        return x * 2
      },
      { concurrency: { initial: 1, min: 1, max: 1 } },
    )
    expect(r.results).toEqual([2])
    expect(r.errors).toEqual([])
    expect(r.stats.rateLimitEvents).toBeGreaterThanOrEqual(1)
  }, 4000)

  it("resolves many synchronous items below the concurrency cap", async () => {
    const items = Array.from({ length: 100 }, (_, i) => i)
    const r = await adaptiveMap(items, (x) => x, {
      concurrency: { initial: 3, min: 1, max: 8 },
    })
    expect(r.results.length).toBe(100)
    expect([...r.results].sort((a, b) => a - b)).toEqual(items)
  }, 4000)
})
