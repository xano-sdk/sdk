/**
 * Generated statement catalog — the hand-written wrapper around the
 * machine-generated spec data in `specs.generated.ts`.
 *
 * `specs.generated.ts` is produced by `scripts/codegen.ts` from the Xano engine's
 * statement schema definitions (run `npm run codegen` to regenerate). This file owns
 * the stable surface: it registers every generated spec on the statement
 * registry and exposes ergonomic, typed factories for the common families.
 * Widening coverage = regenerating the spec data, not editing bespoke code.
 */
import { encodeFromSpec, registerSpec } from "../schema-dsl/interpret.js";
import type { StatementSpec } from "../schema-dsl/interpret.js";
import type { Statement } from "../statement.js";
import { isRegisteredStatement } from "../statement.js";
import type { Value } from "../../values/value.js";
import { GENERATED_SPECS } from "./specs.generated.js";

export { GENERATED_SPECS };

// A few statements (mvp:die, mvp:debug_log) are also hand-authored as
// control-flow specials with equivalent encoders. Whichever module loads first
// owns the registration; skip here to avoid clobbering an existing factory.
for (const spec of GENERATED_SPECS) {
  if (!isRegisteredStatement(spec.name)) registerSpec(spec);
}

const specByName = new Map(GENERATED_SPECS.map((s) => [s.name, s]));

function spec(name: string): StatementSpec {
  const s = specByName.get(name);
  if (!s) throw new Error(`Generated catalog is missing expected statement "${name}".`);
  return s;
}

/** argNameIsVar mutation family: `(varName, value)` → `name`/value-spread context. */
function mutation(name: string): (varName: string, value: Value) => Statement {
  const s = spec(name);
  return (varName, value) => encodeFromSpec(s, { name: varName, value });
}

/** object.* family: `(as, value)` → top-level `as`, value nested under `context.object`. */
function objectOp(name: string): (as: string, value: Value) => Statement {
  const s = spec(name);
  return (as, value) => encodeFromSpec(s, { as, value });
}

// Ergonomic factories for the validated families (re-exported from the public API).
export const mathAdd = mutation("mvp:math_add");
export const mathSub = mutation("mvp:math_sub");
export const mathMul = mutation("mvp:math_mul");
export const mathDiv = mutation("mvp:math_div");
export const bitwiseAnd = mutation("mvp:bitwise_and");
export const bitwiseOr = mutation("mvp:bitwise_or");
export const bitwiseXor = mutation("mvp:bitwise_xor");
export const textAppend = mutation("mvp:text_append");
export const textPrepend = mutation("mvp:text_prepend");
export const objectKeys = objectOp("mvp:object_keys");
export const objectValues = objectOp("mvp:object_values");
export const objectEntries = objectOp("mvp:object_entries");

/** Names of all statements produced by the generated catalog. */
export const GENERATED_STATEMENT_NAMES: string[] = GENERATED_SPECS.map((s) => s.name);
