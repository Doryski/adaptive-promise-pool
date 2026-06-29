import Bottleneck from "bottleneck"
import type { Adapter, BenchCtx } from "./shared"
import { tally, withRetry } from "./shared"

const adapter: Adapter = {
  meta: {
    name: "bottleneck",
    category: "static",
    concurrencyMode: "fixed",
    native: { retry: false, retryAfter: false },
    notes: "concurrency from bottleneck; uniform retry shim added",
  },
  run: async (ctx: BenchCtx) => {
    const limiter = new Bottleneck({ maxConcurrent: ctx.concurrency })
    const settled = await Promise.allSettled(
      ctx.items.map((item) => limiter.schedule(() => withRetry(ctx, item))),
    )
    await limiter.disconnect()
    return tally(settled)
  },
}

export default adapter
