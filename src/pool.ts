import { startLimit } from "./limit/types"
import type { BaseLimitState, Limit, LimitStep } from "./limit/types"
import { vegas } from "./limit/vegas"
import type { VegasConfig, VegasState } from "./limit/vegas"
import { execute } from "./limiter/executor"
import type { ExecutorOptions, ResolvedAdapt } from "./limiter/executor"
import { resolveRetryConfig } from "./limiter/retry"
import type {
  AdaptiveResult,
  AdaptOnConfig,
  ConcurrencyChangeHandler,
  ConcurrencyConfig,
  OnFinishHandler,
  Processor,
  RetryConfig,
  Source,
  TraceHandler,
} from "./types"

const defaultLimit = (
  concurrency: ConcurrencyConfig | undefined,
  latency: AdaptOnConfig["latency"],
): Limit<VegasState> => {
  const config: Partial<VegasConfig> = {}
  if (concurrency?.initial !== undefined) config.initial = concurrency.initial
  if (concurrency?.min !== undefined) config.min = concurrency.min
  if (concurrency?.max !== undefined) config.max = concurrency.max
  if (typeof latency === "object" && latency.window !== undefined) {
    config.probeWindow = latency.window
  }
  return vegas(config)
}

const resolveAdapt = (config: AdaptOnConfig | undefined): ResolvedAdapt => ({
  latency: config?.latency !== false,
  errors: config?.errors ?? true,
  rateLimit: config?.rateLimit ?? true,
})

/**
 * Fluent builder for running an adaptive, self-tuning promise pool over a
 * source. Start with {@link AdaptivePool.for}, chain configuration, then call
 * {@link AdaptivePool.process}.
 */
export class AdaptivePool<T> {
  #source: Source<T>
  #concurrency: ConcurrencyConfig | undefined
  #adapt: AdaptOnConfig | undefined
  #retry: RetryConfig | undefined
  #taskTimeout: number | undefined
  #onConcurrencyChange: ConcurrencyChangeHandler | undefined
  #onTrace: TraceHandler | undefined
  #onFinish: OnFinishHandler<T, unknown> | undefined
  #startAlgorithm: (() => LimitStep) | undefined
  #signal: AbortSignal | undefined

  private constructor(source: Source<T>) {
    this.#source = source
  }

  /** Create a pool builder for the given source. */
  static for<T>(source: Source<T>): AdaptivePool<T> {
    return new AdaptivePool(source)
  }

  /** Set concurrency bounds (initial/min/max). */
  withConcurrency(concurrency: ConcurrencyConfig): this {
    this.#concurrency = concurrency
    return this
  }

  /** Choose which signals drive adaptation (latency/errors/rate-limit). */
  adaptOn(config: AdaptOnConfig): this {
    this.#adapt = config
    return this
  }

  /** Enable retries for failed tasks with backoff. */
  withRetry(config: RetryConfig = {}): this {
    this.#retry = config
    return this
  }

  /** Abort and fail any task that exceeds `ms` milliseconds. */
  withTaskTimeout(ms: number): this {
    this.#taskTimeout = ms
    return this
  }

  /** Cancel the run when the given signal aborts. */
  withSignal(signal: AbortSignal): this {
    this.#signal = signal
    return this
  }

  /** Register a callback fired on every concurrency change. */
  onConcurrencyChange(handler: ConcurrencyChangeHandler): this {
    this.#onConcurrencyChange = handler
    return this
  }

  /** Subscribe to the trace event stream (task/decision/retry/pause events). */
  withTrace(handler: TraceHandler): this {
    this.#onTrace = handler
    return this
  }

  /** Register a callback fired once when the run finishes, with its full result. */
  onFinish(handler: OnFinishHandler<T, unknown>): this {
    this.#onFinish = handler
    return this
  }

  /** Override the adaptive algorithm. Defaults to {@link vegas} when unset. */
  withAlgorithm<S extends BaseLimitState>(limit: Limit<S>): this {
    this.#startAlgorithm = () => startLimit(limit)
    return this
  }

  /** Run `processor` over every source item and resolve with the {@link AdaptiveResult}. */
  process<R>(processor: Processor<T, R>): Promise<AdaptiveResult<T, R>> {
    const adapt = resolveAdapt(this.#adapt)
    const limit = this.#startAlgorithm
      ? this.#startAlgorithm()
      : startLimit(defaultLimit(this.#concurrency, this.#adapt?.latency))
    const retry = resolveRetryConfig(this.#retry ?? { retries: 0 })

    const options: ExecutorOptions<T, R> = {
      source: this.#source,
      processor,
      limit,
      adapt,
      retry,
      ...(this.#taskTimeout !== undefined ? { taskTimeout: this.#taskTimeout } : {}),
      ...(this.#onConcurrencyChange
        ? { onConcurrencyChange: this.#onConcurrencyChange }
        : {}),
      ...(this.#onTrace ? { onTrace: this.#onTrace } : {}),
      ...(this.#onFinish ? { onFinish: this.#onFinish } : {}),
      ...(this.#signal ? { signal: this.#signal } : {}),
    }
    return execute(options)
  }
}

/** Options for {@link adaptiveMap}; mirrors the {@link AdaptivePool} builder. */
export type AdaptiveMapOptions<
  S extends BaseLimitState = BaseLimitState,
  T = unknown,
> = {
  /** Concurrency bounds. @see ConcurrencyConfig */
  concurrency?: ConcurrencyConfig
  /** Adaptation signals. @see AdaptOnConfig */
  adaptOn?: AdaptOnConfig
  /** Retry behavior. @see RetryConfig */
  retry?: RetryConfig
  /** Per-task timeout in ms. */
  taskTimeout?: number
  /** Callback fired on every concurrency change. */
  onConcurrencyChange?: ConcurrencyChangeHandler
  /** Subscribe to the trace event stream (task/decision/retry/pause events). */
  onTrace?: TraceHandler
  /** Callback fired once when the run finishes, with its full result. */
  onFinish?: OnFinishHandler<T, unknown>
  /** Override the adaptive algorithm. Defaults to {@link vegas} when unset. */
  algorithm?: Limit<S>
  /** Cancel the run when this signal aborts. */
  signal?: AbortSignal
}

/**
 * One-shot functional API: run `processor` over `source` with optional
 * adaptive options. Convenience wrapper around {@link AdaptivePool}.
 */
export const adaptiveMap = <T, R, S extends BaseLimitState = BaseLimitState>(
  source: Source<T>,
  processor: Processor<T, R>,
  options: AdaptiveMapOptions<S, T> = {},
): Promise<AdaptiveResult<T, R>> => {
  let pool = AdaptivePool.for(source)
  if (options.concurrency) pool = pool.withConcurrency(options.concurrency)
  if (options.adaptOn) pool = pool.adaptOn(options.adaptOn)
  if (options.retry) pool = pool.withRetry(options.retry)
  if (options.taskTimeout !== undefined) pool = pool.withTaskTimeout(options.taskTimeout)
  if (options.onConcurrencyChange) {
    pool = pool.onConcurrencyChange(options.onConcurrencyChange)
  }
  if (options.onTrace) pool = pool.withTrace(options.onTrace)
  if (options.onFinish) pool = pool.onFinish(options.onFinish)
  if (options.algorithm) pool = pool.withAlgorithm(options.algorithm)
  if (options.signal) pool = pool.withSignal(options.signal)
  return pool.process(processor)
}
