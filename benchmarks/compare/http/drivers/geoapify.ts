import rateLimiter from "@geoapify/request-rate-limiter"

const { rateLimitedRequests } = rateLimiter
import type { Driver } from "../harness"
import { RETRY_BUDGET } from "./gate"

const REQUESTS_PER_INTERVAL = 16
const INTERVAL_MS = 1000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const requestWithRetry = async (port: number, path: string): Promise<boolean> => {
  for (let attempt = 0; attempt <= RETRY_BUDGET; attempt += 1) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`)
    if (res.status !== 429) return res.ok
    const header = res.headers.get("retry-after")
    const seconds = header ? Number(header) : 0
    await sleep(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 100)
  }
  return false
}

const driver: Driver = {
  name: "@geoapify/request-rate-limiter",
  mode: "rate-limited",
  run: async (port, items) => {
    const requests = items.map((path) => () => requestWithRetry(port, path))
    const results = await rateLimitedRequests<boolean>(
      requests,
      REQUESTS_PER_INTERVAL,
      INTERVAL_MS,
    )
    const ok = results.filter(Boolean).length
    return { ok, failed: results.length - ok }
  },
}

export default driver
