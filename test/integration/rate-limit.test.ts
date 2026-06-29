import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

import { AdaptivePool, RateLimitError } from "../../src/index"

/**
 * A real local HTTP server whose per-path behaviour is configured per test via
 * `routes`. Every incoming request is timestamped (epoch-ms at arrival) and the
 * 429-response timestamps are recorded so tests can prove dispatch paused.
 */
type RouteState = {
  /** Number of 429s to emit before switching to 200, per path. */
  rateLimitTimes: number
  /** Raw `Retry-After` header value sent with each 429. */
  retryAfter: string
  /** Number of 500s to emit before switching to 200, per path. */
  errorTimes: number
  /** Hits seen so far for this path. */
  hits: number
}

type Recorded = {
  /** Arrival timestamp of every request, in order. */
  arrivals: { url: string; at: number; status: number }[]
  /** Arrival timestamp of every request that received a 429. */
  rateLimited: number[]
}

let server: Server
let port: number
const routes = new Map<string, RouteState>()
let recorded: Recorded

const resetRecording = () => {
  routes.clear()
  recorded = { arrivals: [], rateLimited: [] }
}

const defineRoute = (path: string, partial: Partial<RouteState>) => {
  routes.set(path, {
    rateLimitTimes: 0,
    retryAfter: "1",
    errorTimes: 0,
    hits: 0,
    ...partial,
  })
}

const handler = (req: IncomingMessage, res: ServerResponse) => {
  const now = Date.now()
  const url = req.url ?? "/"
  const route = routes.get(url)

  if (!route) {
    recorded.arrivals.push({ url, at: now, status: 404 })
    res.writeHead(404).end("not found")
    return
  }

  const hit = route.hits
  route.hits += 1

  if (hit < route.rateLimitTimes) {
    recorded.arrivals.push({ url, at: now, status: 429 })
    recorded.rateLimited.push(now)
    res.writeHead(429, { "Retry-After": route.retryAfter }).end("rate limited")
    return
  }

  const errBudget = route.rateLimitTimes + route.errorTimes
  if (hit < errBudget) {
    recorded.arrivals.push({ url, at: now, status: 500 })
    res.writeHead(500).end("boom")
    return
  }

  recorded.arrivals.push({ url, at: now, status: 200 })
  res.writeHead(200, { "Content-Type": "application/json" }).end(
    JSON.stringify({ ok: true, url }),
  )
}

beforeAll(async () => {
  server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})

const fetchPath = async (path: string) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  if (res.status === 429) {
    throw new RateLimitError({ retryAfter: res.headers.get("retry-after") })
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

describe("rate-limit integration (real HTTP server)", () => {
  it(
    "pauses dispatch on Retry-After and retries every item to success (headline DoD)",
    async () => {
      resetRecording()
      const items = ["/gate", "/work", "/work", "/work", "/work", "/work"]
      defineRoute("/gate", { rateLimitTimes: 1, retryAfter: "1" })
      defineRoute("/work", {})

      const { results, errors, stats } = await AdaptivePool.for(items)
        .withConcurrency({ initial: 1, min: 1, max: 8 })
        .adaptOn({ latency: true, errors: true, rateLimit: true })
        .withRetry({ retries: 2, backoff: "exponential", jitter: false })
        .process((path) => fetchPath(path))

      expect(results).toHaveLength(items.length)
      expect(errors).toHaveLength(0)

      expect(stats.rateLimitEvents).toBeGreaterThanOrEqual(1)

      const firstRateLimited = recorded.rateLimited[0]!
      expect(firstRateLimited).toBeDefined()

      const after = recorded.arrivals
        .filter((a) => a.at > firstRateLimited)
        .sort((x, y) => x.at - y.at)

      expect(after.length).toBeGreaterThan(0)
      const gap = after[0]!.at - firstRateLimited
      expect(gap).toBeGreaterThanOrEqual(900)
    },
    15000,
  )

  it(
    "does NOT consume the retry budget on repeated 429s (more 429s than retries)",
    async () => {
      resetRecording()
      defineRoute("/budget", { rateLimitTimes: 3, retryAfter: "1" })

      const { results, errors, stats } = await AdaptivePool.for([0])
        .withConcurrency({ initial: 2, min: 1, max: 4 })
        .adaptOn({ latency: true, errors: true, rateLimit: true })
        .withRetry({ retries: 2, backoff: "exponential", jitter: false })
        .process(() => fetchPath("/budget"))

      expect(results).toHaveLength(1)
      expect(errors).toHaveLength(0)

      const budgetHits = recorded.arrivals.filter((a) => a.url === "/budget")
      expect(budgetHits).toHaveLength(4)
      expect(budgetHits.filter((a) => a.status === 429)).toHaveLength(3)

      expect(stats.rateLimitEvents).toBeGreaterThanOrEqual(3)
      expect(stats.totalRetries).toBeGreaterThanOrEqual(3)
    },
    15000,
  )

  it(
    "narrows concurrency on 429 (multiplicative decrease)",
    async () => {
      resetRecording()
      defineRoute("/narrow", { rateLimitTimes: 1, retryAfter: "1" })

      const lows: number[] = []
      const { stats } = await AdaptivePool.for([0, 1, 2, 3, 4, 5, 6, 7])
        .withConcurrency({ initial: 8, min: 1, max: 8 })
        .adaptOn({ latency: true, errors: true, rateLimit: true })
        .withRetry({ retries: 2, backoff: "exponential", jitter: false })
        .onConcurrencyChange((change) => lows.push(change.to))
        .process(() => fetchPath("/narrow"))

      expect(stats.rateLimitEvents).toBeGreaterThanOrEqual(1)
      const minConcurrency = Math.min(...lows)
      expect(minConcurrency).toBeLessThan(8)
      expect(stats.maxConcurrencyReached).toBe(8)
    },
    15000,
  )

  it(
    "partitions mixed 200 / 500 / 429 outcomes and keeps stats internally consistent",
    async () => {
      resetRecording()
      defineRoute("/ok", {})
      defineRoute("/fail", { errorTimes: 99 })
      defineRoute("/limited", { rateLimitTimes: 1, retryAfter: "1" })

      type Job = { path: string }
      const jobs: Job[] = [
        { path: "/ok" },
        { path: "/ok" },
        { path: "/limited" },
        { path: "/fail" },
      ]

      const { results, errors, stats } = await AdaptivePool.for(jobs)
        .withConcurrency({ initial: 4, min: 1, max: 8 })
        .adaptOn({ latency: true, errors: true, rateLimit: true })
        .withRetry({ retries: 2, backoff: "constant", jitter: false, minDelay: 20 })
        .process((job) => fetchPath(job.path))

      expect(results).toHaveLength(3)
      expect(errors).toHaveLength(1)
      expect(errors[0]!.item.path).toBe("/fail")
      expect(errors[0]!.attempts).toBe(3)
      expect(errors[0]!.error.message).toBe("HTTP 500")

      expect(stats.rateLimitEvents).toBe(1)
      expect(stats.congestionEvents).toBeGreaterThanOrEqual(1)
      expect(stats.totalRetries).toBe(3)
    },
    15000,
  )

  it(
    "honors an HTTP-date Retry-After by pausing dispatch ~1s",
    async () => {
      resetRecording()
      const httpDate = new Date(Date.now() + 2000).toUTCString()
      defineRoute("/httpdate", { rateLimitTimes: 1, retryAfter: httpDate })

      const { results, errors, stats } = await AdaptivePool.for([0, 1, 2])
        .withConcurrency({ initial: 1, min: 1, max: 6 })
        .adaptOn({ latency: true, errors: true, rateLimit: true })
        .withRetry({ retries: 2, backoff: "exponential", jitter: false })
        .process(() => fetchPath("/httpdate"))

      expect(results).toHaveLength(3)
      expect(errors).toHaveLength(0)
      expect(stats.rateLimitEvents).toBeGreaterThanOrEqual(1)

      const firstRateLimited = recorded.rateLimited[0]!
      expect(firstRateLimited).toBeDefined()

      const after = recorded.arrivals
        .filter((a) => a.at > firstRateLimited)
        .sort((x, y) => x.at - y.at)

      expect(after.length).toBeGreaterThan(0)
      const gap = after[0]!.at - firstRateLimited
      expect(gap).toBeGreaterThanOrEqual(900)
    },
    15000,
  )

  it(
    "bounds the Retry-After pause with maxRetryAfter",
    async () => {
      resetRecording()
      defineRoute("/bounded", { rateLimitTimes: 1, retryAfter: "5" })

      const { results, errors, stats } = await AdaptivePool.for([0, 1, 2])
        .withConcurrency({ initial: 1, min: 1, max: 6 })
        .adaptOn({ latency: true, errors: true, rateLimit: true })
        .withRetry({ retries: 2, backoff: "exponential", jitter: false, maxRetryAfter: 50 })
        .process(() => fetchPath("/bounded"))

      expect(results).toHaveLength(3)
      expect(errors).toHaveLength(0)
      expect(stats.rateLimitEvents).toBeGreaterThanOrEqual(1)

      const firstRateLimited = recorded.rateLimited[0]!
      expect(firstRateLimited).toBeDefined()

      const after = recorded.arrivals
        .filter((a) => a.at > firstRateLimited)
        .sort((x, y) => x.at - y.at)

      expect(after.length).toBeGreaterThan(0)
      const gap = after[0]!.at - firstRateLimited
      expect(gap).toBeLessThan(2_000)
    },
    15000,
  )
})
