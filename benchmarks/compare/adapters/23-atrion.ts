import type { Adapter, BenchCtx } from "./shared"

const adapter: Adapter = {
  meta: {
    name: "atrion",
    category: "adaptive",
    concurrencyMode: "adaptive",
    native: { retry: false, retryAfter: false },
    notes:
      "UNSUPPORTED: atrion@2.0.0 is broken on import — dist/atrion.js eagerly imports core/wasm/loader.js which statically imports the un-shipped atrion-physics/pkg/atrion_physics.js (ERR_MODULE_NOT_FOUND). The public Atrion admission gate (route() allow/deny, Z-score auto-tuned resistance on latency/error-rate) cannot be loaded. Would regulate THROUGHPUT/admission, not a fixed slot count.",
  },
  run: async (_ctx: BenchCtx) => {
    throw new Error(
      "unsupported: atrion@2.0.0 fails to import — dist/atrion.js -> core/wasm/loader.js statically imports the missing atrion-physics/pkg/atrion_physics.js (ERR_MODULE_NOT_FOUND); the Atrion admission API cannot be loaded.",
    )
  },
}

export default adapter
