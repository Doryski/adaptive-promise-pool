# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-26

Initial public release.

### Added

- **Self-tuning concurrency** — a worker pool that adapts how many requests run in
  parallel from observed latency, errors, and 429s, so callers need not pick a magic
  concurrency number. The default `vegas` controller (TCP-Vegas-style queue-depth
  estimation with sample aggregation) settles at the latency *knee* — in the benchmark
  suite it is the fastest of every compared library, beating both the best fixed guess
  and every adaptive rival, with zero configuration.
- **429 / `Retry-After` queue pause** — propagates a `RateLimitError` up to the
  concurrency layer, pausing and narrowing the whole queue on `Retry-After` (parsed as
  both delta-seconds and HTTP date) instead of firing individual retries back into the
  rate-limit wall.
- **Built-in retry** with exponential/linear backoff and jitter, with a separate signal
  contract for rate-limit errors (which do not consume the retry budget). Optional
  `maxRateLimitRetries` caps an otherwise-unbounded 429 retry loop.
- **Cancellation & deadlines** — each processor receives `ctx.signal: AbortSignal`
  (aborts on task timeout, pool stop, or a pool-level signal), and `.withSignal(signal)`
  accepts a pool-wide `AbortSignal` (e.g. `AbortSignal.timeout(ms)`) as a hard deadline.
- **Pluggable `Limit` algorithms** — the decision logic is decoupled from the executor.
  Ships with the default `vegas` controller plus AIMD (`aimd`) and Netflix-Gradient2-style
  (`gradient2`) alternatives, and a `Limit` interface for custom controllers.
- **Fluent builder** (`AdaptivePool.for(...)`) and a functional shortcut (`adaptiveMap`).
  Accepts arrays, sync `Iterable`s, and `AsyncIterable`s.
- **`StopThePoolError`** to stop dispatch early and per-task timeouts via
  `withTaskTimeout(ms)`.
- **Zero runtime dependencies**, dual ESM + CJS build with TypeScript types, Node ≥ 18.

[Unreleased]: https://github.com/doryski/adaptive-promise-pool/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/doryski/adaptive-promise-pool/releases/tag/v0.1.0
