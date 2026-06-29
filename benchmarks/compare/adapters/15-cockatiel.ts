import { bulkhead, ExponentialBackoff, handleAll, retry, wrap } from "cockatiel"
import type { Adapter, BenchCtx } from "./shared"
import { tally } from "./shared"

const adapter: Adapter = {
  meta: {
    name: "cockatiel",
    category: "static",
    concurrencyMode: "fixed",
    native: { retry: true, retryAfter: false },
    notes: "native bulkhead concurrency + native retry policy (exponential backoff); no Retry-After parsing",
  },
  run: async (ctx: BenchCtx) => {
    const policy = wrap(
      bulkhead(ctx.concurrency, Infinity),
      retry(handleAll, { maxAttempts: ctx.retries, backoff: new ExponentialBackoff() }),
    )
    const settled = await Promise.allSettled(
      ctx.items.map((item) => policy.execute(() => ctx.attempt(item))),
    )
    return tally(settled)
  },
}

export default adapter
