# adaptive-promise-pool

[![CI](https://github.com/doryski/adaptive-promise-pool/actions/workflows/ci.yml/badge.svg)](https://github.com/doryski/adaptive-promise-pool/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/adaptive-promise-pool)](https://www.npmjs.com/package/adaptive-promise-pool)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Map-like concurrent promise processing with **self-tuning concurrency** (AIMD),
> **429 / Retry-After awareness**, and built-in **retry**.

Process an array or (async) iterable with a worker pool whose concurrency tunes itself at
runtime from **latency and errors/429** — ramping up while the target is healthy and backing
off when it isn't. Zero runtime dependencies, dual ESM + CJS build, Node ≥ 18.

## Why

You don't hand-pick a magic `withConcurrency(n)`: the limit adapts itself, climbing while the
target is healthy and shrinking on rising latency, errors, or 429s. Its distinguishing feature
is propagating a 429 up to the concurrency layer — **pausing and narrowing the whole queue on
`Retry-After`** instead of retrying individual requests straight back into the rate-limit wall.

## Installation

```bash
pnpm add adaptive-promise-pool
# or
npm install adaptive-promise-pool
```

Requires Node ≥ 18. Ships dual ESM + CJS builds with TypeScript types and has zero runtime dependencies.

## Usage

```ts
import { AdaptivePool, RateLimitError } from "adaptive-promise-pool"

const { results, errors, stats } = await AdaptivePool
  .for(items)
  .withConcurrency({ initial: 5, min: 1, max: 50 })
  .adaptOn({ latency: true, errors: true, rateLimit: true })
  .withRetry({ retries: 3, backoff: "exponential", jitter: true })
  .process(async (item) => {
    const res = await fetch(item.url)
    if (res.status === 429)
      throw new RateLimitError({ retryAfter: res.headers.get("retry-after") })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  })
```

The input may be an array, a sync `Iterable`, or an `AsyncIterable`. Results are returned in
completion order; failures (after the retry budget is exhausted) are collected in `errors`.

### Functional shortcut

For simple cases, `adaptiveMap` wraps the builder:

```ts
import { adaptiveMap } from "adaptive-promise-pool"

const { results, errors } = await adaptiveMap(items, processor, {
  concurrency: { initial: 5, min: 1, max: 50 },
})
```

### Result shape

```ts
type AdaptiveResult<T, R> = {
  results: R[]                                  // successes, in completion order
  errors: { item: T; error: Error; attempts: number }[]
  stats: {
    finalConcurrency: number
    maxConcurrencyReached: number
    congestionEvents: number                   // multiplicative decreases from latency / errors
    rateLimitEvents: number                    // multiplicative decreases from 429s
    totalRetries: number
    performanceData: { concurrency: number; duration: number }[]
  }
}
```

### Signal contract

The processor communicates outcomes by returning a value or throwing:

| Outcome | Adaptation signal | Retry? | Effect on the queue |
|---|---|---|---|
| **return** (success) | additive increase when stable | no | — |
| **throw `RateLimitError`** | multiplicative decrease | yes — does **not** consume the retry budget | dispatch **paused** until `Retry-After` |
| **throw any other `Error`** | multiplicative decrease | yes — consumes the retry budget (backoff + jitter) | — |
| **timeout** (`withTaskTimeout(ms)`) | multiplicative decrease | yes — consumes the retry budget | — |

`Retry-After` is parsed as both delta-seconds and an HTTP date. Because a `RateLimitError`
never consumes the retry budget, a permanently rate-limited endpoint would retry forever by
default — cap it with `withRetry({ maxRateLimitRetries: n })` (after `n` rate-limit retries the
item lands in `errors`). Throw `StopThePoolError` from a processor to stop dispatch early.

### Cancellation & deadlines

Every processor receives `ctx.signal: AbortSignal`, which aborts when that task hits its
`withTaskTimeout(ms)`, when the pool is stopped, or when a pool-level signal fires — forward it
to cancel in-flight work:

```ts
.process(async (item, ctx) => {
  const res = await fetch(item.url, { signal: ctx.signal })
  return res.json()
})
```

Pass a pool-level `AbortSignal` (e.g. `AbortSignal.timeout(30_000)`) via `.withSignal(signal)`
or the `signal` option for a hard deadline across the whole run — in-flight tasks are aborted
and dispatch stops.

### Observability & tracing

The pool emits a live event stream so you can see exactly what it's doing — and build your own
visualization or logging on top. Subscribe with `.withTrace(handler)` (builder) or the `onTrace`
option (`adaptiveMap`). The library only emits; rendering is entirely up to you.

```ts
import { adaptiveMap } from "adaptive-promise-pool"
import type { TraceEvent } from "adaptive-promise-pool"

const trace: TraceEvent[] = []

const result = await adaptiveMap(urls, fetchJson, {
  onTrace: (e) => trace.push(e), // or stream/log/draw it
  onFinish: (r) => console.log("done:", r.stats),
})
```

Every event carries a `ts` (`Date.now()`) timestamp. `onTrace` receives a discriminated union
keyed on `kind`:

| `kind` | Payload | Fired when |
|---|---|---|
| `taskStart` | `index`, `attempt`, `concurrency` | an attempt begins |
| `taskEnd` | `index`, `attempt`, `ok`, `durationMs`, `concurrency`, `error?` | an attempt settles |
| `concurrencyChange` | `from`, `to`, `reason` | the limit moves (mirrors `onConcurrencyChange`) |
| `decision` | `reason`, `changed`, `congestion`, `concurrency`, `metrics?` | the algorithm processes a sample |
| `retry` | `index`, `attempt`, `cause` (`"error"` \| `"rateLimit"`), `delayMs`, `readyAt` | a failed attempt is rescheduled |
| `ratePause` | `until`, `retryAfterMs` | dispatch pauses for a `Retry-After` |

`decision.metrics` exposes the algorithm's internals so you can see **why** concurrency adapts —
for Vegas that's `{ queue, baseRtt, probeRtt }`. The field is optional and algorithm-specific.

`onFinish(result)` fires once at the end with the full `AdaptiveResult` (results, errors, stats)
— handy for fire-and-forget logging or teardown without awaiting the returned promise.

## Pluggable algorithms

The decision logic (`Limit`) is decoupled from the executor, so the tuning algorithm is
swappable. The default is **`vegas`** — a TCP-Vegas-style controller that estimates the queue
depth from the gap between the current RTT and the no-load baseline RTT (`queue = limit ·
(1 − baseRtt/rtt)`) and nudges concurrency up or down by one to hold the queue between `alpha`
and `beta`, aggregating over a small sample window to reject noise. It seeks the *knee* of the
latency curve rather than climbing to the congestion wall, which keeps it close to the
throughput-optimal operating point without any tuning. Two alternatives ship built in:

- **`aimd`** — additive-increase / multiplicative-decrease driven by a recent-vs-baseline
  latency ratio. Faster to back off on a sharp latency jump, but oscillates more.
- **`gradient2`** — a Netflix-Gradient2-style controller comparing a short-term RTT to a
  long-term EMA, scaling the limit by the gradient plus a `sqrt(limit)` headroom term.

```ts
import { AdaptivePool, aimd, gradient2 } from "adaptive-promise-pool"

await AdaptivePool.for(items)
  .withAlgorithm(aimd({ initial: 8, min: 1, max: 50 }))
  .process(processor)

// or via the shortcut
await adaptiveMap(items, processor, { algorithm: gradient2({ initial: 8, min: 1, max: 50 }) })
```

Each algorithm is a self-contained `Limit` carrying its own bounds and parameters, so
`withAlgorithm` (and the `algorithm` option) take precedence over `withConcurrency`. Implement
the `Limit` interface to plug in your own controller — it is a pure `(state, sample)` fold, so
it is fully unit-testable without any I/O.

## Configuration reference

Every option is optional — the defaults below are tuned to work out of the box. Numbers are
verified against the source constants.

### Concurrency (`withConcurrency` / `concurrency`)

| Option | Default | Meaning |
|---|---|---|
| `initial` | `5` | Starting concurrency when the pool is created. |
| `min` | `1` | Hard floor; concurrency never drops below this. |
| `max` | `Infinity` | Hard ceiling on concurrency. |

`max` defaults to **`Infinity` (unbounded) by design**: the adaptive algorithm self-limits from
latency and errors/429s, so it discovers a safe operating point without an upper number. Set a
finite `max` only when you need a hard safety ceiling — e.g. to protect a downstream connection
pool, a file-descriptor budget, or a third-party quota — not to tune throughput.

### Adaptation (`adaptOn` / `adaptOn`)

| Option | Default | Meaning |
|---|---|---|
| `latency` | `true` | React to latency increases (congestion). Pass an object to tune the probe window. |
| `errors` | `true` | Treat task errors as a back-off signal. |
| `rateLimit` | `true` | Treat rate-limit (HTTP 429) errors as a back-off signal. |

### Retry (`withRetry` / `retry`)

| Option | Default | Meaning |
|---|---|---|
| `retries` | `3` | Max retries per task on non-rate-limit errors. |
| `backoff` | `"exponential"` | Delay growth across attempts (`constant`, `linear`, or `exponential`). |
| `jitter` | `true` | Randomize each backoff delay between 0 and its computed value. |
| `minDelay` | `100` | Base/minimum backoff delay in ms. |
| `maxDelay` | `30000` | Upper bound for any single backoff delay in ms. |
| `maxRateLimitRetries` | `Infinity` | Max retries triggered by rate-limit (429) errors. |
| `maxRetryAfter` | `Infinity` | Cap in ms on how long one `Retry-After` header may pause the pool. |

`maxRateLimitRetries` is a **separate budget** from `retries`: with the default `Infinity`, a 429
is retried as long as the server keeps sending `Retry-After`, without consuming the normal retry
budget. Set a finite value to give up on a permanently rate-limited endpoint (the item then lands
in `errors`).

`maxRetryAfter` defaults to `Infinity`, so the pool honors the server's full `Retry-After` pause.
Set a finite value (ms) to cap how long a single `Retry-After` header may pause dispatch — a guard
against a hostile or buggy huge `Retry-After` freezing the whole pool.

### Algorithm selection

When neither `withAlgorithm` nor the `algorithm` option is supplied, the pool uses **`vegas`** as
its default controller. Three algorithms ship built in: **`vegas`** (default), **`aimd`**, and
**`gradient2`** — see [Pluggable algorithms](#pluggable-algorithms) for the trade-offs.

### Algorithm tuning

Each built-in carries its own concurrency bounds (`initial` / `min` / `max`, same defaults as
[Concurrency](#concurrency-withconcurrency--concurrency)) plus the algorithm-specific parameters
below. Override any subset, e.g. `vegas({ beta: 4, max: 50 })`.

**`vegas`** (default)

| Param | Default | Meaning |
|---|---|---|
| `alpha` | `1` | Lower queue threshold — grow concurrency below it. |
| `beta` | `2` | Upper queue threshold — shrink concurrency above it. |
| `decreaseFactor` | `0.5` | Multiplicative shrink applied on congestion. |
| `probeWindow` | `5` | Samples aggregated per up/down decision. |
| `baseRttWindow` | `100` | Recent-RTT samples kept to estimate the baseline. |
| `baseRttQuantile` | `0.3` | Quantile of recent RTTs used as the no-load baseline. |

**`aimd`**

| Param | Default | Meaning |
|---|---|---|
| `increaseStep` | `2` | Additive concurrency growth per stable window. |
| `decreaseFactor` | `0.55` | Multiplicative shrink applied on congestion. |
| `congestionThreshold` | `1.4` | Recent/baseline duration ratio that triggers a shrink. |
| `stabilityWindow` | `4` | Stable samples required before growing. |

**`gradient2`**

| Param | Default | Meaning |
|---|---|---|
| `smoothing` | `0.15` | EMA factor for the smoothed limit estimate. |
| `longWindow` | `600` | Window for the long-term baseline RTT. |
| `rttTolerance` | `1.15` | Acceptable RTT-inflation ratio before backing off. |
| `decreaseFactor` | `0.5` | Multiplicative shrink applied on congestion. |
| `probeWindow` | `3` | Samples aggregated per decision. |
| `queueSize` | `2` | Headroom term added to the estimated limit. |

## Benchmark

`benchmarks/adaptive-vs-static.ts` processes the same 400-item workload against a
**simulated flaky API** (zero network) three ways and reports wall-clock time and
error/retry counts. The simulated server has a base latency of 40ms, a soft
capacity of 8 in-flight requests (above which latency grows super-linearly), and
a hard capacity of 16 (above which it starts shedding load with 429s and the odd
500). A too-high fixed concurrency therefore self-inflicts latency and rate
limits, while the adaptive pool has to discover a good operating point on its
own. Numbers below are averaged over 3 runs per config.

| Config                   | Wall ms | OK  | Err | Retries | 429s | Final concurrency |
| ------------------------ | ------: | --: | --: | ------: | ---: | ----------------: |
| Fixed c=4 (conservative) |  ~4100  | 400 |   0 |       0 |    0 |                 4 |
| Fixed c=20 (aggressive)  | ~19300  | 399 |   1 |    ~269 |    0 |                20 |
| Adaptive (1–50)          |  ~2370  | 400 |   0 |       0 |    0 |               ~9 |

Both fixed guesses are wrong: `c=4` is too conservative (underutilized,
**~1.7× slower** than adaptive), `c=20` overshoots the hard cap into a 429/500
storm (~269 retries, a dropped item, **~8× slower**). The adaptive pool starts at
8 and settles at the latency **knee** (~9), finishing fastest of the three with
zero dropped items and zero retries — **without the caller having to know the
right concurrency in advance**.

Reproduce with:

```bash
pnpm bench
```

## Benchmark — vs. the field

We also benchmarked against **every comparable library** in the ecosystem: the static
pools/primitives
(`@supercharge/promise-pool`, `p-map`, `p-limit`, `p-queue`, `bottleneck`,
`cockatiel`, `p-retry`), the adaptive rivals (`promise-pool-smart`,
`adaptive-concurrency`, `@adaptive-concurrency-toolkit/core`, `aimd-bucket`,
`congestion-control`), and the rate limiters (`p-throttle`, `limiter`). The
in-process flaky API has a soft cap of 8, hard cap of 20, `Retry-After: 1s`, and
is deliberately **noisy** — ±30% per-request latency jitter, 3% slow-tail
outliers (6×), and a 1% load-independent transient-error rate. 300 items, retry
budget 5; wall-time is reported as **median ± sd over 3 seeds × 3 runs** so that
overlapping ranges read as a statistical tie. Fixed-concurrency libraries are
shown at three guesses (the optimum is unknown in advance); adaptive libraries
self-tune. Harness + adapters: [`benchmarks/compare/`](./benchmarks/compare).

| Library | Mode | Conc | Wall ms (median ± sd) | OK | Fail | 429 | Peak | `Retry-After` |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | :---: |
| **adaptive-promise-pool** | adaptive | auto | **1171 ± 136** | 300 | 0 | **0** | 12 | **yes** |
| bottleneck | fixed | c=4 / 12 / 24 | 2527 / **1194 ± 63** / 3361 | 300 | 0 | 0 / 0 / 19 | 4 / 12 / 24 | no |
| @supercharge/promise-pool | fixed | c=4 / 12 / 24 | 2353 / 1342 / 2886 | 300 | 0 | 0 / 0 / 21 | 4 / 12 / 24 | no |
| p-map · p-limit · p-queue · p-retry | fixed | c=4 / 12 / 24 | ≈ promise-pool (±3%) | 300 | 0 | 0 / 0 / ~20 | 4 / 12 / 24 | no |
| cockatiel (bulkhead+retry) | fixed | c=4 / 12 / 24 | 2532 / 1326 / 6002 | 300 | 0 | 0 / 0 / 96 | 4 / 12 / 24 | no |
| @adaptive-concurrency-toolkit/core | adaptive | auto | 1905 ± 342 | 300 | 0 | 0 | 19 | no |
| congestion-control | adaptive | auto | 3042 | 300 | 0 | 5 | 21 | no |
| aimd-bucket (rate) | adaptive | auto | 3569 | 300 | 0 | 0 | 9 | no |
| adaptive-concurrency | adaptive | auto | 6878 | 294 | **6** | 24 | 27 | no |
| promise-pool-smart | adaptive | auto | 8802 | 300 | 0 | 29 | 28 | no |
| p-throttle (rate) | fixed | c=12 | 5031 | 300 | 0 | 0 | 13 | no |
| limiter (rate) | fixed | c=12 | 24439 | 300 | 0 | 0 | 12 | no |

What this shows (honestly, under noise):

- **adaptive-promise-pool has the lowest median wall-time of every entry** (1171 ms, 0 dropped, 0
  triggered 429s, **zero configuration**) — and it holds that position under
  realistic jitter and across seeds, not just on a clean curve.
- **It is the fastest adaptive library by a wide margin** — the next, toolkit
  (1905 ms), only after hand-tuning three of its internals; the loss-based rivals
  overshoot (`promise-pool-smart` 29 × 429, `adaptive-concurrency` 24 × 429 and
  **6 dropped**); the calm ones are 2.6–3× slower.
- **The honest tie:** the single best fixed guess (`bottleneck` at `c=12`, 1194 ±
  63) is a *statistical tie* with adaptive-promise-pool — on a stable API a perfectly-chosen static
  concurrency is essentially as fast. Its value is that it *finds* that point
  with no number to guess: `c=4` is ~2× slower, `c=24` self-inflicts a 429 storm,
  and the *other* libraries' `c=12` (~1340 ms) are ~15% slower than the pool. A fixed
  pool matches it only if you already know the hidden optimum — and still has no
  `Retry-After` protection.
- **Fairness & robustness:** every competitor got the same retry budget, the same
  429 signal, and (where exposed) the same `min:1 / max:50` bounds. The default
  Vegas config is not overfit — it finds the knee across tight/default/loose API
  curves (`tune.ts`) and survives the noise (its min-RTT baseline is a low
  quantile, robust to fast-jitter outliers). **Known weak regime:** on
  *very-low-latency, high-throughput* APIs (base ≤ ~15 ms, optimum ≫ 20) the
  latency signal is swamped by jitter, so *all* latency controllers —
  adaptive-promise-pool included — get conservative and under-utilize (raise `initial`/`max`, or prefer
  a fixed pool there). `atrion` is excluded — `atrion@2.0.0` fails to import
  (broken WASM dependency).

### The differentiator: pausing the queue on `Retry-After`

The headline gap — *nobody propagates a 429 up to the concurrency layer* — shows
up against a **real local HTTP server** that 429s past a hard cap of ~12 (200
requests; [`benchmarks/compare/http/`](./benchmarks/compare/http)). Each
per-request library is swept at three guesses — below / near / above the hidden
cap — and the telling metric is **arrivals during the `Retry-After` window** (how
many requests the client fired at the server *while it had asked everyone to wait*):

| Driver | Conc | Wall ms | 429 | Arrivals during `Retry-After` |
| --- | --- | ---: | ---: | ---: |
| **adaptive-promise-pool** | auto | **938** | **0** | **0** |
| ky / got / axios-retry / fetch-retry / fetch-rate-limit-util | c=6 | 922–1038 | 0 | 0 |
| ″ | c=10 | 1090–1125 | 0 | 0 |
| ″ | c=16 | 2055–2372 | ~8 | **130–192** |
| @geoapify/request-rate-limiter | rate | 13053 | 48 | 148 |

Read honestly: at a **good** guess (`c=6`, below the wall) the per-request
libraries are fast too — a couple even edge the pool by a few ms, well within noise —
and trigger no 429s, so the differentiator is invisible. The point is twofold:
(1) adaptive-promise-pool lands there **with zero config** while the per-request libraries need you to know the server's
hidden cap; and (2) the moment the guess is too high (`c=16`), those libraries self-inflict
~8 × 429 and **fire ~130–190 other requests straight into the wall during the
Retry-After window**, whereas the pool adapts down and **pauses the whole queue** —
behaviour no other library has. So the queue-pause is a *safety net for when you
guess wrong or the cap moves*, not a free speed win at a good guess.

Reproduce: `cd benchmarks/compare && pnpm install && pnpm bench` (pool table) and
`cd benchmarks/compare/http && npx tsx run.ts` (HTTP table).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup,
testing commands, and coding conventions, and please review the
[Code of Conduct](./CODE_OF_CONDUCT.md). Security issues should follow [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © Dominik Rycharski
