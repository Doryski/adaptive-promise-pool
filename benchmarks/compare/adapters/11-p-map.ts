import pMap from "p-map"
import type { Adapter, BenchCtx } from "./shared"
import { tally, withRetry } from "./shared"

const adapter: Adapter = {
  meta: {
    name: "p-map",
    category: "static",
    concurrencyMode: "fixed",
    native: { retry: false, retryAfter: false },
    notes: "concurrency from p-map; uniform retry shim added",
  },
  run: async (ctx: BenchCtx) => {
    const settled = await pMap(
      ctx.items,
      async (item): Promise<PromiseSettledResult<number>> => {
        try {
          const value = await withRetry(ctx, item)
          return { status: "fulfilled", value }
        } catch (reason) {
          return { status: "rejected", reason }
        }
      },
      { concurrency: ctx.concurrency, stopOnError: false },
    )
    return tally(settled)
  },
}

export default adapter
