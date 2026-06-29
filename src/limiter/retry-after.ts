const isDeltaSeconds = (value: string): boolean => /^\d+$/.test(value);

const fromNumber = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value * 1000);
};

const fromString = (value: string, now: number): number => {
  const trimmed = value.trim();
  if (trimmed === "") return 0;

  if (isDeltaSeconds(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return 0;

  return Math.max(0, parsed - now);
};

/**
 * Parse a `Retry-After` value into a delay in ms (never negative).
 * Accepts delta-seconds (number or all-digit string) or an HTTP-date string;
 * unparseable, empty, or past-date values yield 0.
 */
export const parseRetryAfter = (
  value: string | number | null | undefined,
  now: number,
): number => {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return fromNumber(value);
  return fromString(value, now);
};
