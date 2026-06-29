import { adaptiveMap, RateLimitError } from "../../../dist/index.js"
import type { Adapter, BenchCtx, FlakyErrorLike } from "./shared"

const adapter: Adapter = {
  meta: {
    name: "adaptive-promise-pool",
    category: "ours",
    concurrencyMode: "adaptive",
    native: { retry: true, retryAfter: true },
    notes: "AIMD on latency+errors+429; pauses dispatch on Retry-After; 429 free of retry budget.",
  },
  run: async (ctx: BenchCtx) => {
    const { results, errors } = await adaptiveMap(
      ctx.items,
      async (item) => {
        try {
          return await ctx.attempt(item)
        } catch (error) {
          const e = error as FlakyErrorLike
          if (e.is429) throw new RateLimitError({ retryAfter: e.retryAfter ?? null })
          throw error
        }
      },
      {
        concurrency: { initial: 8, min: 1, max: 50 },
        adaptOn: { latency: true, errors: true, rateLimit: true },
        retry: { retries: ctx.retries, backoff: "exponential", jitter: true, minDelay: 50 },
      },
    )
    return { ok: results.length, failed: errors.length }
  },
}

export default adapter
