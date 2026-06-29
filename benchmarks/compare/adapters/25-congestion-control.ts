// @ts-expect-error - no types provided by the package
import pkg from "congestion-control"
import type { Adapter, BenchCtx, FlakyErrorLike } from "./shared"
import { sleep, tally } from "./shared"

type Congestion = (ops?: {
  initialWindowSize?: number
  retries?: number
  maximumWindowSize?: number
}) => <T>(task: () => Promise<T>) => Promise<T>

const { Congestion } = pkg as unknown as { Congestion: Congestion }

const adapter: Adapter = {
  meta: {
    name: "congestion-control",
    category: "adaptive",
    concurrencyMode: "adaptive",
    native: { retry: true, retryAfter: false },
    notes:
      "TCP-window CONCURRENCY control: window grows on success streak, shrinks on any failure; native retry re-queues failed tasks. Uses its OWN retry/congestion loop (failures are the adaptive signal, so the success-only shim is bypassed). Retry-After honoured manually (sleep before the 429 propagates). ctx.concurrency seeds initialWindowSize.",
  },
  run: async (ctx: BenchCtx) => {
    const addTask = Congestion({
      initialWindowSize: ctx.concurrency,
      retries: ctx.retries,
      maximumWindowSize: 50,
    })

    const settled = await Promise.allSettled(
      ctx.items.map((item) =>
        addTask(async () => {
          try {
            return await ctx.attempt(item)
          } catch (error) {
            const e = (error ?? {}) as FlakyErrorLike
            if (e.is429) {
              const delay = ctx.parseRetryAfter(e.retryAfter, Date.now())
              await sleep(delay)
            }
            throw error
          }
        }),
      ),
    )
    return tally(settled)
  },
}

export default adapter
