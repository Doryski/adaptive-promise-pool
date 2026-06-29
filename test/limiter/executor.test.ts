import { describe, expect, it } from "vitest"

import { execute } from "../../src/limiter/executor"
import type { ExecutorOptions, ResolvedAdapt } from "../../src/limiter/executor"
import { resolveRetryConfig } from "../../src/limiter/retry"
import type { ResolvedRetryConfig } from "../../src/limiter/retry"
import { aimd } from "../../src/limit/aimd"
import { DEFAULT_LIMIT_CONFIG, startLimit } from "../../src/limit/types"
import type { LimitConfig, LimitStep } from "../../src/limit/types"
import { RateLimitError, StopThePoolError } from "../../src/errors"
import type { ConcurrencyChange, Processor, Source } from "../../src/types"
import { CHANGE_REASONS } from "../../src/limit/types"

const TEST_TIMEOUT = 5_000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const noAdapt: ResolvedAdapt = { latency: false, errors: false, rateLimit: false }

const makeLimit = (over: Partial<LimitConfig> = {}): LimitStep =>
  startLimit(aimd({ ...DEFAULT_LIMIT_CONFIG, initial: 3, min: 1, max: 3, ...over }))

const zeroRetry: ResolvedRetryConfig = resolveRetryConfig({ retries: 0 })

type RunOpts<T, R> = Partial<ExecutorOptions<T, R>> & {
  source: Source<T>
  processor: Processor<T, R>
}

const run = <T, R>(opts: RunOpts<T, R>) =>
  execute<T, R>({
    limit: makeLimit(),
    adapt: noAdapt,
    retry: zeroRetry,
    rng: () => 0,
    ...opts,
  })

describe("execute", () => {
  it(
    "empty source resolves with empty results/errors and does not throw",
    async () => {
      const res = await run<number, number>({
        source: [],
        processor: (x) => x,
      })
      expect(res.results).toEqual([])
      expect(res.errors).toEqual([])
    },
    TEST_TIMEOUT,
  )

  it(
    "maps all items; results are in COMPLETION order, not input order",
    async () => {
      const items = [1, 2, 3, 4, 5]
      const res = await run<number, number>({
        limit: makeLimit({ initial: 5, min: 5, max: 5 }),
        source: items,
        processor: async (x) => {
          await sleep((6 - x) * 30)
          return x * 10
        },
      })
      expect(res.results.length).toBe(items.length)
      expect([...res.results].sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50])
      expect(res.errors).toEqual([])
      expect(res.results).toEqual([50, 40, 30, 20, 10])
    },
    TEST_TIMEOUT,
  )

  it(
    "respects concurrency cap of 3 with adaptation OFF over 30 items",
    async () => {
      let activeNow = 0
      let observedMax = 0
      const items = Array.from({ length: 30 }, (_, i) => i)
      const res = await run<number, number>({
        limit: makeLimit({ initial: 3, min: 3, max: 3 }),
        adapt: noAdapt,
        source: items,
        processor: async (x) => {
          activeNow += 1
          observedMax = Math.max(observedMax, activeNow)
          await sleep(15)
          activeNow -= 1
          return x
        },
      })
      expect(res.results.length).toBe(30)
      expect(observedMax).toBeLessThanOrEqual(3)
      expect(observedMax).toBeGreaterThan(1)
      expect(res.stats.maxConcurrencyReached).toBe(3)
    },
    TEST_TIMEOUT,
  )

  it(
    "additive increase: concurrency grows under stable fast latency",
    async () => {
      const items = Array.from({ length: 60 }, (_, i) => i)
      const res = await run<number, number>({
        limit: makeLimit({ initial: 2, min: 1, max: 50, stabilityWindow: 2 }),
        adapt: { latency: true, errors: false, rateLimit: false },
        source: items,
        processor: async (x) => {
          await sleep(5)
          return x
        },
      })
      expect(res.results.length).toBe(60)
      expect(res.stats.maxConcurrencyReached).toBeGreaterThan(2)
    },
    TEST_TIMEOUT,
  )

  it(
    "multiplicative decrease on errors with retries:0",
    async () => {
      const items = Array.from({ length: 20 }, (_, i) => i)
      const res = await run<number, number>({
        limit: makeLimit({ initial: 10, min: 1, max: 10 }),
        adapt: { latency: false, errors: true, rateLimit: false },
        retry: resolveRetryConfig({ retries: 0 }),
        source: items,
        processor: () => {
          throw new Error("boom")
        },
      })
      expect(res.results).toEqual([])
      expect(res.errors.length).toBe(20)
      for (const e of res.errors) expect(e.attempts).toBe(1)
      expect(res.stats.congestionEvents).toBeGreaterThan(0)
      expect(res.stats.finalConcurrency).toBeLessThan(10)
    },
    TEST_TIMEOUT,
  )

  it(
    "retry budget: totalRetries, ctx.attempt increments, eventual success and permanent failure",
    async () => {
      const attemptsSeen = new Map<string, number[]>()
      const failCounts = new Map<string, number>([
        ["recover", 2],
        ["always", Number.POSITIVE_INFINITY],
        ["ok", 0],
      ])
      const calls = new Map<string, number>()

      const res = await execute<string, string>({
        limit: makeLimit({ initial: 2, min: 1, max: 2 }),
        adapt: noAdapt,
        retry: resolveRetryConfig({ retries: 3 }),
        rng: () => 0,
        source: ["recover", "always", "ok"],
        processor: (item, ctx) => {
          const arr = attemptsSeen.get(item) ?? []
          arr.push(ctx.attempt)
          attemptsSeen.set(item, arr)
          const soFar = (calls.get(item) ?? 0) + 1
          calls.set(item, soFar)
          const mustFail = soFar <= (failCounts.get(item) ?? 0)
          if (mustFail) throw new Error(`fail ${item} #${soFar}`)
          return `done:${item}`
        },
      })

      expect(res.results.sort()).toEqual(["done:ok", "done:recover"])
      expect(res.errors.length).toBe(1)
      expect(res.errors[0]?.item).toBe("always")
      expect(res.errors[0]?.attempts).toBe(4)

      expect(attemptsSeen.get("recover")).toEqual([1, 2, 3])
      expect(attemptsSeen.get("always")).toEqual([1, 2, 3, 4])
      expect(attemptsSeen.get("ok")).toEqual([1])

      expect(res.stats.totalRetries).toBe(5)
    },
    TEST_TIMEOUT,
  )

  it(
    "AsyncIterable source is processed identically to an array",
    async () => {
      async function* gen() {
        for (const v of [1, 2, 3, 4]) {
          await sleep(2)
          yield v
        }
      }
      const res = await run<number, number>({
        limit: makeLimit({ initial: 2, min: 2, max: 2 }),
        source: gen(),
        processor: async (x) => {
          await sleep(5)
          return x * 2
        },
      })
      expect(res.results.length).toBe(4)
      expect([...res.results].sort((a, b) => a - b)).toEqual([2, 4, 6, 8])
      expect(res.errors).toEqual([])
    },
    TEST_TIMEOUT,
  )

  it(
    "sync Iterable source (Set) works",
    async () => {
      const set = new Set([10, 20, 30])
      const res = await run<number, number>({
        source: set,
        processor: async (x) => {
          await sleep(3)
          return x + 1
        },
      })
      expect([...res.results].sort((a, b) => a - b)).toEqual([11, 21, 31])
      expect(res.errors).toEqual([])
    },
    TEST_TIMEOUT,
  )

  it(
    "StopThePoolError halts dispatch; some items remain unprocessed and no hang",
    async () => {
      const items = Array.from({ length: 40 }, (_, i) => i)
      const SENTINEL = 5
      const res = await run<number, number>({
        limit: makeLimit({ initial: 2, min: 2, max: 2 }),
        source: items,
        processor: async (x) => {
          await sleep(10)
          if (x === SENTINEL) throw new StopThePoolError()
          return x
        },
      })
      const handled = res.results.length + res.errors.length
      expect(handled).toBeLessThan(items.length)
    },
    TEST_TIMEOUT,
  )

  it(
    "taskTimeout: slow tasks become errors (retries:0); fast tasks still succeed",
    async () => {
      const slow = new Set([2, 5, 7])
      const items = Array.from({ length: 10 }, (_, i) => i)
      const res = await run<number, number>({
        limit: makeLimit({ initial: 4, min: 4, max: 4 }),
        taskTimeout: 50,
        retry: resolveRetryConfig({ retries: 0 }),
        source: items,
        processor: async (x) => {
          await sleep(slow.has(x) ? 300 : 5)
          return x
        },
      })
      expect(res.errors.length).toBe(slow.size)
      const erroredItems = res.errors.map((e) => e.item).sort((a, b) => a - b)
      expect(erroredItems).toEqual([2, 5, 7])
      for (const e of res.errors) {
        expect(e.error.message).toMatch(/timed out/i)
        expect(e.attempts).toBe(1)
      }
      expect(res.results.length).toBe(7)
    },
    TEST_TIMEOUT,
  )

  it(
    "onConcurrencyChange fires with {from,to,reason}, to!==from, valid reason",
    async () => {
      const changes: ConcurrencyChange[] = []
      const items = Array.from({ length: 60 }, (_, i) => i)
      await run<number, number>({
        limit: makeLimit({ initial: 2, min: 1, max: 50, stabilityWindow: 2 }),
        adapt: { latency: true, errors: false, rateLimit: false },
        onConcurrencyChange: (c) => changes.push(c),
        source: items,
        processor: async (x) => {
          await sleep(5)
          return x
        },
      })
      expect(changes.length).toBeGreaterThan(0)
      for (const c of changes) {
        expect(c.to).not.toBe(c.from)
        expect(CHANGE_REASONS).toContain(c.reason)
      }
    },
    TEST_TIMEOUT,
  )

  it(
    "already-aborted AbortSignal resolves quickly with no/few results and no hang",
    async () => {
      const controller = new AbortController()
      controller.abort()
      const items = Array.from({ length: 30 }, (_, i) => i)
      const res = await run<number, number>({
        signal: controller.signal,
        source: items,
        processor: async (x) => {
          await sleep(20)
          return x
        },
      })
      expect(res.results.length + res.errors.length).toBeLessThan(items.length)
    },
    TEST_TIMEOUT,
  )

  it(
    "aborting partway stops further processing",
    async () => {
      const controller = new AbortController()
      const items = Array.from({ length: 60 }, (_, i) => i)
      setTimeout(() => controller.abort(), 30)
      const res = await run<number, number>({
        limit: makeLimit({ initial: 2, min: 2, max: 2 }),
        signal: controller.signal,
        source: items,
        processor: async (x) => {
          await sleep(15)
          return x
        },
      })
      const handled = res.results.length + res.errors.length
      expect(handled).toBeGreaterThan(0)
      expect(handled).toBeLessThan(items.length)
    },
    TEST_TIMEOUT,
  )

  it(
    "RateLimitError retries without consuming budget and records rateLimitEvents",
    async () => {
      let firstTime = true
      const res = await execute<string, string>({
        limit: makeLimit({ initial: 4, min: 1, max: 4 }),
        adapt: { latency: false, errors: false, rateLimit: true },
        retry: resolveRetryConfig({ retries: 0 }),
        rng: () => 0,
        source: ["a"],
        processor: () => {
          if (firstTime) {
            firstTime = false
            throw new RateLimitError({ retryAfter: 0 })
          }
          return "ok"
        },
      })
      expect(res.results).toEqual(["ok"])
      expect(res.errors).toEqual([])
      expect(res.stats.rateLimitEvents).toBeGreaterThan(0)
    },
    TEST_TIMEOUT,
  )
})
