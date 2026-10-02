/**
 * The closed value sets of the hand-authored statements' runtime inputs.
 *
 * The generated catalog carries its statements' enum constraints on the spec,
 * and the shared guard ({@link ../schema-dsl/enum-guard.ts}) refuses a constant
 * outside one at the call. The hand-authored wrappers have no spec, so their
 * constrained inputs are listed here and routed through the same guard: a
 * constant the engine would refuse at request time (`400 … is not one of the
 * allowable values`) is refused when the def is built instead. Keyed by stored
 * statement name, then stored input name.
 */
import { resolveEnumValue } from "../schema-dsl/enum-guard.js";
import type { Value } from "../../values/value.js";
import { presentValueArg } from "../args.js";

export const SPECIAL_INPUT_ENUMS = {
  "mvp:get_input": { encoding: ["json", "yaml", "x-www-form-urlencoded", "none"] },
  "mvp:cloud_job": { template: ["micro", "small", "medium", "large", "xlarge"] },
  "mvp:call_agent": { version: ["v4", "v5"] },
} as const satisfies Record<string, Record<string, readonly string[]>>;

type Enums = typeof SPECIAL_INPUT_ENUMS;

/** The literal values one constrained input takes. */
export type SpecialEnum<S extends keyof Enums, F extends keyof Enums[S]> = Enums[S][F] extends readonly (infer V)[]
  ? V
  : never;

/**
 * An authored constrained input as its {@link Value}: a bare literal is checked
 * and coerced (the bytes `c.text(...)` gives), a constant outside the set is
 * refused naming the set and the near miss, and a dynamic or filtered value
 * passes, since only the request can say what it holds.
 */
export function specialEnumValue<S extends keyof Enums>(
  stored: S,
  statement: string,
  field: string,
  input: keyof Enums[S] & string,
  provided: unknown,
  /** Said after a refusal: what the set's members mean, when the names alone do not say. */
  note?: string,
): Value {
  const values = (SPECIAL_INPUT_ENUMS[stored] as Record<string, readonly string[]>)[input]!;
  // Anything but a literal or a tagged value is refused as every value argument is.
  if (typeof provided !== "string") presentValueArg(statement, field, provided);
  try {
    return resolveEnumValue(statement, field, values, provided);
  } catch (err) {
    if (note !== undefined && err instanceof Error) err.message = `${err.message} ${note}`;
    throw err;
  }
}
