import got from "got"
import type { Driver } from "../harness"
import { runWithGate, RETRY_BUDGET } from "./gate"

const driver: Driver = {
  name: "got",
  mode: "fixed",
  run: (port, items, concurrency) =>
    runWithGate(items, concurrency, async (path) => {
      const res = await got(`http://127.0.0.1:${port}${path}`, {
        retry: { limit: RETRY_BUDGET, methods: ["GET"], statusCodes: [429] },
        throwHttpErrors: false,
      })
      return res.statusCode >= 200 && res.statusCode < 300
    }),
}

export default driver
