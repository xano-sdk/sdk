/**
 * Background execution for a call statement.
 *
 * Shared by `function.run` and `ai.agent.run`: the engine reads the SAME
 * top-level `runtime` block for both, in one `switch` over `runtime.mode`.
 * Keeping the model in one place is what stops the two surfaces drifting into
 * different vocabularies — which is exactly what had happened before this
 * module existed.
 */

/**
 * How a call executes: synchronously (the default), or in the background on
 * shared or dedicated async workers.
 *
 * Stored as a TOP-LEVEL `runtime` block on the stack item — not inside
 * `context`. The engine switches on `runtime.mode` and treats every value
 * outside this union (including the absent block and the editor's explicit
 * `"disabled"`) as synchronous.
 *
 * Async is not a performance knob — it changes what the statement returns.
 * `mvp:function` is rewritten to `mvp:async_function`, so the call no longer
 * yields the function's result; it dispatches and continues. Pair it with
 * `s.await(...)` to collect results.
 */
export type AsyncMode = "async-shared" | "async-dedicated";

/** Background execution settings for a call. */
export interface AsyncRuntime {
  /**
   * `"async-shared"` runs on the instance's pooled async workers and reads no
   * other member here. `"async-dedicated"` reserves its own resources and is
   * the only mode for which `cpu`/`memory`/`timeout`/`maxRetry` are read.
   */
  mode: AsyncMode;
  /** Dedicated only. Kubernetes CPU request — e.g. `"100m"`, `"250m"`, `"500m"`. */
  cpu?: string;
  /** Dedicated only. Kubernetes memory request — e.g. `"256Mi"`, `"512Mi"`, `"1Gi"`. */
  memory?: string;
  /** Dedicated only. Seconds before the run is abandoned. */
  timeout?: string | number;
  /** Dedicated only. Retries after a failed run. */
  maxRetry?: string | number;
}

/**
 * The stored `runtime` block, or `undefined` for a synchronous call.
 *
 * At `async-shared` the engine builds its runtime config from `mode` ALONE, so
 * the resource members are not emitted — the editor writes them blank at that
 * mode and they are inert. At `async-dedicated` all four are read and are
 * emitted at whatever was authored.
 */
export function encodeAsyncRuntime(runtime?: AsyncRuntime): Record<string, unknown> | undefined {
  if (!runtime) return undefined;
  if (runtime.mode !== "async-dedicated") return { mode: runtime.mode };
  return {
    mode: runtime.mode,
    cpu: runtime.cpu ?? "",
    memory: runtime.memory ?? "",
    timeout: runtime.timeout === undefined ? "" : String(runtime.timeout),
    max_retry: runtime.maxRetry === undefined ? "" : String(runtime.maxRetry),
  };
}
