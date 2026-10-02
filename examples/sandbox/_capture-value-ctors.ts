/**
 * Value-constructor capture harness (NOT a shipped example, NOT auto-indexed).
 *
 * Three value shapes have a dedicated constructor, and each one's claim is about
 * STORED BYTES — so each one is worth a readback rather than an argument:
 *
 *   1. `c.null("const:obj")` → `{tag:"const:obj", value:"null"}`, the object-typed
 *      null a `db.*` statement's `@meta` slot carries. The paired
 *      control is `c.obj(null)`, whose blank `value:""` must come back distinct —
 *      if the engine canonicalised one into the other, the two spellings would be
 *      one value and the exact constructor would be the wrong repair.
 *   2. `c.int("18446744073709551615")` → 2^64 − 1. The claim is that
 *      the engine stores an integer constant as a string and does not round it
 *      through a float on the way in; a readback of `…615` (not `…616`) is what
 *      settles it.
 *   3. `toolset("token")` / `toolset("params")` — that the tag
 *      persists verbatim on a tool, which is the only place it is bound.
 *
 * Run:  node dist/bin.js validate examples/sandbox/_capture-value-ctors.ts --capture --runtime --out validate-out
 */
import { workspace, defineFunction, tool, s, c, ref, toolset } from "@xano/sdk";

const defs = (xs: unknown[]) => xs as never[];

/**
 * Probe #1 — the object-typed null beside the blank object, in one function so
 * a single readback carries both and the two are diffable against each other.
 */
const probeNullSpellings = defineFunction({
  name: "ex_probe_value_null_spellings",
  stack: [
    s.set_var("obj_typed_null", c.null("const:obj")),
    s.set_var("obj_blank", c.obj(null)),
    s.set_var("plain_null", c.null()),
  ],
  response: ref("obj_typed_null"),
});

/**
 * Probe #2 — an integer past `Number.MAX_SAFE_INTEGER`, beside an ordinary one
 * so the readback shows whether the large one is treated differently at all.
 */
const probeBigInt = defineFunction({
  name: "ex_probe_value_uint64",
  stack: [
    s.set_var("uint64_max", c.int("18446744073709551615")),
    s.set_var("ordinary", c.int(42)),
  ],
  response: ref("uint64_max"),
});

/**
 * Probe #3 — the toolset-scoped bindings, on a tool because that is where the
 * engine binds them. Both roots plus a path into `params`, so the readback pins
 * the dotted form as well as the two bare ones.
 */
const probeToolsetBindings = tool({
  name: "ex_probe_toolset_bindings",
  description: "Read the toolset-scoped bindings",
  stack: [
    s.set_var("tok", toolset("token")),
    s.set_var("all_params", toolset("params")),
    s.set_var("one_param", toolset("params.tenant")),
  ],
  response: ref("tok"),
});

export default workspace("xanosdk-capture-value-ctors")
  .registerFunctions(defs([probeNullSpellings, probeBigInt]))
  .registerTools(defs([probeToolsetBindings]));
