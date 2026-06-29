import { RateLimiter } from "limiter"
import type { Adapter, BenchCtx } from "./shared"
import { tally, withRetry } from "./shared"

const adapter: Adapter = {
  meta: {
    name: "limiter",
    category: "rate",
    concurrencyMode: "fixed",
    native: { retry: false, retryAfter: false },
    notes:
      "Native token-bucket RATE limit only — removeTokens(1) gates each call to ~ctx.concurrency tokens/sec; bounds throughput, NOT in-flight concurrency. Retry + Retry-After added via the shared withRetry shim. LACKS retry, Retry-After awareness, and adaptive concurrency; rate is a fixed cap blind to server backpressure.",
  },
  run: async (ctx: BenchCtx) => {
    const limiter = new RateLimiter({
      tokensPerInterval: ctx.concurrency,
      interval: "second",
    })
    const gatedCtx: BenchCtx = {
      ...ctx,
      attempt: async (item) => {
        await limiter.removeTokens(1)
        return ctx.attempt(item)
      },
    }
    const settled = await Promise.allSettled(
      ctx.items.map((item) => withRetry(gatedCtx, item)),
    )
    return tally(settled)
  },
}

export default adapter
