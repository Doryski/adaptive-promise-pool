import { performance } from "node:perf_hooks"
import { adaptiveMap, aimd, vegas, gradient2, RateLimitError } from "../../src/index"
import { createFlakyApi, DEFAULT_FLAKY } from "./flaky-api"
import type { BaseLimitState, Limit } from "../../src/index"
import type { FlakyConfig, FlakyError } from "./flaky-api"

const ITEMS = Array.from({ length: 300 }, (_, i) => i)
const RUNS = 3
const SEED_OFFSETS = [0, 1, 2] as const

const processor = (api: ReturnType<typeof createFlakyApi>) => async (item: number) => {
  try {
    return await api.attempt(item)
  } catch (error) {
    const e = error as FlakyError
    if (e.is429) throw new RateLimitError({ retryAfter: e.retryAfter ?? null })
    throw error
  }
}

type Metrics = { wall: number; ok: number; fail: number; rl: number; peak: number; final: number }

const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)

const measure = async (run: () => Promise<{ ok: number; fail: number; final: number }>, api: () => ReturnType<typeof createFlakyApi>) => {
  void api
  return run
}

let FLAKY = { ...DEFAULT_FLAKY }

const seedsFor = (cfg: FlakyConfig) => SEED_OFFSETS.map((o) => cfg.seed + o)

const runStatic = async (c: number): Promise<Metrics> => {
  const runs: Metrics[] = []
  for (const seed of seedsFor(FLAKY))
  for (let i = 0; i < RUNS; i += 1) {
    const api = createFlakyApi({ ...FLAKY, seed })
    const start = performance.now()
    const r = await adaptiveMap(ITEMS, processor(api), {
      concurrency: { initial: c, min: c, max: c },
      adaptOn: { latency: false, errors: false, rateLimit: false },
      retry: { retries: 5, jitter: true, minDelay: 50 },
    })
    const wall = performance.now() - start
    const m = api.metrics()
    runs.push({ wall, ok: r.results.length, fail: r.errors.length, rl: m.rateLimited, peak: m.peakInFlight, final: r.stats.finalConcurrency })
  }
  return collapse(runs)
}

const runOurs = async <S extends BaseLimitState>(algo: () => Limit<S>): Promise<Metrics> => {
  const runs: Metrics[] = []
  for (const seed of seedsFor(FLAKY))
  for (let i = 0; i < RUNS; i += 1) {
    const api = createFlakyApi({ ...FLAKY, seed })
    const start = performance.now()
    const r = await adaptiveMap(ITEMS, processor(api), {
      algorithm: algo(),
      adaptOn: { latency: true, errors: true, rateLimit: true },
      retry: { retries: 5, jitter: true, minDelay: 50 },
    })
    const wall = performance.now() - start
    const m = api.metrics()
    runs.push({ wall, ok: r.results.length, fail: r.errors.length, rl: m.rateLimited, peak: m.peakInFlight, final: r.stats.finalConcurrency })
  }
  return collapse(runs)
}

const collapse = (runs: Metrics[]): Metrics => ({
  wall: mean(runs.map((r) => r.wall)),
  ok: mean(runs.map((r) => r.ok)),
  fail: mean(runs.map((r) => r.fail)),
  rl: mean(runs.map((r) => r.rl)),
  peak: mean(runs.map((r) => r.peak)),
  final: mean(runs.map((r) => r.final)),
})

const row = (name: string, m: Metrics) =>
  console.log(
    name.padEnd(28),
    String(m.wall).padStart(7),
    String(m.ok).padStart(4),
    String(m.fail).padStart(4),
    String(m.rl).padStart(4),
    String(m.peak).padStart(5),
    String(m.final).padStart(5),
  )

const scenarios = [
  { name: "A default soft8/hard20/base25", cfg: { ...DEFAULT_FLAKY }, statics: [8, 9, 10, 11, 12] },
  { name: "B tight soft5/hard12/base40", cfg: { ...DEFAULT_FLAKY, softCap: 5, hardCap: 12, baseLatencyMs: 40, seed: 99 }, statics: [4, 5, 6, 7, 8] },
  { name: "C loose soft15/hard35/base15", cfg: { ...DEFAULT_FLAKY, softCap: 15, hardCap: 35, baseLatencyMs: 15, seed: 321 }, statics: [12, 16, 18, 20, 24] },
  { name: "D highcap soft30/hard60/base10", cfg: { ...DEFAULT_FLAKY, softCap: 30, hardCap: 60, baseLatencyMs: 10, seed: 555 }, statics: [24, 30, 36, 42, 48] },
]

const main = async () => {
  console.log(`Generalization: 300 items, avg over ${SEED_OFFSETS.length} seeds × ${RUNS} runs. Candidate = vegas/gradient2/aimd DEFAULTS (initial 8, min 1, max 50).`)
  const b = { initial: 8, min: 1, max: 50 }
  for (const s of scenarios) {
    FLAKY = s.cfg
    console.log(`\n=== ${s.name} ===`)
    console.log("name".padEnd(28), "wall".padStart(7), "ok".padStart(4), "fail".padStart(4), "429".padStart(4), "peak".padStart(5), "final".padStart(5))
    console.log("-".repeat(64))
    for (const c of s.statics) row(`static c=${c}`, await runStatic(c))
    console.log("-".repeat(64))
    row("vegas (default)", await runOurs(() => vegas(b)))
    row("gradient2 (default)", await runOurs(() => gradient2(b)))
    row("aimd (default)", await runOurs(() => aimd(b)))
  }
}

void measure
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
