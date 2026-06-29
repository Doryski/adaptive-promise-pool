import type { Adapter } from "../types"
import ours from "./00-ours"
import supercharge from "./10-supercharge-promise-pool"
import pMap from "./11-p-map"
import pLimit from "./12-p-limit"
import pQueue from "./13-p-queue"
import bottleneck from "./14-bottleneck"
import cockatiel from "./15-cockatiel"
import promisePoolSmart from "./20-promise-pool-smart"
import adaptiveConcurrency from "./21-adaptive-concurrency"
import adaptiveToolkit from "./22-adaptive-concurrency-toolkit"
import aimdBucket from "./24-aimd-bucket"
import congestionControl from "./25-congestion-control"
import pRetry from "./30-p-retry"
import pThrottle from "./31-p-throttle"
import limiter from "./32-limiter"

export const registry: Adapter[] = [
  ours,
  supercharge,
  pMap,
  pLimit,
  pQueue,
  bottleneck,
  cockatiel,
  promisePoolSmart,
  adaptiveConcurrency,
  adaptiveToolkit,
  aimdBucket,
  congestionControl,
  pRetry,
  pThrottle,
  limiter,
]
