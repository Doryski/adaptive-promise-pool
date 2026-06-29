import axios from "axios"
import axiosRetry, { exponentialDelay } from "axios-retry"
import type { Driver } from "../harness"
import { runWithGate, RETRY_BUDGET } from "./gate"

const client = axios.create({ validateStatus: (status) => status >= 200 && status < 300 })

axiosRetry(client, {
  retries: RETRY_BUDGET,
  retryCondition: (error) => error.response?.status === 429,
  retryDelay: exponentialDelay,
})

const driver: Driver = {
  name: "axios + axios-retry",
  mode: "fixed",
  run: (port, items, concurrency) =>
    runWithGate(items, concurrency, async (path) => {
      try {
        const res = await client.get(`http://127.0.0.1:${port}${path}`)
        return res.status >= 200 && res.status < 300
      } catch {
        return false
      }
    }),
}

export default driver
