import { describe, expect, it } from "vitest"

import { AdaptivePool, adaptiveMap } from "../../src/pool"
import { aimd } from "../../src/limit/aimd"
import { vegas } from "../../src/limit/vegas"
import { gradient2 } from "../../src/limit/gradient2"
import { CHANGE_REASONS } from "../../src/limit/types"
import type { BaseLimitState, Limit } from "../../src/limit/types"
import type { AdaptiveResult } from "../../src/types"

const items = Array.from({ length: 80 }, (_, i) => i)
const slow = (x: number) =>
  new Promise<number>((resolve) => setTimeout(() => resolve(x * 2), 4 + (x % 4)))

const runWith = async <S extends BaseLimitState>(
  algo: Limit<S>,
): Promise<{ result: AdaptiveResult<number, number>; reasons: string[] }> => {
  const reasons: string[] = []
  const result = await AdaptivePool.for(items)
    .adaptOn({ latency: true, errors: true, rateLimit: true })
    .withAlgorithm(algo)
    .onConcurrencyChange((c) => reasons.push(c.reason))
    .process(slow)
  return { result, reasons }
}

const cases: [string, () => ReturnType<typeof runWith>][] = [
  ["aimd", () => runWith(aimd({ initial: 4, min: 1, max: 16 }))],
  ["vegas", () => runWith(vegas({ initial: 4, min: 1, max: 16 }))],
  ["gradient2", () => runWith(gradient2({ initial: 4, min: 1, max: 16 }))],
]

describe("pluggable Limit algorithms via the public API", () => {
  it.each(cases)("%s drives a full run through withAlgorithm", async (_name, run) => {
    const { result, reasons } = await run()
    expect(result.results.length).toBe(items.length)
    expect(result.errors).toEqual([])
    expect(result.stats.finalConcurrency).toBeGreaterThanOrEqual(1)
    expect(result.stats.finalConcurrency).toBeLessThanOrEqual(16)
    expect(result.stats.maxConcurrencyReached).toBeLessThanOrEqual(16)
    for (const reason of reasons) expect(CHANGE_REASONS).toContain(reason)
  })

  it("accepts an algorithm through the adaptiveMap shortcut", async () => {
    const { results, errors } = await adaptiveMap(items, slow, {
      algorithm: vegas({ initial: 3, min: 1, max: 12 }),
    })
    expect(results.length).toBe(items.length)
    expect(errors).toEqual([])
  })

  it("respects each algorithm's own bounds, not withConcurrency", async () => {
    const { stats } = await AdaptivePool.for(items)
      .withConcurrency({ initial: 99, min: 50, max: 99 })
      .adaptOn({ latency: true })
      .withAlgorithm(gradient2({ initial: 2, min: 1, max: 6 }))
      .process(slow)
    expect(stats.maxConcurrencyReached).toBeLessThanOrEqual(6)
  })
})
