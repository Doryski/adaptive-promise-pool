import ky from "ky"
import type { Driver } from "../harness"
import { runWithGate, RETRY_BUDGET } from "./gate"

const driver: Driver = {
  name: "ky",
  mode: "fixed",
  run: (port, items, concurrency) =>
    runWithGate(items, concurrency, async (path) => {
      try {
        const res = await ky(`http://127.0.0.1:${port}${path}`, {
          retry: { limit: RETRY_BUDGET, methods: ["get"], afterStatusCodes: [429], statusCodes: [429] },
        })
        return res.ok
      } catch {
        return false
      }
    }),
}

export default driver
