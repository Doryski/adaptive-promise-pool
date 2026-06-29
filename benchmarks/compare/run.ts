import { performance } from "node:perf_hooks"
import { createFlakyApi, DEFAULT_FLAKY } from "./flaky-api"
import { parseRetryAfter } from "./retry-after"
import { registry } from "./adapters/registry"
import type { Adapter } from "./types"

const ITEM_COUNT = 300
const RETRIES = 5
const SEEDS = [1, 2, 3] as const
const RUNS_PER_SEED = 3
const FIXED_GUESSES = [4, 12, 24] as const

const items = Array.from({ length: ITEM_COUNT }, (_, i) => i)

type Row = {
  name: string
  mode: string
  setting: string
  wallMedian: number
  wallSd: number
  wallMin: number
  wallMax: number
  ok: number
  failed: number
  hits: number
  rl: number
  se: number
  retries: number
  peak: number
  retryAfter: boolean
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

const stddev = (xs: number[]) => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
}

const TIMEOUT_MS = 120_000

const runOnce = async (adapter: Adapter, concurrency: number, seed: number) => {
  const api = createFlakyApi({ ...DEFAULT_FLAKY, seed })
  const start = performance.now()
  const result = await Promise.race([
    adapter.run({
      items,
      attempt: api.attempt,
      concurrency,
      retries: RETRIES,
      parseRetryAfter,
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("adapter timed out")), TIMEOUT_MS),
    ),
  ])
  const wallMs = performance.now() - start
  const m = api.metrics()
  return {
    wallMs,
    ok: result.ok,
    failed: result.failed,
    hits: m.hits,
    rl: m.rateLimited,
    se: m.serverErrors,
    retries: Math.max(0, m.hits - ITEM_COUNT),
    peak: m.peakInFlight,
  }
}

const average = async (adapter: Adapter, concurrency: number, setting: string): Promise<Row> => {
  const runs = []
  for (const seed of SEEDS)
    for (let i = 0; i < RUNS_PER_SEED; i += 1) runs.push(await runOnce(adapter, concurrency, seed))
  const wall = runs.map((r) => r.wallMs)
  return {
    name: adapter.meta.name,
    mode: adapter.meta.concurrencyMode,
    setting,
    wallMedian: median(wall),
    wallSd: stddev(wall),
    wallMin: Math.min(...wall),
    wallMax: Math.max(...wall),
    ok: Math.round(median(runs.map((r) => r.ok))),
    failed: Math.round(median(runs.map((r) => r.failed))),
    hits: Math.round(median(runs.map((r) => r.hits))),
    rl: Math.round(median(runs.map((r) => r.rl))),
    se: Math.round(median(runs.map((r) => r.se))),
    retries: Math.round(median(runs.map((r) => r.retries))),
    peak: Math.round(median(runs.map((r) => r.peak))),
    retryAfter: adapter.meta.native.retryAfter,
  }
}

const pad = (s: string | number, n: number, right = false) => {
  const str = String(s)
  return right ? str.padEnd(n) : str.padStart(n)
}

const printTable = (rows: Row[]) => {
  const header = [
    pad("Library", 34, true),
    pad("Mode", 9, true),
    pad("Conc", 5),
    pad("Wall ms (median ± sd)", 22, true),
    pad("OK", 4),
    pad("Fail", 5),
    pad("Hits", 5),
    pad("429", 4),
    pad("500", 4),
    pad("Retry", 6),
    pad("Peak", 5),
    pad("RA", 3),
  ].join("  ")
  console.log(header)
  console.log("-".repeat(header.length))
  for (const r of rows) {
    console.log(
      [
        pad(r.name, 34, true),
        pad(r.mode, 9, true),
        pad(r.setting, 5),
        pad(`${r.wallMedian.toFixed(0)} ± ${r.wallSd.toFixed(0)}`, 22, true),
        pad(r.ok, 4),
        pad(r.failed, 5),
        pad(r.hits, 5),
        pad(r.rl, 4),
        pad(r.se, 4),
        pad(r.retries, 6),
        pad(r.peak, 5),
        pad(r.retryAfter ? "y" : "n", 3),
      ].join("  "),
    )
  }
}

const main = async () => {
  const samples = SEEDS.length * RUNS_PER_SEED
  console.log(
    `Comparison: ${ITEM_COUNT} items, retry budget ${RETRIES}.\n` +
      `Wall ms reported as median ± sd over ${SEEDS.length} seeds × ${RUNS_PER_SEED} runs ` +
      `(= ${samples} samples); other columns are medians (rounded).\n` +
      `Treat rows whose median ± sd ranges OVERLAP as a statistical tie — not a winner.\n` +
      `Flaky API: base ${DEFAULT_FLAKY.baseLatencyMs}ms, soft cap ${DEFAULT_FLAKY.softCap}, ` +
      `hard cap ${DEFAULT_FLAKY.hardCap}, Retry-After ${DEFAULT_FLAKY.retryAfterSeconds}s.\n` +
      `Fixed-concurrency libs are tested at guesses ${FIXED_GUESSES.join("/")} (the optimum is unknown);\n` +
      `adaptive libs self-tune.\n`,
  )
  const rows: Row[] = []
  const safeAverage = async (adapter: Adapter, c: number, setting: string) => {
    try {
      rows.push(await average(adapter, c, setting))
    } catch (err) {
      console.error(`\n  ! ${adapter.meta.name} (${setting}) failed: ${(err as Error).message}`)
    }
  }
  for (const adapter of registry) {
    if (adapter.meta.concurrencyMode === "fixed") {
      const guesses = adapter.meta.category === "rate" ? [12] : FIXED_GUESSES
      for (const c of guesses) await safeAverage(adapter, c, `c=${c}`)
    } else {
      await safeAverage(adapter, 8, "auto")
    }
    process.stdout.write(".")
  }
  process.stdout.write("\n\n")
  printTable(rows)
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
