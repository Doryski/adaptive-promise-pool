import { describe, it, expect } from "vitest"
import { AdaptivePool, adaptiveMap, StopThePoolError } from "../src/index"
import type { ConcurrencyChange } from "../src/types"

const sortNums = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b)

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe("AdaptivePool fluent + adaptiveMap shortcut (e2e)", () => {
  it("1. fluent happy path on an array: maps numbers to doubled", async () => {
    const input = [1, 2, 3, 4, 5, 6]
    const result = await AdaptivePool.for(input)
      .withConcurrency({ initial: 2, min: 1, max: 4 })
      .process(async (n) => n * 2)

    expect(sortNums(result.results)).toEqual([2, 4, 6, 8, 10, 12])
    expect(result.errors).toEqual([])
    expect(result.stats.performanceData).toHaveLength(input.length)
  })

  it("2. adaptiveMap shortcut produces equivalent results to fluent form", async () => {
    const input = [10, 20, 30, 40]
    const processor = async (n: number) => n + 1
    const opts = { concurrency: { initial: 2, min: 1, max: 3 } } as const

    const fluent = await AdaptivePool.for(input)
      .withConcurrency(opts.concurrency)
      .process(processor)
    const shortcut = await adaptiveMap(input, processor, opts)

    expect(sortNums(shortcut.results)).toEqual(sortNums(fluent.results))
    expect(sortNums(shortcut.results)).toEqual([11, 21, 31, 41])
    expect(shortcut.errors).toEqual([])
    expect(shortcut.stats.performanceData).toHaveLength(input.length)
  })

  it("3. type + runtime inference yields results: number[]", async () => {
    const input = [{ url: "https://a.io" }, { url: "https://example.com" }]
    const result = await AdaptivePool.for(input).process(
      async (item: { url: string }) => item.url.length,
    )

    const nums: number[] = result.results
    expect(nums.every((n) => typeof n === "number")).toBe(true)
    expect(sortNums(result.results)).toEqual(
      sortNums(input.map((i) => i.url.length)),
    )
  })

  it("4. defaults: no withRetry -> retry budget 0, item fails with attempts === 1", async () => {
    const attemptsByItem = new Map<string, number>()
    const result = await AdaptivePool.for(["ok-a", "bad", "ok-b"]).process(
      async (item) => {
        attemptsByItem.set(item, (attemptsByItem.get(item) ?? 0) + 1)
        if (item === "bad") throw new Error("boom")
        return item.toUpperCase()
      },
    )

    expect(sortNums([]).length).toBe(0)
    expect(result.results.sort()).toEqual(["OK-A", "OK-B"])
    expect(result.errors).toHaveLength(1)
    const failure = result.errors[0]!
    expect(failure.item).toBe("bad")
    expect(failure.attempts).toBe(1)
    expect(failure.error).toBeInstanceOf(Error)
    expect(result.stats.totalRetries).toBe(0)
    expect(attemptsByItem.get("bad")).toBe(1)
  })

  it("5. withRetry enables retries: throws once then succeeds", async () => {
    let calls = 0
    const result = await AdaptivePool.for(["task"])
      .withRetry({ retries: 2, jitter: false, minDelay: 1 })
      .process(async (item) => {
        calls += 1
        if (calls === 1) throw new Error("transient")
        return `${item}-done`
      })

    expect(result.results).toEqual(["task-done"])
    expect(result.errors).toEqual([])
    expect(result.stats.totalRetries).toBeGreaterThanOrEqual(1)
    expect(calls).toBe(2)
  })

  it("6. onConcurrencyChange receives {from,to,reason}; growth then error", async () => {
    const changes: ConcurrencyChange[] = []
    const total = 12
    const result = await AdaptivePool.for(Array.from({ length: total }, (_, i) => i))
      .withConcurrency({ initial: 1, min: 1, max: 8 })
      .adaptOn({ latency: true, errors: true, rateLimit: true })
      .onConcurrencyChange((c) => changes.push(c))
      .process(async (n) => {
        if (n >= total - 2) {
          await delay(2)
          throw new Error("late failure")
        }
        await delay(1)
        return n
      })

    const validReasons = new Set(["stable", "latency", "error", "rateLimit"])
    expect(changes.length).toBeGreaterThanOrEqual(1)
    for (const c of changes) {
      expect(typeof c.from).toBe("number")
      expect(typeof c.to).toBe("number")
      expect(validReasons.has(c.reason)).toBe(true)
    }
    expect(changes.some((c) => c.to !== c.from)).toBe(true)
    expect(result.errors.length).toBeGreaterThanOrEqual(1)
  })

  it("7. adaptOn errors:false -> throwing tasks do not cause congestion decrease", async () => {
    const initial = 3
    const result = await AdaptivePool.for([1, 2, 3, 4, 5])
      .withConcurrency({ initial, min: 1, max: 10 })
      .adaptOn({ latency: false, errors: false, rateLimit: false })
      .process(async () => {
        throw new Error("always throws")
      })

    expect(result.results).toEqual([])
    expect(result.errors).toHaveLength(5)
    for (const e of result.errors) {
      expect(e.attempts).toBe(1)
    }
    expect(result.stats.congestionEvents).toBe(0)
    expect(result.stats.finalConcurrency).toBe(initial)
  })

  it("8. AsyncIterable input via fluent (async generator)", async () => {
    async function* gen() {
      for (const n of [5, 6, 7]) {
        await delay(1)
        yield n
      }
    }

    const result = await AdaptivePool.for(gen())
      .withConcurrency({ initial: 2 })
      .process(async (n) => n * 10)

    expect(sortNums(result.results)).toEqual([50, 60, 70])
    expect(result.errors).toEqual([])
    expect(result.stats.performanceData).toHaveLength(3)
  })

  it("9. StopThePoolError stops processing early without hanging", async () => {
    const total = 20
    const result = await AdaptivePool.for(Array.from({ length: total }, (_, i) => i))
      .withConcurrency({ initial: 1, min: 1, max: 1 })
      .process(async (n) => {
        if (n === 3) throw new StopThePoolError("stop now")
        await delay(1)
        return n
      })

    const settled = result.results.length + result.errors.length
    expect(settled).toBeLessThan(total)
    expect(settled).toBeGreaterThanOrEqual(1)
  })

  it("10. empty input -> empty results/errors, sane stats", async () => {
    const initial = 4
    const result = await AdaptivePool.for([] as number[])
      .withConcurrency({ initial, min: 1, max: 8 })
      .process(async (n) => n * 2)

    expect(result.results).toEqual([])
    expect(result.errors).toEqual([])
    expect(result.stats.performanceData).toEqual([])
    expect(result.stats.finalConcurrency).toBe(initial)
    expect(result.stats.totalRetries).toBe(0)
    expect(result.stats.congestionEvents).toBe(0)
  })
})
