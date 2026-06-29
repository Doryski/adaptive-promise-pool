import { SimpleLimiter, AimdLimit } from "@adaptive-concurrency-toolkit/core"
import type { Adapter, BenchCtx, FlakyErrorLike } from "./shared"
import { sleep } from "./shared"

const MS_TO_NANOS = 1_000_000
const RTT_TIMEOUT_NANOS = 100 * MS_TO_NANOS
const UTILIZATION_THRESHOLD = 0.9

const adapter: Adapter = {
  meta: {
    name: "@adaptive-concurrency-toolkit/core",
    category: "adaptive",
    concurrencyMode: "adaptive",
    native: { retry: false, retryAfter: false },
    notes:
      "AimdLimit tunes CONCURRENCY ceiling on RTT + drop signals; min=1 max=50 initial=8. 429 surfaced natively as onDropped() (congestion signal) AND retried free after Retry-After (adapter waits the header; lib does not parse it). Non-429 errors: onDropped() + bounded retry budget. rttTimeoutNanos=~100ms adds a latency backoff. One permit per attempt; SimpleLimiter spin-waits (no queue).",
  },
  run: async (ctx: BenchCtx) => {
    const limit = new AimdLimit({
      initialLimit: 8,
      minLimit: 1,
      maxLimit: 50,
      rttTimeoutNanos: RTT_TIMEOUT_NANOS,
      utilizationThreshold: UTILIZATION_THRESHOLD,
    })
    const limiter = new SimpleLimiter(limit)

    const acquire = async () => {
      for (;;) {
        const listener = limiter.acquire()
        if (listener) return listener
        await sleep(5)
      }
    }

    const runItem = async (item: number): Promise<number> => {
      let budgetUsed = 0
      for (;;) {
        const listener = await acquire()
        try {
          const value = await ctx.attempt(item)
          listener.onSuccess()
          return value
        } catch (error) {
          listener.onDropped()
          const e = (error ?? {}) as FlakyErrorLike
          if (e.is429) {
            await sleep(ctx.parseRetryAfter(e.retryAfter, Date.now()))
            continue
          }
          budgetUsed += 1
          if (budgetUsed > ctx.retries) throw error
          await sleep(Math.min(2000, 50 * 2 ** (budgetUsed - 1)) * Math.random())
        }
      }
    }

    let ok = 0
    let failed = 0
    await Promise.all(
      ctx.items.map(async (item) => {
        try {
          await runItem(item)
          ok += 1
        } catch {
          failed += 1
        }
      }),
    )
    return { ok, failed }
  },
}

export default adapter
