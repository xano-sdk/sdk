/**
 * array.map object-mode capture harness (NOT a shipped example, NOT auto-indexed).
 *
 * Sources the missing golden for `mvp:array_map` with `output_type:"object"`.
 * The value-mode path already has one; the object path is modeled from three
 * agreeing sources (the statement's declared context schema, the engine's own
 * transform decoder, and the editor component) but never captured.
 *
 * Two questions the sources only imply, and a readback settles:
 *   1. the `attribute_key` tag on a static object key (modeled as plain `const`);
 *   2. whether a persisted object-mode statement carries the DEAD branch —
 *      `transform_value` at its schema defaults — which `liveArrayMapContext`
 *      in src/validate/normalize.ts now treats as inert exhaust. Note the
 *      capture round-trips what the SDK IMPORTED, so a clean readback confirms
 *      the engine keeps the minimal spelling; it cannot prove what the editor
 *      would add on top. Probe #2 is the paired control for that.
 *
 * Run:  node dist/bin.js validate examples/sandbox/_capture-array-map.ts --capture --runtime --out validate-out
 */
import { workspace, defineFunction, s, c, ref, withFilters, filter } from "@xano/sdk";

const defs = (xs: unknown[]) => xs as never[];

/**
 * Probe #1 — object mode, one statement per function so the golden promotes
 * straight out of `run[0]`. Two attributes, one referencing `$this` and one
 * `$index`, so key ORDER and both mapping variables are pinned at once.
 */
const probeArrayMapObject = defineFunction({
  name: "ex_probe_array_map_object",
  stack: [
    s.array.map({
      source: withFilters(c.text("[1,2,3]"), filter("json_decode")),
      transform: { value: ref("$this"), position: ref("$index") },
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

/**
 * Probe #2 — the value-mode control, authored identically apart from the
 * transform. Captured alongside so the two readbacks can be diffed against each
 * other: any member present in both is envelope, not object-mode shape.
 */
const probeArrayMapValue = defineFunction({
  name: "ex_probe_array_map_value",
  stack: [
    s.array.map({
      source: withFilters(c.text("[1,2,3]"), filter("json_decode")),
      transform: ref("$this"),
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

/**
 * Probe #3 — a single-attribute object mapping with a CONSTANT value, so the
 * `attribute_value` tag is pinned on something other than a var reference.
 */
const probeArrayMapObjectConst = defineFunction({
  name: "ex_probe_array_map_object_const",
  stack: [
    s.array.map({
      source: withFilters(c.text("[1,2,3]"), filter("json_decode")),
      transform: { label: c.text("row"), n: ref("$this") },
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

export default workspace("xanosdk-capture-array-map").registerFunctions(
  defs([probeArrayMapObject, probeArrayMapValue, probeArrayMapObjectConst]),
);
