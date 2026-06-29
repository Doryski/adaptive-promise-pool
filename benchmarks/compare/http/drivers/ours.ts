import { adaptiveMap, RateLimitError } from "../../../../dist/index.js"
import type { Driver } from "../harness"
import { RETRY_BUDGET } from "./gate"

const driver: Driver = {
  name: "adaptive-promise-pool",
  mode: "adaptive",
  run: async (port, items) => {
    const { results, errors } = await adaptiveMap(
      items,
      async (path: string) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`)
        if (res.status === 429) {
          throw new RateLimitError({ retryAfter: res.headers.get("retry-after") })
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.status
      },
      {
        concurrency: { initial: 8, min: 1, max: 40 },
        adaptOn: { latency: true, errors: true, rateLimit: true },
        retry: { retries: RETRY_BUDGET, backoff: "exponential", jitter: true, minDelay: 50 },
      },
    )
    return { ok: results.length, failed: errors.length }
  },
}

export default driver
