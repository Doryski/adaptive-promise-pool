import { SmartPool } from "promise-pool-smart"
import type { Adapter, BenchCtx, FlakyErrorLike } from "./shared"
import { sleep } from "./shared"

const adapter: Adapter = {
  meta: {
    name: "promise-pool-smart",
    category: "adaptive",
    concurrencyMode: "adaptive",
    native: { retry: false, retryAfter: false },
    notes:
      "AIMD on rolling-window P50 latency + error rate; limits CONCURRENCY. min=1 max=50 start=8. targetP50Ms=40 (just above the API's ~25ms healthy baseline so it sits near the soft cap, not the ~194ms wall; default 1000 never triggers). windowSize=12 so P50 tracks recent load (default 100 lags and overshoots). 429 surfaced natively: each attempt is a pool.run so the pool measures latency AND records the 429 as an error, then the item is retried free after Retry-After (adapter waits the header; lib does not parse it). Non-429 errors consume the bounded retry budget.",
  },
  run: async (ctx: BenchCtx) => {
    const pool = new SmartPool({
      min: 1,
      max: 50,
      start: 8,
      targetP50Ms: 40,
      targetErrorRate: 0.05,
      windowSize: 12,
    })

    const runItem = async (item: number): Promise<number> => {
      let budgetUsed = 0
      for (;;) {
        try {
          return await pool.run(() => ctx.attempt(item))
        } catch (error) {
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
    pool.destroy()
    return { ok, failed }
  },
}

export default adapter
