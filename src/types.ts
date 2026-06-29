import type { ChangeReason } from "./limit/types"

/** A value that may be synchronous or a promise. */
export type Awaitable<T> = T | Promise<T>

/** Input collection: a plain array, a sync iterable, or an async iterable. */
export type Source<T> = readonly T[] | Iterable<T> | AsyncIterable<T>

/** Per-call context passed to the processor on every attempt. */
export type ProcessContext = {
  /** 1-based attempt number (1 on first try, increments on each retry). */
  attempt: number
  /** Position of the item within the source. */
  index: number
  /** Current pool concurrency at the time of this attempt. */
  concurrency: number
  /** Aborts when the pool is stopped or the user-provided signal fires. */
  signal: AbortSignal
}

/** Processes a single item; receives the item and per-call context. */
export type Processor<T, R> = (item: T, ctx: ProcessContext) => Awaitable<R>

/** Concurrency bounds for the adaptive algorithm. */
export type ConcurrencyConfig = {
  /** Starting concurrency. @default 5 */
  initial?: number
  /** Lower bound the algorithm will never go below. @default 1 */
  min?: number
  /**
   * Hard upper bound. The adaptive algorithm self-limits, so this is
   * unbounded by default; pass a finite value for a safety ceiling.
   * @default Infinity
   */
  max?: number
}

/** Tuning for latency-based adaptation. */
export type LatencyAdaptConfig = {
  /** Number of recent samples used to detect latency changes. */
  window?: number
}

/** Signals the pool adapts concurrency on. */
export type AdaptOnConfig = {
  /** React to latency increases (congestion). Pass an object to tune. @default true */
  latency?: boolean | LatencyAdaptConfig
  /** Treat task errors as a signal to back off. @default true */
  errors?: boolean
  /** Treat rate-limit (HTTP 429) errors as a signal to back off. @default true */
  rateLimit?: boolean
}

/** Supported retry backoff strategies. */
export const BACKOFF_STRATEGIES = ["exponential", "linear", "constant"] as const
/** One of {@link BACKOFF_STRATEGIES}. */
export type BackoffStrategy = (typeof BACKOFF_STRATEGIES)[number]

/** Retry behavior for failed tasks. */
export type RetryConfig = {
  /** Max retries after the first attempt. @default 3 */
  retries?: number
  /** Backoff curve between retries. @default "exponential" */
  backoff?: BackoffStrategy
  /** Randomize delays to avoid thundering herds. @default true */
  jitter?: boolean
  /** Base delay in ms for the first retry. @default 100 */
  minDelay?: number
  /** Upper bound in ms for any single backoff delay. @default 30000 */
  maxDelay?: number
  /** Max retries specifically for rate-limit errors. Honors server Retry-After indefinitely by default. @default Infinity */
  maxRateLimitRetries?: number
  /** Caps in ms how long a single server Retry-After may pause the pool; Infinity honors it fully. @default Infinity */
  maxRetryAfter?: number
}

/** Emitted whenever the pool changes its concurrency. */
export type ConcurrencyChange = {
  /** Concurrency before the change. */
  from: number
  /** Concurrency after the change. */
  to: number
  /** Why the change happened. */
  reason: ChangeReason
}

/** Callback invoked on each concurrency change. */
export type ConcurrencyChangeHandler = (change: ConcurrencyChange) => void

/** Fields shared by every {@link TraceEvent}. */
export type TraceEventBase = {
  /** `Date.now()` timestamp when the event was emitted. */
  ts: number
}

/** A task attempt began execution. */
export type TaskStartEvent = TraceEventBase & {
  kind: "taskStart"
  /** Position of the item within the source. */
  index: number
  /** 1-based attempt number (increments on each retry). */
  attempt: number
  /** Pool concurrency at the moment the attempt was dispatched. */
  concurrency: number
}

/** A task attempt settled (resolved or rejected). */
export type TaskEndEvent = TraceEventBase & {
  kind: "taskEnd"
  /** Position of the item within the source. */
  index: number
  /** 1-based attempt number that just settled. */
  attempt: number
  /** Whether the attempt succeeded. */
  ok: boolean
  /** Wall-clock duration of the attempt in ms. */
  durationMs: number
  /** Pool concurrency at the moment the attempt was dispatched. */
  concurrency: number
  /** The error, when `ok` is false. */
  error?: Error
}

/** The pool changed its concurrency (mirrors {@link ConcurrencyChange}). */
export type ConcurrencyChangeEvent = TraceEventBase &
  ConcurrencyChange & {
    kind: "concurrencyChange"
  }

/** The adaptive algorithm produced a decision for a sample. */
export type DecisionEvent = TraceEventBase & {
  kind: "decision"
  /** Why the algorithm reacted. */
  reason: ChangeReason
  /** Whether the decision actually moved concurrency. */
  changed: boolean
  /** Whether the decision was a congestion signal. */
  congestion: boolean
  /** Concurrency after the decision. */
  concurrency: number
  /** Algorithm-specific internals (e.g. Vegas `queue`/`baseRtt`/`probeRtt`). */
  metrics?: Readonly<Record<string, number>>
}

/** A failed attempt was scheduled for retry. */
export type RetryEvent = TraceEventBase & {
  kind: "retry"
  /** Position of the item within the source. */
  index: number
  /** 1-based attempt number that just failed. */
  attempt: number
  /** What triggered the retry. */
  cause: "error" | "rateLimit"
  /** Delay in ms before the retry becomes eligible. */
  delayMs: number
  /** `Date.now()`-based timestamp when the retry becomes eligible. */
  readyAt: number
}

/** The pool paused dispatch in response to a rate-limit Retry-After. */
export type RatePauseEvent = TraceEventBase & {
  kind: "ratePause"
  /** `Date.now()`-based timestamp the pool stays paused until. */
  until: number
  /** How long the pause lasts in ms. */
  retryAfterMs: number
}

/** Discriminated union of every event emitted to a {@link TraceHandler}. */
export type TraceEvent =
  | TaskStartEvent
  | TaskEndEvent
  | ConcurrencyChangeEvent
  | DecisionEvent
  | RetryEvent
  | RatePauseEvent

/** Callback invoked for every trace event during a run. */
export type TraceHandler = (event: TraceEvent) => void

/** Callback invoked once when a run finishes, with its full result. */
export type OnFinishHandler<T, R> = (result: AdaptiveResult<T, R>) => void

/** A task that failed after exhausting retries. */
export type AdaptiveError<T> = {
  /** The source item that failed. */
  item: T
  /** The final error thrown. */
  error: Error
  /** Total attempts made before giving up. */
  attempts: number
}

/** Aggregate metrics for a completed run. */
export type AdaptiveStats = {
  /** Concurrency when the run ended. */
  finalConcurrency: number
  /** Highest concurrency reached during the run. */
  maxConcurrencyReached: number
  /** Count of latency-driven backoff events. */
  congestionEvents: number
  /** Count of rate-limit (429) events. */
  rateLimitEvents: number
  /** Total retry attempts across all tasks. */
  totalRetries: number
  /** Timeline of concurrency vs. observed task duration. */
  performanceData: { concurrency: number; duration: number }[]
}

/** Outcome of a run: successful results, failures, and stats. */
export type AdaptiveResult<T, R> = {
  /** Results of successful tasks, in completion order. */
  results: R[]
  /** Tasks that failed after exhausting retries. */
  errors: AdaptiveError<T>[]
  /** Aggregate run metrics. */
  stats: AdaptiveStats
}
