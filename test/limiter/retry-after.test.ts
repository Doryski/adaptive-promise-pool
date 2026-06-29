import { describe, expect, it } from "vitest";

import { parseRetryAfter } from "../../src/limiter/retry-after";

const NOW = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");

describe("parseRetryAfter", () => {
  it("returns 0 for null", () => {
    expect(parseRetryAfter(null, NOW)).toBe(0);
  });

  it("returns 0 for undefined", () => {
    expect(parseRetryAfter(undefined, NOW)).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(parseRetryAfter("", NOW)).toBe(0);
  });

  it("returns 0 for whitespace-only string", () => {
    expect(parseRetryAfter("   ", NOW)).toBe(0);
  });

  it("converts numeric seconds (number) to ms", () => {
    expect(parseRetryAfter(120, NOW)).toBe(120000);
  });

  it("converts numeric seconds (string) to ms", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120000);
  });

  it("converts numeric string with surrounding whitespace", () => {
    expect(parseRetryAfter("  120  ", NOW)).toBe(120000);
  });

  it("returns 0 for zero seconds", () => {
    expect(parseRetryAfter("0", NOW)).toBe(0);
    expect(parseRetryAfter(0, NOW)).toBe(0);
  });

  it("returns 0 for negative number", () => {
    expect(parseRetryAfter(-5, NOW)).toBe(0);
  });

  it("returns 0 for negative numeric string", () => {
    expect(parseRetryAfter("-5", NOW)).toBe(0);
  });

  it("returns 0 for NaN", () => {
    expect(parseRetryAfter(Number.NaN, NOW)).toBe(0);
  });

  it("returns 0 for Infinity", () => {
    expect(parseRetryAfter(Number.POSITIVE_INFINITY, NOW)).toBe(0);
    expect(parseRetryAfter(Number.NEGATIVE_INFINITY, NOW)).toBe(0);
  });

  it("returns positive ms for a future HTTP date", () => {
    const future = "Wed, 21 Oct 2026 07:30:00 GMT";
    expect(parseRetryAfter(future, NOW)).toBe(120000);
  });

  it("returns exact ms delta for a future HTTP date", () => {
    const future = "Wed, 21 Oct 2026 08:28:00 GMT";
    const expected = Date.parse(future) - NOW;
    expect(parseRetryAfter(future, NOW)).toBe(expected);
    expect(expected).toBe(3600000);
  });

  it("returns 0 for a past HTTP date", () => {
    const past = "Wed, 21 Oct 2026 07:00:00 GMT";
    expect(parseRetryAfter(past, NOW)).toBe(0);
  });

  it("returns 0 for an HTTP date equal to now", () => {
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT", NOW)).toBe(0);
  });

  it("returns 0 for a garbage string", () => {
    expect(parseRetryAfter("soon", NOW)).toBe(0);
  });

  it("returns 0 for a non-numeric, non-date string", () => {
    expect(parseRetryAfter("12.5 hours", NOW)).toBe(0);
  });

  it("always returns a finite number >= 0", () => {
    const cases: Array<string | number | null | undefined> = [
      null,
      undefined,
      "",
      "   ",
      120,
      "120",
      -5,
      "-5",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "soon",
      "Wed, 21 Oct 2026 07:00:00 GMT",
      "Wed, 21 Oct 2026 08:28:00 GMT",
    ];

    for (const value of cases) {
      const result = parseRetryAfter(value, NOW);
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });
});
