export type FlakyConfig = {
  baseLatencyMs: number
  softCap: number
  hardCap: number
  rateLimitProb: number
  serverErrorProb: number
  retryAfterSeconds: number
  seed: number
  capacityAt?: (hit: number) => { softCap: number; hardCap: number }
  jitter: number
  tailProb: number
  tailMultiplier: number
  transientErrorProb: number
}

export const DEFAULT_FLAKY: FlakyConfig = {
  baseLatencyMs: 25,
  softCap: 8,
  hardCap: 20,
  rateLimitProb: 0.4,
  serverErrorProb: 0.05,
  retryAfterSeconds: 1,
  seed: 12345,
  jitter: 0.3,
  tailProb: 0.03,
  tailMultiplier: 6,
  transientErrorProb: 0.01,
}

export type FlakyError = Error & {
  is429?: boolean
  is500?: boolean
  retryAfter?: string
  status?: number
}

export type FlakyMetrics = {
  hits: number
  rateLimited: number
  serverErrors: number
  peakInFlight: number
}

export type FlakyApi = {
  attempt: (item: number) => Promise<number>
  metrics: () => FlakyMetrics
}

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export const createFlakyApi = (config: FlakyConfig = DEFAULT_FLAKY): FlakyApi => {
  const rnd = mulberry32(config.seed)
  let inFlight = 0
  let peakInFlight = 0
  let hits = 0
  let rateLimited = 0
  let serverErrors = 0

  const capsAt = (hit: number): { softCap: number; hardCap: number } =>
    config.capacityAt
      ? config.capacityAt(hit)
      : { softCap: config.softCap, hardCap: config.hardCap }

  const latencyFor = (load: number, softCap: number): number => {
    if (load <= softCap) return config.baseLatencyMs
    const over = (load - softCap) / softCap
    return config.baseLatencyMs * (1 + over * over * 3)
  }

  const latencyWithNoise = (load: number, softCap: number): number => {
    const jittered = latencyFor(load, softCap) * (1 + (rnd() * 2 - 1) * config.jitter)
    const tail = rnd() < config.tailProb ? config.tailMultiplier : 1
    return Math.max(1, jittered * tail)
  }

  const attempt = async (item: number): Promise<number> => {
    inFlight += 1
    if (inFlight > peakInFlight) peakInFlight = inFlight
    hits += 1
    const load = inFlight
    const { softCap, hardCap } = capsAt(hits)
    try {
      await sleep(latencyWithNoise(load, softCap))
      if (rnd() < config.transientErrorProb) {
        serverErrors += 1
        const err: FlakyError = Object.assign(new Error("500 Transient Error"), {
          is500: true,
          status: 500,
        })
        throw err
      }
      if (load > hardCap) {
        const roll = rnd()
        if (roll < config.rateLimitProb) {
          rateLimited += 1
          const err: FlakyError = Object.assign(new Error("429 Too Many Requests"), {
            is429: true,
            status: 429,
            retryAfter: String(config.retryAfterSeconds),
          })
          throw err
        }
        if (roll < config.rateLimitProb + config.serverErrorProb) {
          serverErrors += 1
          const err: FlakyError = Object.assign(new Error("500 Server Error"), {
            is500: true,
            status: 500,
          })
          throw err
        }
      }
      return item * 2
    } finally {
      inFlight -= 1
    }
  }

  return {
    attempt,
    metrics: () => ({ hits, rateLimited, serverErrors, peakInFlight }),
  }
}
