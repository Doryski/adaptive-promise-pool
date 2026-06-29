import { performance } from "node:perf_hooks"
import type { Stats, TimelineEntry } from "./server"

export type Driver = {
  name: string
  mode: string
  run: (port: number, items: string[], concurrency: number) => Promise<{ ok: number; failed: number }>
}

export type DriverResult = {
  name: string
  mode: string
  wallMs: number
  ok: number
  failed: number
  hits: number
  rateLimited: number
  arrivalsDuringRetryAfter: number
}

const RETRY_AFTER_WINDOW_MS = 1000

const fetchStats = async (port: number): Promise<Stats> => {
  const res = await fetch(`http://127.0.0.1:${port}/__stats`)
  return (await res.json()) as Stats
}

const resetServer = async (port: number): Promise<void> => {
  await fetch(`http://127.0.0.1:${port}/__reset`, { method: "POST" })
}

export const arrivalsDuringRetryAfter = (timeline: readonly TimelineEntry[]): number => {
  const sorted = [...timeline].sort((a, b) => a.t - b.t)
  const rateLimitTimes = sorted.filter((e) => e.status === 429).map((e) => e.t)
  if (rateLimitTimes.length === 0) return 0
  let counted = 0
  for (const entry of sorted) {
    const arrival = entry.t
    const inWindow = rateLimitTimes.some(
      (t429) => arrival > t429 && arrival <= t429 + RETRY_AFTER_WINDOW_MS,
    )
    if (inWindow) counted += 1
  }
  return counted
}

export const runDriver = async (
  driver: Driver,
  port: number,
  items: string[],
  concurrency: number,
): Promise<DriverResult> => {
  await resetServer(port)
  const start = performance.now()
  const { ok, failed } = await driver.run(port, items, concurrency)
  const wallMs = performance.now() - start
  const stats = await fetchStats(port)
  return {
    name: driver.name,
    mode: driver.mode,
    wallMs,
    ok,
    failed,
    hits: stats.total,
    rateLimited: stats.rateLimited,
    arrivalsDuringRetryAfter: arrivalsDuringRetryAfter(stats.timeline),
  }
}
