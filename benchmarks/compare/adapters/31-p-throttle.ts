import pThrottle from "p-throttle"
import type { Adapter, BenchCtx } from "./shared"
import { tally, withRetry } from "./shared"

const INTERVAL_MS = 200

const adapter: Adapter = {
  meta: {
    name: "p-throttle",
    category: "rate",
    concurrencyMode: "fixed",
    native: { retry: false, retryAfter: false },
    notes:
      "Native RATE limit only (X calls per interval) — bounds throughput, NOT in-flight concurrency. We map ctx.concurrency calls per 200ms window; retry + Retry-After added via the shared withRetry shim. LACKS retry, Retry-After awareness, and adaptive concurrency; rate cap is fixed and unaware of server backpressure.",
  },
  run: async (ctx: BenchCtx) => {
    const throttle = pThrottle({ limit: ctx.concurrency, interval: INTERVAL_MS })
    const throttledAttempt = throttle((item: number) => ctx.attempt(item))
    const throttledCtx: BenchCtx = { ...ctx, attempt: (item) => throttledAttempt(item) }
    const settled = await Promise.allSettled(
      ctx.items.map((item) => withRetry(throttledCtx, item)),
    )
    return tally(settled)
  },
}

export default adapter
