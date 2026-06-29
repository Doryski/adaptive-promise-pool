import { startServer } from "./server"
import { runDriver, type Driver, type DriverResult } from "./harness"
import ours from "./drivers/ours"
import ky from "./drivers/ky"
import got from "./drivers/got"
import axiosRetry from "./drivers/axios-retry"
import fetchRetry from "./drivers/fetch-retry"
import fetchRateLimitUtil from "./drivers/fetch-rate-limit-util"
import geoapify from "./drivers/geoapify"

const ITEM_COUNT = 200
const CONCURRENCY_SWEEP = [6, 10, 16] as const
const SINGLE_RUN_CONCURRENCY = 16

const drivers: Driver[] = [
  ours,
  ky,
  got,
  axiosRetry,
  fetchRetry,
  fetchRateLimitUtil,
  geoapify,
]

const items = Array.from({ length: ITEM_COUNT }, (_, i) => `/work?i=${i}`)

const pad = (s: string | number, n: number, right = false) => {
  const str = String(s)
  return right ? str.padEnd(n) : str.padStart(n)
}

const printTable = (rows: DriverResult[]) => {
  const header = [
    pad("Driver", 32, true),
    pad("Wall ms", 9),
    pad("OK", 4),
    pad("Fail", 5),
    pad("Hits", 5),
    pad("429", 4),
    pad("ArrivalsDuringRA", 17),
    pad("Mode", 14, true),
  ].join("  ")
  console.log(header)
  console.log("-".repeat(header.length))
  for (const r of rows) {
    console.log(
      [
        pad(r.name, 32, true),
        pad(r.wallMs.toFixed(0), 9),
        pad(r.ok, 4),
        pad(r.failed, 5),
        pad(r.hits, 5),
        pad(r.rateLimited, 4),
        pad(r.arrivalsDuringRetryAfter, 17),
        pad(r.mode, 14, true),
      ].join("  "),
    )
  }
}

const main = async () => {
  const { port, close } = await startServer()
  console.log(
    `HTTP comparison: ${ITEM_COUNT} requests to /work, server hard-cap 12 / soft-cap 6, ` +
      `429 + Retry-After: 1 above the hard cap.\n` +
      `Fixed drivers are swept at concurrency ${CONCURRENCY_SWEEP.join(", ")} ` +
      `(below / near / above the server hard cap); adaptive-promise-pool self-tunes; the rate-limited driver runs once.\n` +
      `ArrivalsDuringRA = requests that ARRIVED during a 1s Retry-After window (lower = more polite).\n`,
  )
  const rows: DriverResult[] = []
  for (const driver of drivers) {
    if (driver.mode === "fixed") {
      for (const concurrency of CONCURRENCY_SWEEP) {
        const result = await runDriver(driver, port, items, concurrency)
        rows.push({ ...result, name: `${result.name} c=${concurrency}` })
        process.stdout.write(".")
      }
      continue
    }
    const result = await runDriver(driver, port, items, SINGLE_RUN_CONCURRENCY)
    rows.push(result)
    process.stdout.write(".")
  }
  process.stdout.write("\n\n")
  printTable(rows)
  await close()
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err)
    process.exit(1)
  },
)
