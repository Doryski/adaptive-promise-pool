import { adaptiveMap, RateLimitError } from "../src/index"
import type { AdaptiveMapOptions } from "../src/index"

const ITEM_COUNT = 400
const RUNS_PER_CONFIG = 3

const SOFT_CAP = 8
const HARD_CAP = 16
const BASE_LATENCY_MS = 40
const CONGESTION_K = 6
const RETRY_AFTER_SECONDS = 1

type ApiResponse =
  | { status: 200; value: number }
  | { status: 429; retryAfter: number }
  | { status: 500 }

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

type FlakyApi = {
  call: (index: number) => Promise<ApiResponse>
  peakInFlight: () => number
}

const createFlakyApi = (): FlakyApi => {
  let inFlight = 0
  let peakInFlight = 0

  const latencyFor = (load: number): number => {
    if (load <= SOFT_CAP) return BASE_LATENCY_MS
    const overload = (load - SOFT_CAP) / SOFT_CAP
    return BASE_LATENCY_MS * (1 + overload * overload * CONGESTION_K)
  }

  const call = async (index: number): Promise<ApiResponse> => {
    inFlight += 1
    if (inFlight > peakInFlight) peakInFlight = inFlight
    const load = inFlight
    try {
      await sleep(latencyFor(load))
      if (load > HARD_CAP) {
        const severity = (load - HARD_CAP) / HARD_CAP
        const roll = Math.random()
        if (roll < Math.min(0.6, 0.25 + severity * 0.5)) {
          return { status: 429, retryAfter: RETRY_AFTER_SECONDS }
        }
        if (roll < Math.min(0.7, 0.3 + severity * 0.5)) {
          return { status: 500 }
        }
      }
      return { status: 200, value: index * 2 }
    } finally {
      inFlight -= 1
    }
  }

  return { call, peakInFlight: () => peakInFlight }
}

const makeProcessor = (api: FlakyApi) => async (item: number): Promise<number> => {
  const response = await api.call(item)
  if (response.status === 429) {
    throw new RateLimitError({ retryAfter: response.retryAfter })
  }
  if (response.status === 500) {
    throw new Error("Simulated 500 Internal Server Error")
  }
  return response.value
}

type RunMetrics = {
  durationMs: number
  successes: number
  errors: number
  totalRetries: number
  rateLimitEvents: number
  congestionEvents: number
  maxConcurrencyReached: number
  finalConcurrency: number
  peakInFlight: number
}

const items = Array.from({ length: ITEM_COUNT }, (_, i) => i)

const runOnce = async (options: AdaptiveMapOptions): Promise<RunMetrics> => {
  const api = createFlakyApi()
  const processor = makeProcessor(api)

  const start = performance.now()
  const result = await adaptiveMap(items, processor, options)
  const durationMs = performance.now() - start

  return {
    durationMs,
    successes: result.results.length,
    errors: result.errors.length,
    totalRetries: result.stats.totalRetries,
    rateLimitEvents: result.stats.rateLimitEvents,
    congestionEvents: result.stats.congestionEvents,
    maxConcurrencyReached: result.stats.maxConcurrencyReached,
    finalConcurrency: result.stats.finalConcurrency,
    peakInFlight: api.peakInFlight(),
  }
}

const average = (values: number[]): number =>
  values.reduce((sum, v) => sum + v, 0) / values.length

const runConfig = async (
  label: string,
  options: AdaptiveMapOptions,
): Promise<RunMetrics & { label: string }> => {
  const runs: RunMetrics[] = []
  for (let i = 0; i < RUNS_PER_CONFIG; i += 1) {
    runs.push(await runOnce(options))
  }
  return {
    label,
    durationMs: average(runs.map((r) => r.durationMs)),
    successes: average(runs.map((r) => r.successes)),
    errors: average(runs.map((r) => r.errors)),
    totalRetries: average(runs.map((r) => r.totalRetries)),
    rateLimitEvents: average(runs.map((r) => r.rateLimitEvents)),
    congestionEvents: average(runs.map((r) => r.congestionEvents)),
    maxConcurrencyReached: average(runs.map((r) => r.maxConcurrencyReached)),
    finalConcurrency: average(runs.map((r) => r.finalConcurrency)),
    peakInFlight: average(runs.map((r) => r.peakInFlight)),
  }
}

const fixed = (n: number): AdaptiveMapOptions => ({
  concurrency: { initial: n, min: n, max: n },
  adaptOn: { latency: false, errors: false, rateLimit: false },
  retry: { retries: 5 },
})

const adaptive: AdaptiveMapOptions = {
  concurrency: { initial: 8, min: 1, max: 50 },
  adaptOn: { latency: true, errors: true, rateLimit: true },
  retry: { retries: 5 },
}

const fmt = (n: number, digits = 0): string => n.toFixed(digits)

const main = async (): Promise<void> => {
  console.log(
    `Benchmark: ${ITEM_COUNT} items, averaged over ${RUNS_PER_CONFIG} runs per config.`,
  )
  console.log(
    `Simulated API: base ${BASE_LATENCY_MS}ms, soft cap ${SOFT_CAP}, hard cap ${HARD_CAP}.\n`,
  )

  const configs = [
    await runConfig("Fixed c=4 (conservative)", fixed(4)),
    await runConfig("Fixed c=20 (aggressive)", fixed(20)),
    await runConfig("Adaptive (1-50)", adaptive),
  ]

  const header = [
    "Config",
    "Wall ms",
    "OK",
    "Err",
    "Retries",
    "429s",
    "Congest",
    "PeakInFlight",
    "FinalC",
  ]
  const rows = configs.map((c) => [
    c.label,
    fmt(c.durationMs),
    fmt(c.successes),
    fmt(c.errors),
    fmt(c.totalRetries),
    fmt(c.rateLimitEvents),
    fmt(c.congestionEvents),
    fmt(c.peakInFlight, 1),
    fmt(c.finalConcurrency, 1),
  ])

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  )
  const renderRow = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? cell.length)).join("  ")

  console.log(renderRow(header))
  console.log(renderRow(widths.map((w) => "-".repeat(w))))
  for (const row of rows) console.log(renderRow(row))
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
