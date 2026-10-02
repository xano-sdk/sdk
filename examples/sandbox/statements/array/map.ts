/**
 * `s.array.map({ source, transform?, as? })` — map each element through an
 * expression. `$this` is the current element, `$index` its position.
 *
 * `transform` picks the output shape: a single value maps each item to that
 * value; a record of values maps each item to an object with those keys; a list
 * of `{key, value}` pairs does the same for a key the engine computes per item,
 * or for two rows that share a key.
 */
import { defineFunction, s, c, f, input, inp, ref, withFilters, fl } from "@xano/sdk";

export const arrayMap = defineFunction({
  name: "ex_array_map",
  stack: [
    s.array.map({
      source: c.array([1, 2, 3]),
      transform: withFilters(ref("$this"), fl.mul(c.int(2))),
      as: "doubled",
    }),
  ],
  response: ref("doubled"),
});

/** The object form: `[1,2,3]` → `[{value:1, position:0}, …]`. */
export const arrayMapToObjects = defineFunction({
  name: "ex_array_map_object",
  stack: [
    s.array.map({
      source: c.array([1, 2, 3]),
      transform: { value: ref("$this"), position: ref("$index") },
      as: "rows",
    }),
  ],
  response: ref("rows"),
});

/**
 * The pair form: for a key that is not a literal. Here each row is keyed by a
 * field of the item itself, which a record cannot spell — its keys are fixed at
 * author time, while the engine evaluates `key` per item exactly as it evaluates
 * `value`.
 */
export const arrayMapComputedKeys = defineFunction({
  name: "ex_array_map_computed_key",
  // Declared rather than assumed: `ref("orders")` with nothing binding it
  // exports clean and raises `Unable to locate var` at runtime.
  input: { orders: input.list(input.object({ sku: f.text(), total: f.decimal() })) },
  stack: [
    s.array.map({
      source: inp("orders"),
      transform: [{ key: ref("$this.sku"), value: ref("$this.total") }],
      as: "by_sku",
    }),
  ],
  response: ref("by_sku"),
});
