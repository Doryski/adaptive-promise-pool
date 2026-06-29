import { PromisePool } from "@supercharge/promise-pool"
import type { Adapter, BenchCtx } from "./shared"
import { withRetry } from "./shared"

const adapter: Adapter = {
  meta: {
    name: "@supercharge/promise-pool",
    category: "static",
    concurrencyMode: "fixed",
    native: { retry: false, retryAfter: false },
    notes: "concurrency from @supercharge/promise-pool; uniform retry shim added",
  },
  run: async (ctx: BenchCtx) => {
    const { results, errors } = await PromisePool.for(ctx.items)
      .withConcurrency(ctx.concurrency)
      .process((item) => withRetry(ctx, item))
    return { ok: results.length, failed: errors.length }
  },
}

export default adapter
