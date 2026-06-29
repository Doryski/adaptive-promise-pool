import {
  makeBlockingLimiter,
  withLimiter,
  success,
  dropped,
  AIMDLimit,
  QuotaNotAvailable,
} from "adaptive-concurrency"
import type { Adapter, BenchCtx, FlakyErrorLike } from "./shared"
import { sleep } from "./shared"

const adapter: Adapter = {
  meta: {
    name: "adaptive-concurrency",
    category: "adaptive",
    concurrencyMode: "adaptive",
    native: { retry: false, retryAfter: false },
    notes:
      "Loss-based AIMDLimit tunes CONCURRENCY ceiling on dropped samples + RTT timeout (timeout=60ms latency backoff); min=1 max=50 initial=8 (default GradientLimit's minLimit=20 would pin at the hard cap, so AIMDLimit is used). Blocking backlog queues over-limit callers. 429 surfaced natively as `dropped` (congestion signal) AND retried free after Retry-After (adapter waits the header; lib does not parse it). Non-429 errors: `dropped` + bounded retry budget. One allotment per attempt.",
  },
  run: async (ctx: BenchCtx) => {
    const limit = new AIMDLimit({ initialLimit: 8, minLimit: 1, maxLimit: 50, timeout: 60 })
    const limiter = makeBlockingLimiter<void>({
      backlogSize: ctx.items.length,
      backlogTimeout: 60_000,
      limiter: { limit },
    })
    const run = withLimiter(limiter)

    const runItem = async (item: number): Promise<boolean> => {
      let budgetUsed = 0
      for (;;) {
        let retryAfter: string | undefined
        let permanent = false
        const result = await run(async () => {
          try {
            return success(await ctx.attempt(item))
          } catch (error) {
            const e = (error ?? {}) as FlakyErrorLike
            if (e.is429) {
              retryAfter = e.retryAfter
            } else {
              budgetUsed += 1
              if (budgetUsed > ctx.retries) permanent = true
            }
            return dropped(
              error instanceof Error ? error : new Error(String(e.status ?? "failed")),
            )
          }
        }).catch(() => QuotaNotAvailable)

        if (result !== QuotaNotAvailable && retryAfter === undefined && !permanent) return true
        if (retryAfter !== undefined) {
          await sleep(ctx.parseRetryAfter(retryAfter, Date.now()))
          continue
        }
        if (permanent || result === QuotaNotAvailable) return false
        await sleep(Math.min(2000, 50 * 2 ** (budgetUsed - 1)) * Math.random())
      }
    }

    let ok = 0
    let failed = 0
    await Promise.all(
      ctx.items.map(async (item) => {
        if (await runItem(item)) ok += 1
        else failed += 1
      }),
    )
    limiter.dispose()
    return { ok, failed }
  },
}

export default adapter
