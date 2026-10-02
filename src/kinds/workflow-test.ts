/**
 * Workflow test (end-to-end test) kind → payload key `workflow_test`. A named
 * stack with NO input and NO response: it invokes other workspace objects
 * (`s.function.call`, `s.task.call`, `s.api.call`, …) and asserts on the results
 * with `s.expect.*`. Structurally a `task` without a schedule, which is why this
 * file mirrors `task.ts` rather than the function envelope — there is no
 * `input`, `result`, `cache`, `middleware`, or `history` on this kind.
 *
 * ## The datasource is the hazard
 *
 * `datasource: ""` (the default) runs against an EMPTY datasource — what the
 * Xano UI labels "empty (recommended)". A non-empty value names a datasource
 * that the engine **clones** before running the test. Cloning a production-sized
 * datasource is slow enough to fail the run outright, so `""` is the only
 * default worth having and `"live"` warns at export.
 */
import type { DiagnosticsFor } from "../workspace/diagnostics.js";
import type { StackItemXdo } from "../types/xdo.js";
import { encodeStack } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";
import { brandDef } from "./def-brand.js";

export interface WorkflowTestDef {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "workflow_test";
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  docs?: string;
  /**
   * Datasource to run against. `""` (the default) means an EMPTY datasource —
   * the recommended default for isolated runs. Any other value names a datasource
   * the engine **clones** before the test runs; `"live"` warns at export to
   * prevent cloning large production databases, but in ephemeral test environments
   * `datasource: "live"` is safe and allows running tests against `table({ seed })` rows.
   */
  datasource?: string;
  /** Accepted export warnings — `"live"` on purpose (an ephemeral run). Never emitted. */
  diagnostics?: DiagnosticsFor<"workflow_test">;
  /** Whether the test is enabled. Defaults to `true` (the engine's own default). */
  active?: boolean;
  tags?: string[];
  /**
   * The test body: runs (`s.function.call`, `s.task.call`, …) interleaved with
   * assertions (`s.expect.*`). A workflow test takes no input and returns no
   * response — assert on what the runs bind with `as`.
   */
  stack?: Statement[];
}

export interface WorkflowTestXdo {
  name: string;
  description: string;
  docs: string;
  datasource: string;
  active: boolean;
  tag: Array<{ tag: string }>;
  run: StackItemXdo[];
}

/** Encode a `WorkflowTestDef` into the flattened importable `workflow_test` xdo. */
export function encodeWorkflowTest(def: WorkflowTestDef): WorkflowTestXdo {
  if (!def.name) throw new Error("workflowTest: `name` is required.");
  const datasource = def.datasource ?? "";
  return {
    name: def.name,
    description: def.description ?? "",
    docs: def.docs ?? "",
    datasource,
    active: def.active ?? true,
    tag: encodeTags(def.tags),
    run: encodeStack("workflowTest", def.name, def.stack),
  };
}

export const workflowTestKind: ObjectKind<WorkflowTestDef, WorkflowTestXdo> = {
  name: "workflow_test",
  payloadKey: "workflow_test",
  encode: encodeWorkflowTest,
};
registerKind(workflowTestKind);

/**
 * Declare an end-to-end test. Register it with `Xano.registerWorkflowTests`.
 *
 * The body is always the same shape: `.call` something and bind it with `as`,
 * then assert on that variable. `s.expect.*` is only meaningful here.
 *
 * ```ts
 * workflowTest({
 *   name: "signup_works",
 *   // datasource omitted — "" is an EMPTY datasource, and cloning a real one
 *   // before every run is slow enough to fail the run.
 *   stack: [
 *     s.function.call({ fn: createUser, input: { email: "a@b.c" }, as: "created" }),
 *     s.expect.to_equal({ expr: ref("created.status"), value: c.text("ok") }),
 *   ],
 * });
 * ```
 */
export function workflowTest(def: WorkflowTestDef): WorkflowTestDef {
  return brandDef(def, "workflow_test");
}
