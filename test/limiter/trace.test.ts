import { describe, expect, it } from "vitest"

import { AdaptivePool, adaptiveMap } from "../../src/pool"
import { RateLimitError } from "../../src/errors"
import type { AdaptiveResult, TraceEvent } from "../../src/types"

const TEST_TIMEOUT = 5_000

const collect = () => {
  const events: TraceEvent[] = []
  return { events, onTrace: (e: TraceEvent) => events.push(e) }
}

const byKind = <K extends TraceEvent["kind"]>(
  events: TraceEvent[],
  kind: K,
): Extract<TraceEvent, { kind: K }>[] =>
  events.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind)

describe("trace hooks", () => {
  it(
    "emits a matching taskStart/taskEnd for every successful task",
    async () => {
      const { events, onTrace } = collect()
      const items = [1, 2, 3, 4]
      await adaptiveMap(items, (x) => x * 10, { onTrace })

      const starts = byKind(events, "taskStart")
      const ends = byKind(events, "taskEnd")
      expect(starts.length).toBe(items.length)
      expect(ends.length).toBe(items.length)

      for (const end of ends) {
        expect(end.ok).toBe(true)
        expect(end.error).toBeUndefined()
        expect(end.durationMs).toBeGreaterThanOrEqual(0)
        const start = starts.find((s) => s.index === end.index && s.attempt === end.attempt)
        expect(start).toBeDefined()
        expect(events.indexOf(start!)).toBeLessThan(events.indexOf(end))
        expect(end.concurrency).toBe(start!.concurrency)
      }
    },
    TEST_TIMEOUT,
  )

  it(
    "exposes Vegas decision internals (queue/baseRtt/probeRtt) in decision events",
    async () => {
      const { events, onTrace } = collect()
      await adaptiveMap(
        Array.from({ length: 30 }, (_, i) => i),
        async () => {
          await new Promise((r) => setTimeout(r, 2))
          return 1
        },
        { onTrace, concurrency: { initial: 2 } },
      )

      const withMetrics = byKind(events, "decision").filter((d) => d.metrics !== undefined)
      expect(withMetrics.length).toBeGreaterThan(0)
      for (const d of withMetrics) {
        expect(typeof d.metrics!.queue).toBe("number")
        expect(typeof d.metrics!.baseRtt).toBe("number")
        expect(typeof d.metrics!.probeRtt).toBe("number")
      }
    },
    TEST_TIMEOUT,
  )

  it(
    "emits a retry(cause=error) event and re-runs the task with an incremented attempt",
    async () => {
      const { events, onTrace } = collect()
      const failedOnce = new Set<number>()
      await adaptiveMap(
        [0, 1, 2],
        (x: number) => {
          if (!failedOnce.has(x)) {
            failedOnce.add(x)
            throw new Error(`boom ${x}`)
          }
          return x
        },
        { onTrace, retry: { retries: 2, minDelay: 1, jitter: false } },
      )

      const retries = byKind(events, "retry")
      expect(retries.length).toBe(3)
      for (const r of retries) {
        expect(r.cause).toBe("error")
        expect(r.attempt).toBe(1)
        expect(r.delayMs).toBeGreaterThanOrEqual(0)
        expect(r.readyAt).toBeGreaterThanOrEqual(r.ts)
      }
      const secondAttempts = byKind(events, "taskStart").filter((s) => s.attempt === 2)
      expect(secondAttempts.map((s) => s.index).sort()).toEqual([0, 1, 2])

      const failedEnds = byKind(events, "taskEnd").filter((e) => !e.ok)
      expect(failedEnds.length).toBe(3)
      expect(failedEnds.every((e) => e.error instanceof Error)).toBe(true)
    },
    TEST_TIMEOUT,
  )

  it(
    "emits ratePause and retry(cause=rateLimit) on a RateLimitError",
    async () => {
      const { events, onTrace } = collect()
      const limited = new Set<number>()
      await adaptiveMap(
        [0, 1],
        (x: number) => {
          if (!limited.has(x)) {
            limited.add(x)
            throw new RateLimitError({ retryAfter: 0.02 })
          }
          return x
        },
        { onTrace },
      )

      const pauses = byKind(events, "ratePause")
      expect(pauses.length).toBeGreaterThanOrEqual(1)
      for (const p of pauses) {
        expect(p.retryAfterMs).toBeGreaterThanOrEqual(0)
        expect(p.until).toBeGreaterThanOrEqual(p.ts)
      }
      const rlRetries = byKind(events, "retry").filter((r) => r.cause === "rateLimit")
      expect(rlRetries.length).toBeGreaterThanOrEqual(1)
    },
    TEST_TIMEOUT,
  )

  it(
    "emits concurrencyChange trace events alongside the onConcurrencyChange callback",
    async () => {
      const { events, onTrace } = collect()
      const callbackChanges: number[] = []
      await adaptiveMap(
        Array.from({ length: 20 }, (_, i) => i),
        () => 1,
        {
          onTrace,
          concurrency: { initial: 2 },
          onConcurrencyChange: (c) => callbackChanges.push(c.to),
        },
      )
      const traceChanges = byKind(events, "concurrencyChange")
      expect(traceChanges.length).toBe(callbackChanges.length)
      expect(traceChanges.map((c) => c.to)).toEqual(callbackChanges)
    },
    TEST_TIMEOUT,
  )

  it(
    "fires onFinish exactly once with the same result the run resolves to",
    async () => {
      let received: AdaptiveResult<number, number> | undefined
      let calls = 0
      const result = await adaptiveMap([1, 2, 3], (x) => x * 2, {
        onFinish: (r) => {
          calls += 1
          received = r as AdaptiveResult<number, number>
        },
      })
      expect(calls).toBe(1)
      expect(received).toBe(result)
    },
    TEST_TIMEOUT,
  )

  it(
    "leaves results unchanged when no hooks are registered",
    async () => {
      const items = [1, 2, 3, 4, 5]
      const withHooks = await AdaptivePool.for(items)
        .withConcurrency({ initial: 1, min: 1, max: 1 })
        .withTrace(() => {})
        .process((x) => x * 3)
      const without = await AdaptivePool.for(items)
        .withConcurrency({ initial: 1, min: 1, max: 1 })
        .process((x) => x * 3)
      expect(withHooks.results).toEqual(without.results)
      expect(withHooks.errors).toEqual(without.errors)
    },
    TEST_TIMEOUT,
  )
})
