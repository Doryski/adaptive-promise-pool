/** One hit against the simulated flaky API. Resolves on 2xx, throws on 429/500. */
export type AttemptFn = (item: number) => Promise<number>

export type BenchCtx = {
  items: number[]
  /**
   * Perform ONE API call for `item`. Resolves with a value on success. On a
   * simulated 429 it throws an error with `.is429 === true` and `.retryAfter`
   * (a delta-seconds string); on a 500 it throws an error with `.is500 === true`.
   */
  attempt: AttemptFn
  /** Concurrency guess handed to fixed-concurrency libraries. */
  concurrency: number
  /** Retry budget handed to libraries that support retry. */
  retries: number
  /** Shared Retry-After parser (delta-seconds or HTTP date) → delay ms. */
  parseRetryAfter: (value: string | number | null | undefined, now: number) => number
}

/** Counts of items the adapter completed vs permanently failed. */
export type RunResult = { ok: number; failed: number }

export type AdapterCategory = "ours" | "static" | "adaptive" | "retry" | "rate"

export type Adapter = {
  meta: {
    name: string
    category: AdapterCategory
    /** "fixed" honours ctx.concurrency; "adaptive" self-tunes; "none" = unbounded. */
    concurrencyMode: "fixed" | "adaptive" | "none"
    native: {
      retry: boolean
      retryAfter: boolean
    }
    /** Short note on what the library natively provides vs. what the adapter adds. */
    notes: string
  }
  run: (ctx: BenchCtx) => Promise<RunResult>
}
