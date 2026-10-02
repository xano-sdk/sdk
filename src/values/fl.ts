/**
 * The public `fl` namespace: the generated filter constructors, with a reach
 * for a filter that does not exist (`fl.multiply`) refused at the access
 * naming the filter it most likely meant. A name with no plausible match reads
 * `undefined` as on any object, so probing code is unaffected.
 */
import { fl as generated } from "./generated/filters.generated.js";
import { nearestKey } from "../util/near-key.js";

/** Common spellings from other languages for a filter named differently here. */
const FILTER_ALIASES: Readonly<Record<string, string>> = {
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
}

/** The real filter a missing `fl.<name>` most likely meant, if any. */
export function suggestFilter(name: string): string | undefined {
  const names = Object.keys(generated);
  const alias = FILTER_ALIASES[name.toLowerCase().replace(/_/g, "")];
  if (alias !== undefined && names.includes(alias)) return alias;
  return nearestKey(name, names);
}

export const fl: typeof generated = /* @__PURE__ */ new Proxy(generated, {
  get(target, prop, receiver) {
    if (typeof prop !== "string" || prop in target || !/^[a-z]/i.test(prop)) return Reflect.get(target, prop, receiver);
    const near = suggestFilter(prop);
    if (near !== undefined) {
      throw new Error(`fl.${prop} is not a filter — did you mean fl.${near}? Every filter is listed in manifest.json \`filters\`.`);
    }
    return Reflect.get(target, prop, receiver);
  },
});
