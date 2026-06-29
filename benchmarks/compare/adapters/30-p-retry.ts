import pLimit from "p-limit"
import pRetry from "p-retry"
import type { Adapter, BenchCtx, FlakyErrorLike } from "./shared"
import { tally } from "./shared"

const is429 = (error: unknown): error is FlakyErrorLike =>
  typeof error === "object" && error !== null && (error as FlakyErrorLike).is429 === true

const adapter: Adapter = {
  meta: {
    name: "p-retry",
    category: "retry",
    concurrencyMode: "fixed",
    native: { retry: true, retryAfter: false },
    notes:
      "Native exponential-backoff RETRY only; no concurrency control. We cap parallelism with a p-limit gate (ctx.concurrency) and honour Retry-After manually via onFailedAttempt (p-retry does not read the header itself). 429s skip the retry budget via shouldConsumeRetry. LACKS adaptive concurrency and native rate-limit handling.",
  },
  run: async (ctx: BenchCtx) => {
    const limit = pLimit(ctx.concurrency)
    const settled = await Promise.allSettled(
      ctx.items.map((item) =>
        limit(() =>
          pRetry(() => ctx.attempt(item), {
            retries: ctx.retries,
            minTimeout: 50,
            factor: 2,
            randomize: true,
            unref: true,
            shouldConsumeRetry: ({ error }) => !is429(error),
            onFailedAttempt: async ({ error }) => {
              if (is429(error)) {
                const delay = ctx.parseRetryAfter((error as FlakyErrorLike).retryAfter, Date.now())
                if (delay > 0) await new Promise<void>((r) => setTimeout(r, delay))
              }
            },
          }),
        ),
      ),
    )
    return tally(settled)
  },
}

export default adapter
