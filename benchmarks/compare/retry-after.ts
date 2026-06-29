export const parseRetryAfter = (
  value: string | number | null | undefined,
  now: number,
): number => {
  if (value === null || value === undefined) return 0
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.max(0, value * 1000) : 0
  }
  const trimmed = value.trim()
  if (trimmed === "") return 0
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) return 0
  return Math.max(0, parsed - now)
}
