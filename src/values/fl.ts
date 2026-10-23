/**
 * The public `fl` namespace: the generated filter constructors, with a reach
 * for a filter that does not exist (`fl.multiply`) refused at the access
 * naming the filter it most likely meant. A name with no plausible match reads
 * `undefined` as on any object, so probing code is unaffected.
 */
import { fl as generated } from "./generated/filters.generated.js";
import { nearestKey } from "../util/near-key.js";

/** Common spellings from other languages for a filter named differently here. */
const FILTER_ALIASES = {
  multiply: "mul",
  times: "mul",
  divide: "div",
  subtract: "sub",
  minus: "sub",
  plus: "add",
  modulo: "mod",
  uppercase: "upper",
  toupper: "upper",
  touppercase: "upper",
  lowercase: "lower",
  tolower: "lower",
  tolowercase: "lower",
  len: "strlen",
  includes: "contains",
  startswith: "starts_with",
  endswith: "ends_with",
  replace: "string_replace",
  replaceall: "string_replace",
  tostring: "to_text",
  tostr: "to_text",
  parseint: "to_int",
  tonumber: "to_decimal",
  parsefloat: "to_decimal",
  jsonparse: "json_decode",
  jsonstringify: "json_encode",
  stringify: "json_encode",
  keys: "array_keys",
  values: "array_values",
  slice: "array_slice",
  isempty: "empty",
} as const satisfies Record<string, string>;

type FilterAliases = typeof FILTER_ALIASES;

/**
 * Each alias as a member whose only parameter is the hint itself, so
 * `fl.subtract(c.int(1))` fails typecheck naming the real filter instead of
 * "Property 'subtract' does not exist", and a hover shows the same message.
 * An alias that is itself a real filter name is left to the real filter.
 */
type FilterAliasHints = {
  readonly [K in Exclude<keyof FilterAliases, keyof typeof generated>]: (
    did_you_mean: `fl.${K} is not a filter — did you mean fl.${FilterAliases[K]}?`,
  ) => never;
};

/** The real filter a missing `fl.<name>` most likely meant, if any. */
export function suggestFilter(name: string): string | undefined {
  const names = Object.keys(generated);
  const alias = (FILTER_ALIASES as Readonly<Record<string, string>>)[name.toLowerCase().replace(/_/g, "")];
  if (alias !== undefined && names.includes(alias)) return alias;
  return nearestKey(name, names);
}

export const fl: typeof generated & FilterAliasHints = /* @__PURE__ */ new Proxy(generated as typeof generated & FilterAliasHints, {
  get(target, prop, receiver) {
    if (typeof prop !== "string" || prop in target || !/^[a-z]/i.test(prop)) return Reflect.get(target, prop, receiver);
    const near = suggestFilter(prop);
    if (near !== undefined) {
      throw new Error(`fl.${prop} is not a filter — did you mean fl.${near}? Every filter is listed in manifest.json \`filters\`.`);
    }
    return Reflect.get(target, prop, receiver);
  },
});
