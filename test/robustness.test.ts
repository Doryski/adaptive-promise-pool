import { describe, expect, it } from "vitest"

import { RateLimitError, StopThePoolError } from "../src/errors"
import { adaptiveMap } from "../src/pool"
import type { ProcessContext } from "../src/types"

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

describe("ctx.signal cancellation", () => {
  it("aborts the signal when a task hits taskTimeout", async () => {
    let observedAborted: boolean | null = null

    const result = await adaptiveMap(
      [1],
      async (_item, ctx: ProcessContext) => {
        await delay(200, ctx.signal)
        observedAborted = ctx.signal.aborted
        return _item
      },
      { taskTimeout: 20, retry: { retries: 0 }, concurrency: { initial: 1 } },
    )

    expect(observedAborted).toBe(true)
    expect(result.results).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.error.message).toContain("timed out")
  })

  it("aborts in-flight tasks when StopThePoolError is thrown", async () => {
    let longTaskAborted: boolean | null = null

    await adaptiveMap(
      [1, 2],
      async (item, ctx: ProcessContext) => {
        if (item === 1) {
          await delay(20)
          throw new StopThePoolError()
        }
        await delay(500, ctx.signal)
        longTaskAborted = ctx.signal.aborted
        return item
      },
      { retry: { retries: 0 }, concurrency: { initial: 2 } },
    )

    expect(longTaskAborted).toBe(true)
  })

  it("aborts in-flight tasks when the global signal fires", async () => {
    let observedAborted: boolean | null = null
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)

    await adaptiveMap(
      [1],
      async (item, ctx: ProcessContext) => {
        await delay(500, ctx.signal)
        observedAborted = ctx.signal.aborted
        return item
      },
      { signal: controller.signal, retry: { retries: 0 }, concurrency: { initial: 1 } },
    )

    expect(observedAborted).toBe(true)
  })
})

describe("maxRateLimitRetries", () => {
  it("bounds an always-429 endpoint and ends the item in errors", async () => {
    const result = await adaptiveMap(
      [1],
      async () => {
        throw new RateLimitError({ retryAfter: "0" })
      },
      { retry: { retries: 0, maxRateLimitRetries: 2 }, concurrency: { initial: 1 } },
    )

    expect(result.results).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.error).toBeInstanceOf(RateLimitError)
  }, 5000)

  it("retries 429 unlimited by default and eventually succeeds", async () => {
    let calls = 0

    const result = await adaptiveMap(
      [1],
      async (item) => {
        calls += 1
        if (calls <= 3) throw new RateLimitError({ retryAfter: "0" })
        return item
      },
      { retry: { retries: 0 }, concurrency: { initial: 1 } },
    )

    expect(calls).toBe(4)
    expect(result.results).toEqual([1])
    expect(result.errors).toHaveLength(0)
  }, 5000)
})

describe("graceful source-iterator error", () => {
  it("rejects with the iterator error after draining without hanging", async () => {
    const processed: number[] = []

    async function* source() {
      yield 1
      yield 2
      throw new Error("bad iterable")
    }

    await expect(
      adaptiveMap(
        source(),
        async (item) => {
          processed.push(item)
          return item
        },
        { retry: { retries: 0 }, concurrency: { initial: 1 } },
      ),
    ).rejects.toThrow("bad iterable")

    expect(processed).toEqual([1, 2])
  }, 5000)
})
