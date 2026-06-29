import pLimit from "p-limit"
import type { Adapter, BenchCtx } from "./shared"
import { tally, withRetry } from "./shared"

const adapter: Adapter = {
  meta: {
    name: "p-limit",
    category: "static",
    concurrencyMode: "fixed",
    native: { retry: false, retryAfter: false },
    notes: "concurrency from p-limit; uniform retry shim added",
  },
  run: async (ctx: BenchCtx) => {
    const limit = pLimit(ctx.concurrency)
    const settled = await Promise.allSettled(
      ctx.items.map((item) => limit(() => withRetry(ctx, item))),
    )
    return tally(settled)
  },
}

export default adapter
