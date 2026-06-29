import { stateActionHandler, defaultStateActions } from "fetch-rate-limit-util"
import type { Driver } from "../harness"
import { runWithGate, RETRY_BUDGET } from "./gate"

const postprocess = (response: Response): Response => response
const reporter = (): void => {}

const driver: Driver = {
  name: "fetch-rate-limit-util",
  mode: "fixed",
  run: (port, items, concurrency) =>
    runWithGate(items, concurrency, async (path) => {
      try {
        const res = await stateActionHandler(`http://127.0.0.1:${port}${path}`, {
          method: "GET",
          maxRetries: RETRY_BUDGET + 2,
          postprocess,
          reporter,
          stateActions: defaultStateActions,
        })
        return res.ok
      } catch {
        return false
      }
    }),
}

export default driver
