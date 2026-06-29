import { performance } from "node:perf_hooks"
import { createFlakyApi, DEFAULT_FLAKY } from "./flaky-api"
import { parseRetryAfter } from "./retry-after"
import { registry } from "./adapters/registry"
import type { Adapter } from "./types"

const ITEM_COUNT = 450
const RETRIES = 5
const RUNS = 3
const FIXED_GUESSES = [5, 10, 18] as const

const capacityAt = (hit: number): { softCap: number; hardCap: number } => {
  if (hit < 150) return { softCap: 18, hardCap: 100000 }
  if (hit < 300) return { softCap: 4, hardCap: 100000 }
  return { softCap: 12, hardCap: 100000 }
}

const DYNAMIC = { ...DEFAULT_FLAKY, capacityAt }
const items = Array.from({ length: ITEM_COUNT }, (_, i) => i)

const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)

const runOnce = async (adapter: Adapter, concurrency: number) => {
  const api = createFlakyApi({ ...DYNAMIC })
  const start = performance.now()
  const result = await adapter.run({ items, attempt: api.attempt, concurrency, retries: RETRIES, parseRetryAfter })
  const wall = performance.now() - start
  const m = api.metrics()
  return { wall, ok: result.ok, fail: result.failed, rl: m.rateLimited, peak: m.peakInFlight }
}

const average = async (adapter: Adapter, concurrency: number) => {
  const runs = []
  for (let i = 0; i < RUNS; i += 1) runs.push(await runOnce(adapter, concurrency))
  return {
    wall: mean(runs.map((r) => r.wall)),
    ok: mean(runs.map((r) => r.ok)),
    fail: mean(runs.map((r) => r.fail)),
    rl: mean(runs.map((r) => r.rl)),
    peak: mean(runs.map((r) => r.peak)),
  }
}

const row = (name: string, m: { wall: number; ok: number; fail: number; rl: number; peak: number }) =>
  console.log(name.padEnd(34), String(m.wall).padStart(7), String(m.ok).padStart(4), String(m.fail).padStart(5), String(m.rl).padStart(5), String(m.peak).padStart(5))

const main = async () => {
  console.log(`Dynamic (moving latency knee, no 429s): ${ITEM_COUNT} items, ${RUNS} runs avg.`)
  console.log("Knee shifts: hits 0-150 soft=18, 150-300 soft=4, 300+ soft=12.")
  console.log("name".padEnd(34), "wall".padStart(7), "ok".padStart(4), "fail".padStart(5), "429".padStart(5), "peak".padStart(5))
  console.log("-".repeat(64))
  const keep = new Set([
    "adaptive-promise-pool",
    "@adaptive-concurrency-toolkit/core",
    "congestion-control",
  ])
  const adaptive = registry.filter((a) => a.meta.concurrencyMode === "adaptive" && keep.has(a.meta.name))
  const fixed = registry.filter(
    (a) => a.meta.concurrencyMode === "fixed" && a.meta.category !== "rate" && a.meta.name === "@supercharge/promise-pool",
  )
  for (const a of adaptive) row(a.meta.name, await average(a, 8))
  console.log("-".repeat(64))
  for (const a of fixed) {
    for (const c of FIXED_GUESSES) row(`fixed c=${c}`, await average(a, c))
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
