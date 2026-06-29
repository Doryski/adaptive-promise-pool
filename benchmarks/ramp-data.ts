import { writeFileSync } from "node:fs"
import { adaptiveMap, aimd, vegas, gradient2, RateLimitError } from "../src/index"
import { createFlakyApi, DEFAULT_FLAKY } from "./compare/flaky-api"
import type { BaseLimitState, Limit } from "../src/index"
import type { FlakyError } from "./compare/flaky-api"

const ITEMS = Array.from({ length: 240 }, (_, i) => i)

const capture = async <S extends BaseLimitState>(name: string, algorithm: Limit<S>) => {
  const api = createFlakyApi({ ...DEFAULT_FLAKY, seed: 7 })
  const changes: { i: number; to: number }[] = []
  let settled = 0
  const result = await adaptiveMap(
    ITEMS,
    async (item) => {
      try {
        const v = await api.attempt(item)
        settled += 1
        return v
      } catch (error) {
        settled += 1
        const e = error as FlakyError
        if (e.is429) throw new RateLimitError({ retryAfter: e.retryAfter ?? null })
        throw error
      }
    },
    {
      algorithm,
      adaptOn: { latency: true, errors: true, rateLimit: true },
      retry: { retries: 5, jitter: true, minDelay: 50 },
      onConcurrencyChange: (c) => changes.push({ i: settled, to: c.to }),
    },
  )
  const series = result.stats.performanceData.map((d) => d.concurrency)
  return { name, series, changes, final: result.stats.finalConcurrency, max: result.stats.maxConcurrencyReached }
}

const main = async () => {
  const bounds = { initial: 4, min: 1, max: 30 }
  const data = [
    await capture("aimd", aimd(bounds)),
    await capture("vegas", vegas(bounds)),
    await capture("gradient2", gradient2(bounds)),
  ]
  writeFileSync(new URL("./ramp-data.json", import.meta.url), JSON.stringify(data))
  for (const d of data) console.log(d.name, "points", d.series.length, "final", d.final, "max", d.max, "changes", d.changes.length)
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
