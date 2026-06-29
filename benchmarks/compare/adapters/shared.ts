export type { Adapter, BenchCtx, RunResult, AdapterCategory } from "../types"
import type { BenchCtx } from "../types"

export type FlakyErrorLike = {
  is429?: boolean
  is500?: boolean
  retryAfter?: string
  status?: number
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const is429 = (error: unknown): error is FlakyErrorLike =>
  typeof error === "object" && error !== null && (error as FlakyErrorLike).is429 === true

/**
 * Uniform retry shim for libraries that have NO native retry. Honours
 * Retry-After on 429 (waits the indicated delay, free of budget) and uses
 * exponential backoff on other errors. Adapters that use this MUST set
 * `meta.native.retry = false` so the table reflects that we added it.
 */
export const withRetry = async (
  ctx: BenchCtx,
  item: number,
): Promise<number> => {
  let budgetUsed = 0
  for (;;) {
    try {
      return await ctx.attempt(item)
    } catch (error) {
      if (is429(error)) {
        const delay = ctx.parseRetryAfter((error as FlakyErrorLike).retryAfter, Date.now())
        await sleep(delay)
        continue
      }
      budgetUsed += 1
      if (budgetUsed > ctx.retries) throw error
      await sleep(Math.min(2000, 50 * 2 ** (budgetUsed - 1)) * Math.random())
    }
  }
}

/** Tally settled outcomes from an array of Promise.allSettled results. */
export const tally = (
  settled: PromiseSettledResult<unknown>[],
): { ok: number; failed: number } => {
  let ok = 0
  let failed = 0
  for (const r of settled) {
    if (r.status === "fulfilled") ok += 1
    else failed += 1
  }
  return { ok, failed }
}
