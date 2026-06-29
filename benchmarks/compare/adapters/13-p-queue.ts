import PQueue from "p-queue"
import type { Adapter, BenchCtx } from "./shared"
import { tally, withRetry } from "./shared"

const adapter: Adapter = {
  meta: {
    name: "p-queue",
    category: "static",
    concurrencyMode: "fixed",
    native: { retry: false, retryAfter: false },
    notes: "concurrency from p-queue; uniform retry shim added",
  },
  run: async (ctx: BenchCtx) => {
    const q = new PQueue({ concurrency: ctx.concurrency })
    const settled = await Promise.allSettled(
      ctx.items.map((item) => q.add(() => withRetry(ctx, item))),
    )
    return tally(settled)
  },
}

export default adapter
