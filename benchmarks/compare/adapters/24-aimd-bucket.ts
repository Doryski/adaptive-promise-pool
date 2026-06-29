import { AIMDBucket } from "aimd-bucket"
import type { Adapter, BenchCtx, FlakyErrorLike } from "./shared"
import { sleep } from "./shared"

const adapter: Adapter = {
  meta: {
    name: "aimd-bucket",
    category: "rate",
    concurrencyMode: "adaptive",
    native: { retry: false, retryAfter: false },
    notes:
      "AIMD token bucket controls RATE (tokens/sec), not concurrency: additive-increase on success, multiplicative-decrease past failure threshold. 429 surfaced natively via token.rateLimited() (its dedicated 429 outcome) AND retried free after Retry-After (adapter waits the header; lib does not parse it). Non-429 errors: token.failure() + bounded retry budget. No concurrency min/max exposed (rate-based); minRate=1 maxRate=200 initialRate=8.",
  },
  run: async (ctx: BenchCtx) => {
    const bucket = new AIMDBucket({
      initialRate: 8,
      minRate: 1,
      maxRate: 200,
      windowMs: 2_000,
    })

    const runItem = async (item: number): Promise<number> => {
      let budgetUsed = 0
      for (;;) {
        const token = await bucket.acquire()
        try {
          const value = await ctx.attempt(item)
          token.success()
          return value
        } catch (error) {
          const e = (error ?? {}) as FlakyErrorLike
          if (e.is429) {
            token.rateLimited()
            await sleep(ctx.parseRetryAfter(e.retryAfter, Date.now()))
            continue
          }
          token.failure()
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
    await bucket.shutdown()
    return { ok, failed }
  },
}

export default adapter
