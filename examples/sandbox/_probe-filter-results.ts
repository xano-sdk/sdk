/**
 * Probe — does a filter's DECLARED `result` type match what it actually returns?
 *
 * The filter catalog ships a `result` for 222 of 225 filters (`text`, `int`,
 * `decimal`, `bool`, `<T>`, `<T>[]`, `any`, …). Filter-aware result typing reads
 * those declarations and hands them to TypeScript as fact — so a declaration
 * that lies would turn today's honest `unknown` into a confident wrong type,
 * which is strictly worse.
 *
 * The declarations come from the platform, not from us, and nothing in the
 * toolchain checks them. This runs one filter per declared result category on a
 * live engine and reports the JSON type that actually comes back, so the mapping
 * is built on observed behaviour rather than on trusting the metadata.
 *
 * Read the output as JSON types: a quoted value is text, a bare number is
 * int/decimal, `true`/`false` is bool, `[...]` an array, `{...}` an object.
 *
 * Run:  node dist/bin.js validate examples/sandbox/_probe-filter-results.ts --runtime --verbose
 */
import { workspace, defineFunction, s, c, ref, fl, withFilters } from "@xano/sdk";

const defs = (xs: unknown[]) => xs as never[];

/** A decoded `[3,1,2]` — the array input the array-family probes share. */
const nums = () => withFilters(c.text("[3,1,2]"), fl.json_decode());
/** A decoded `[{"id":1},{"id":2}]` — for the element-returning filters. */
const rows = () => withFilters(c.text('[{"id":1},{"id":2}]'), fl.json_decode());

export const probeFilterResults = defineFunction({
  name: "ex_probe_filter_results",
  stack: [
    // ── scalar results ──────────────────────────────────────────────────────
    s.set_var("r_text", c.text("ab"), { asFilters: [fl.upper()] }),
    s.set_var("r_int_count", nums(), { asFilters: [fl.count()] }),
    s.set_var("r_int_floor", c.decimal(2.7), { asFilters: [fl.floor()] }),
    s.set_var("r_decimal_round", c.decimal(2.345), { asFilters: [fl.round(c.int(2))] }),
    s.set_var("r_decimal_avg", nums(), { asFilters: [fl.avg()] }),
    s.set_var("r_bool", c.text(""), { asFilters: [fl.empty()] }),
    s.set_var("r_epochms", c.text("2026-01-01"), { asFilters: [fl.to_epochms()] }),
    // Declared `string` rather than `text` — the only filter that spells it that
    // way, so it is worth seeing whether it differs from `text` at all.
    s.set_var("r_string", c.decimal(1234.5), { asFilters: [fl.number_format(c.int(2), c.text("."), c.text(","))] }),

    // ── generic results ─────────────────────────────────────────────────────
    // `<T>` — declared to return the ELEMENT of the array it is given.
    s.set_var("r_generic_first", rows(), { asFilters: [fl.first()] }),
    s.set_var("r_generic_last", nums(), { asFilters: [fl.last()] }),
    // `<T>[]` — declared to return an array of the same element type.
    s.set_var("r_generic_arr_reverse", nums(), { asFilters: [fl.reverse()] }),
    s.set_var("r_generic_arr_unique", nums(), { asFilters: [fl.unique()] }),
    // `append` is declared `<T>[]` but its DESCRIPTION says it returns the
    // updated object — the one declaration most likely to be wrong.
    s.set_var("r_generic_arr_append", nums(), { asFilters: [fl.append(c.int(9), c.text(""))] }),

    // ── concrete array results ──────────────────────────────────────────────
    s.set_var("r_text_arr", c.text("a,b,c"), { asFilters: [fl.split(c.text(","))] }),
    s.set_var("r_int_arr", c.int(0), { asFilters: [fl.range(c.int(1), c.int(3))] }),

    // ── `any` results (expected to stay `unknown` in the type system) ────────
    s.set_var("r_any_decode", c.text('{"k":1}'), { asFilters: [fl.json_decode()] }),
    s.set_var("r_any_get", rows(), { asFilters: [fl.first(), fl.get(c.text("id"))] }),

    // ── a chain: does the SECOND filter see the first's output? ──────────────
    s.set_var("r_chain", c.text("  Ab  "), { asFilters: [fl.trim(), fl.lower(), fl.count()] }),
  ],
  response: {
    r_text: ref("r_text"),
    r_int_count: ref("r_int_count"),
    r_int_floor: ref("r_int_floor"),
    r_decimal_round: ref("r_decimal_round"),
    r_decimal_avg: ref("r_decimal_avg"),
    r_bool: ref("r_bool"),
    r_epochms: ref("r_epochms"),
    r_string: ref("r_string"),
    r_generic_first: ref("r_generic_first"),
    r_generic_last: ref("r_generic_last"),
    r_generic_arr_reverse: ref("r_generic_arr_reverse"),
    r_generic_arr_unique: ref("r_generic_arr_unique"),
    r_generic_arr_append: ref("r_generic_arr_append"),
    r_text_arr: ref("r_text_arr"),
    r_int_arr: ref("r_int_arr"),
    r_any_decode: ref("r_any_decode"),
    r_any_get: ref("r_any_get"),
    r_chain: ref("r_chain"),
  },
});

export default workspace("xanosdk-probe-filter-results").registerFunctions(
  defs([probeFilterResults]),
);
