import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

type TimelineEntry = { t: number; status: number }

type Stats = {
  total: number
  rateLimited: number
  served: number
  timeline: TimelineEntry[]
  peakInFlight: number
}

type ServerHandle = { port: number; close: () => Promise<void> }

const HARD_CAP = 12
const SOFT_CAP = 6
const BASE_LATENCY_MS = 25
const RATE_LIMIT_PROB = 0.6
const RETRY_AFTER_SECONDS = 1

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const latencyFor = (inFlight: number): number => {
  if (inFlight <= SOFT_CAP) return BASE_LATENCY_MS
  const over = (inFlight - SOFT_CAP) / SOFT_CAP
  return BASE_LATENCY_MS * (1 + over * over * 3)
}

export const startServer = async (): Promise<ServerHandle> => {
  let inFlight = 0
  let peakInFlight = 0
  let total = 0
  let rateLimited = 0
  let served = 0
  let timeline: TimelineEntry[] = []
  const startedAt = Date.now()
  const now = () => Date.now() - startedAt

  const reset = () => {
    inFlight = 0
    peakInFlight = 0
    total = 0
    rateLimited = 0
    served = 0
    timeline = []
  }

  const handleWork = async (res: ServerResponse) => {
    inFlight += 1
    if (inFlight > peakInFlight) peakInFlight = inFlight
    total += 1
    const load = inFlight
    const arrival = now()
    try {
      const overHardCap = load > HARD_CAP
      if (overHardCap && Math.random() < RATE_LIMIT_PROB) {
        rateLimited += 1
        timeline.push({ t: arrival, status: 429 })
        res.writeHead(429, {
          "retry-after": String(RETRY_AFTER_SECONDS),
          "content-type": "application/json",
        })
        res.end(JSON.stringify({ error: "Too Many Requests" }))
        return
      }
      await sleep(latencyFor(load))
      served += 1
      timeline.push({ t: arrival, status: 200 })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    } finally {
      inFlight -= 1
    }
  }

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/"
    if (url.startsWith("/__stats")) {
      const stats: Stats = { total, rateLimited, served, timeline, peakInFlight }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(stats))
      return
    }
    if (url.startsWith("/__reset") && req.method === "POST") {
      reset()
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (url.startsWith("/work")) {
      void handleWork(res)
      return
    }
    res.writeHead(404)
    res.end()
  }

  const server = createServer(onRequest)

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port

  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    )

  return { port, close }
}

export type { Stats, TimelineEntry, ServerHandle }
