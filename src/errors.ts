/** Options for constructing a {@link RateLimitError}. */
export type RateLimitErrorOptions = {
  /** Value of the server's Retry-After header (seconds, HTTP date, or null). */
  retryAfter?: string | number | null
  /** Override the default error message. */
  message?: string
  /** Underlying error to attach as `cause`. */
  cause?: unknown
}

/**
 * Throw from a processor to signal a rate limit (HTTP 429). The pool backs
 * off and honors `retryAfter` if provided.
 */
export class RateLimitError extends Error {
  override readonly name = "RateLimitError"
  /** Parsed Retry-After hint, or null if none was supplied. */
  readonly retryAfter: string | number | null

  constructor(options: RateLimitErrorOptions = {}) {
    super(options.message ?? "Rate limited (HTTP 429)", { cause: options.cause })
    this.retryAfter = options.retryAfter ?? null
  }
}

/**
 * Throw from a processor to stop the entire pool immediately. The optional
 * `result` is surfaced to the caller.
 */
export class StopThePoolError<R = unknown> extends Error {
  override readonly name = "StopThePoolError"
  /** Value passed when stopping, if any. */
  readonly result: R | undefined

  constructor(message?: string, result?: R) {
    super(message ?? "Stopped the adaptive pool")
    this.result = result
  }
}

/** Type guard for {@link RateLimitError}. */
export const isRateLimitError = (error: unknown): error is RateLimitError =>
  error instanceof RateLimitError

/** Type guard for {@link StopThePoolError}. */
export const isStopThePoolError = (error: unknown): error is StopThePoolError =>
  error instanceof StopThePoolError
