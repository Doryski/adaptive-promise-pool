export const runWithGate = async <T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<boolean>,
): Promise<{ ok: number; failed: number }> => {
  let ok = 0
  let failed = 0
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      const item = items[index] as T
      try {
        const succeeded = await task(item)
        if (succeeded) ok += 1
        else failed += 1
      } catch {
        failed += 1
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.all(workers)
  return { ok, failed }
}

export const RETRY_BUDGET = 5
