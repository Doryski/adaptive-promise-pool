import fetchRetryBuilder from "fetch-retry"
import type { Driver } from "../harness"
import { runWithGate, RETRY_BUDGET } from "./gate"

type FetchResponse = Awaited<ReturnType<typeof fetch>>

const fetchWithRetry = fetchRetryBuilder(fetch as typeof fetch, {
  retries: RETRY_BUDGET,
  retryOn: (_attempt: number, _error: Error | null, response: FetchResponse | null) =>
    response !== null && response.status === 429,
  retryDelay: (_attempt: number, _error: Error | null, response: FetchResponse | null) => {
    const header = response?.headers.get("retry-after")
    const seconds = header ? Number(header) : 0
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 100
  },
})

const driver: Driver = {
  name: "fetch-retry",
  mode: "fixed",
  run: (port, items, concurrency) =>
    runWithGate(items, concurrency, async (path) => {
      const res = await fetchWithRetry(`http://127.0.0.1:${port}${path}`)
      return res.ok
    }),
}

export default driver
