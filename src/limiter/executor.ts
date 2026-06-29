import type { LimitStep, Sample } from "../limit/types"
import { isRateLimitError, isStopThePoolError } from "../errors"
import type {
  AdaptiveError,
  AdaptiveResult,
  ConcurrencyChangeHandler,
  OnFinishHandler,
  ProcessContext,
  Processor,
  Source,
  TraceHandler,
} from "../types"
import { computeBackoff } from "./retry"
import type { ResolvedRetryConfig } from "./retry"
import { parseRetryAfter } from "./retry-after"

export type ResolvedAdapt = {
  latency: boolean
  errors: boolean
  rateLimit: boolean
}

export type ExecutorOptions<T, R> = {
  source: Source<T>
  processor: Processor<T, R>
  limit: LimitStep
  adapt: ResolvedAdapt
  retry: ResolvedRetryConfig
  taskTimeout?: number
  onConcurrencyChange?: ConcurrencyChangeHandler
  onTrace?: TraceHandler
  onFinish?: OnFinishHandler<T, R>
  rng?: () => number
  signal?: AbortSignal
}

type Task<T> = {
  item: T
  index: number
  tries: number
  budgetUsed: number
  rateLimitUsed: number
  readyAt: number
  dispatchConcurrency: number
}

const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value))

const hasAsyncIterator = <T>(source: Source<T>): source is AsyncIterable<T> =>
  typeof source === "object" &&
  source !== null &&
  Symbol.asyncIterator in source

const toIterator = <T>(
  source: Source<T>,
): { next: () => Promise<IteratorResult<T>> } => {
  if (hasAsyncIterator(source)) {
    const it = source[Symbol.asyncIterator]()
    return { next: () => it.next() }
  }
  const it = source[Symbol.iterator]()
  return { next: () => Promise.resolve(it.next()) }
}

const withTimeout = <V>(
  promise: PromiseLike<V>,
  ms: number,
  onTimeout: () => void,
): Promise<V> =>
  new Promise<V>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new Error(`Task timed out after ${ms}ms`))
    }, ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(toError(error))
      },
    )
  })

export const execute = async <T, R>(
  options: ExecutorOptions<T, R>,
): Promise<AdaptiveResult<T, R>> => {
  const { source, processor, adapt, retry, onConcurrencyChange, onTrace, onFinish } = options
  const rng = options.rng ?? Math.random
  const iterator = toIterator(source)

  let limitStep = options.limit
  let active = 0
  let sourceDone = false
  let stopped = false
  let pausedUntil = 0
  let sourceIndex = 0

  const pending: Task<T>[] = []
  const controllers = new Set<AbortController>()
  let buffered: { value: T; index: number } | null = null
  const results: R[] = []
  const errors: AdaptiveError<T>[] = []
  const performanceData: { concurrency: number; duration: number }[] = []

  let iteratorError: Error | null = null
  let maxConcurrencyReached = limitStep.concurrency
  let congestionEvents = 0
  let rateLimitEvents = 0
  let totalRetries = 0

  let wakeResolve: (() => void) | null = null
  let pendingWake = false
  const wake = () => {
    const resolve = wakeResolve
    if (resolve) {
      wakeResolve = null
      pendingWake = false
      resolve()
      return
    }
    pendingWake = true
  }

  const abortAllControllers = () => {
    for (const controller of controllers) {
      if (!controller.signal.aborted) controller.abort()
    }
  }

  const stopPool = () => {
    stopped = true
    abortAllControllers()
  }

  const onAbort = () => {
    stopPool()
    wake()
  }
  if (options.signal) {
    if (options.signal.aborted) stopped = true
    else options.signal.addEventListener("abort", onAbort, { once: true })
  }

  const applySample = (sample: Sample) => {
    const from = limitStep.concurrency
    const { next, decision } = limitStep.step(sample)
    limitStep = next
    if (decision.reason === "rateLimit") rateLimitEvents += 1
    else if (decision.congestion) congestionEvents += 1
    if (onTrace) {
      onTrace({
        kind: "decision",
        ts: Date.now(),
        reason: decision.reason,
        changed: decision.changed,
        congestion: decision.congestion,
        concurrency: decision.concurrency,
        ...(decision.metrics ? { metrics: decision.metrics } : {}),
      })
    }
    if (decision.changed) {
      maxConcurrencyReached = Math.max(maxConcurrencyReached, decision.concurrency)
      onConcurrencyChange?.({ from, to: decision.concurrency, reason: decision.reason })
      if (onTrace) {
        onTrace({
          kind: "concurrencyChange",
          ts: Date.now(),
          from,
          to: decision.concurrency,
          reason: decision.reason,
        })
      }
    }
  }

  const scheduleRetry = (
    task: Task<T>,
    readyAt: number,
    cause: "error" | "rateLimit",
  ) => {
    totalRetries += 1
    if (onTrace) {
      const now = Date.now()
      onTrace({
        kind: "retry",
        ts: now,
        index: task.index,
        attempt: task.tries,
        cause,
        delayMs: Math.max(0, readyAt - now),
        readyAt,
      })
    }
    pending.push({ ...task, tries: task.tries + 1, readyAt })
    pending.sort((a, b) => a.readyAt - b.readyAt)
  }

  const emitTaskEnd = (task: Task<T>, ok: boolean, duration: number, error?: Error) => {
    if (!onTrace) return
    onTrace({
      kind: "taskEnd",
      ts: Date.now(),
      index: task.index,
      attempt: task.tries,
      ok,
      durationMs: duration,
      concurrency: task.dispatchConcurrency,
      ...(error ? { error } : {}),
    })
  }

  const settleSuccess = (task: Task<T>, value: R, duration: number) => {
    results.push(value)
    performanceData.push({ concurrency: task.dispatchConcurrency, duration })
    emitTaskEnd(task, true, duration)
    if (adapt.latency) applySample({ kind: "success", duration })
  }

  const settleFailure = (task: Task<T>, error: Error, duration: number) => {
    performanceData.push({ concurrency: task.dispatchConcurrency, duration })
    emitTaskEnd(task, false, duration, error)

    if (isStopThePoolError(error)) {
      stopPool()
      return
    }

    if (isRateLimitError(error) && adapt.rateLimit) {
      applySample({ kind: "rateLimit" })
      const rateLimitUsed = task.rateLimitUsed + 1
      if (rateLimitUsed > retry.maxRateLimitRetries) {
        errors.push({ item: task.item, error, attempts: task.tries })
        return
      }
      const delay = Math.min(parseRetryAfter(error.retryAfter, Date.now()), retry.maxRetryAfter)
      pausedUntil = Math.max(pausedUntil, Date.now() + delay)
      if (onTrace) {
        onTrace({ kind: "ratePause", ts: Date.now(), until: pausedUntil, retryAfterMs: delay })
      }
      scheduleRetry({ ...task, rateLimitUsed }, pausedUntil, "rateLimit")
      return
    }

    if (adapt.errors) applySample({ kind: "error" })
    const budgetUsed = task.budgetUsed + 1
    if (budgetUsed <= retry.retries) {
      const delay = computeBackoff(budgetUsed, retry, rng)
      scheduleRetry({ ...task, budgetUsed }, Date.now() + delay, "error")
      return
    }
    errors.push({ item: task.item, error, attempts: task.tries })
  }

  const runTask = async (task: Task<T>) => {
    const controller = new AbortController()
    controllers.add(controller)
    if (stopped && !controller.signal.aborted) controller.abort()
    const abortController = () => {
      if (!controller.signal.aborted) controller.abort()
    }
    const ctx: ProcessContext = {
      attempt: task.tries,
      index: task.index,
      concurrency: task.dispatchConcurrency,
      signal: controller.signal,
    }
    const start = Date.now()
    if (onTrace) {
      onTrace({
        kind: "taskStart",
        ts: start,
        index: task.index,
        attempt: task.tries,
        concurrency: task.dispatchConcurrency,
      })
    }
    try {
      const promise = Promise.resolve(processor(task.item, ctx))
      const value =
        options.taskTimeout === undefined
          ? await promise
          : await withTimeout(promise, options.taskTimeout, abortController)
      settleSuccess(task, value, Date.now() - start)
    } catch (error) {
      settleFailure(task, toError(error), Date.now() - start)
    } finally {
      controllers.delete(controller)
      active -= 1
      wake()
    }
  }

  const takeReadyRetry = (): Task<T> | null => {
    const first = pending[0]
    if (first && first.readyAt <= Date.now()) return pending.shift() ?? null
    return null
  }

  const isFinished = () =>
    (stopped && active === 0) ||
    (sourceDone && pending.length === 0 && active === 0)

  const nextWakeDelay = (): number | undefined => {
    const times: number[] = []
    if (pausedUntil > Date.now()) times.push(pausedUntil)
    const nextRetry = pending[0]
    if (nextRetry) times.push(nextRetry.readyAt)
    if (times.length === 0) return undefined
    return Math.max(0, Math.min(...times) - Date.now())
  }

  const dispatch = async () => {
    while (!stopped && Date.now() >= pausedUntil && active < limitStep.concurrency) {
      const retryTask = takeReadyRetry()
      if (retryTask) {
        active += 1
        void runTask({ ...retryTask, dispatchConcurrency: limitStep.concurrency })
        continue
      }
      if (buffered) {
        const { value, index } = buffered
        buffered = null
        active += 1
        void runTask({
          item: value,
          index,
          tries: 1,
          budgetUsed: 0,
          rateLimitUsed: 0,
          readyAt: 0,
          dispatchConcurrency: limitStep.concurrency,
        })
        continue
      }
      if (sourceDone) break
      try {
        const next = await iterator.next()
        if (next.done) {
          sourceDone = true
          break
        }
        buffered = { value: next.value, index: sourceIndex++ }
      } catch (error) {
        iteratorError = toError(error)
        sourceDone = true
        break
      }
    }
  }

  const waitForWake = (delay: number | undefined) =>
    new Promise<void>((resolve) => {
      if (pendingWake) {
        pendingWake = false
        resolve()
        return
      }
      wakeResolve = resolve
      if (delay === undefined) return
      setTimeout(() => {
        if (wakeResolve === resolve) {
          wakeResolve = null
          resolve()
        }
      }, delay)
    })

  while (!isFinished()) {
    await dispatch()
    if (isFinished()) break
    await waitForWake(nextWakeDelay())
  }

  options.signal?.removeEventListener("abort", onAbort)

  if (iteratorError) throw iteratorError

  const result: AdaptiveResult<T, R> = {
    results,
    errors,
    stats: {
      finalConcurrency: limitStep.concurrency,
      maxConcurrencyReached,
      congestionEvents,
      rateLimitEvents,
      totalRetries,
      performanceData,
    },
  }
  onFinish?.(result)
  return result
}
