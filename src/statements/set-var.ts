/**
 * `setVar` / `updateVar` statements — the `!var` family. Both carry
 * their value in `context` (not `input[]`), a per-statement quirk confirmed by
 * the golden fixtures. They differ in how the target variable is named:
 *
 * - `set_var` declares a *new* stack variable via the top-level `as` slot
 *   (`var $x1 { value = ... }`) and emits no `output` envelope.
 * - `update_var` reassigns an *existing* stack variable named inside
 *   `context.name` (`update $x1 { value = ... }`), has no `as`, and carries a
 *   lean `output:{filters:[]}` envelope.
 */
import type { Statement } from "./statement.js";
import { registerStatement, annotate, ANNOTATION_KEYS, OPTION_KEYS } from "./statement.js";
import { assertKnownKeys } from "../util/known-keys.js";
import type { StatementAnnotations, StatementOptions } from "./statement.js";
import type { AuthValue, CaughtShape, CaughtValue, ConstValue, FilteredValue, Value } from "../values/value.js";
import type { ObjShape, ObjValue } from "../values/obj.js";
import type { AsShapeBrand, MemberUpdateBrand } from "./statement.js";
import type { FilterXdo } from "../types/xdo.js";
import type { ApplyFilters } from "../values/filter-result.js";
import { assertNewVarName, assertValueArg, assertVarName } from "./args.js";

export const SET_VAR = "mvp:set_var";

/** What an `s.set_var` of `auth(path)` binds, at the type level — resolved where it is read. */
export interface AuthShape<Path extends string> {
  readonly __authShape: Path;
}
export const UPDATE_VAR = "mvp:update_var";

/**
 * The shape a `set_var` binding traces to.
 *
 * A constant knows its JavaScript type at the call site, WIDENED to its
 * primitive ({@link WidenConst}): `c.int(1)` binds a number, `c.text("draft")` a
 * string and `c.bool(false)` a boolean — not the literals `"draft"`/`false`. A
 * variable is mutable, and not every in-place mutator (`s.text.append`, a write
 * inside a lambda) is visible to the type walk, so the literal it started as is
 * no promise about what the response returns. A FILTERED value folds its chain over
 * its base ({@link ApplyFilters}), so `withFilters(c.text("7"), fl.to_int())` is
 * `number` and `withFilters(inp("q"), fl.strlen())` is `number` too — a filter
 * with a fixed declared result needs nothing from the base. An `obj()` binds its
 * members ({@link ObjShape}), resolved where the variable is read. An `auth()`
 * read binds its path ({@link AuthShape}), resolved against the def's auth table
 * where the variable is read — as the same read written into `response` is. A
 * `caught(path)` read binds what the catch arm sets there ({@link CaughtShape}).
 * Every other value (a `ref`, an `inp`, a raw tag) resolves to `unknown`, the floor.
 */
export type ConstShape<V> =
  V extends ObjValue<infer Members>
    ? ObjShape<Members>
    : V extends FilteredValue<infer Base, infer Chain>
      ? ApplyFilters<Base extends AuthValue ? unknown : ConstShape<Base>, Chain>
      : V extends AuthValue<infer Path>
        ? AuthShape<Path>
        : V extends CaughtValue<infer Path>
          ? CaughtShape<Path>
          : V extends ConstValue<infer T>
            ? [T] extends [never]
              ? unknown
              : WidenConst<T>
            : unknown;

/**
 * A constant's literal type widened to what a variable holding it can hold:
 * string/number/boolean literals to their primitive, element- and member-wise
 * through a `c.array`/`c.obj` literal. An empty `c.array([])` stays the empty
 * tuple, which the response walk reads as an accumulator.
 */
export type WidenConst<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends readonly []
        ? T
        : T extends readonly unknown[]
          ? WidenConst<T[number]>[]
          : T extends object
            ? { -readonly [K in keyof T]: WidenConst<T[K]> }
            : T;

/**
 * Assign `value` to stack variable `as` (`var $as { value = ... }`).
 *
 * Brands the binding with the variable name and the type the value resolves to
 * ({@link ConstShape}), then folds the statement's own `asFilters` chain over it
 * — the engine applies that chain as the value binds, so
 * `s.set_var("n", c.text("7"), { asFilters: [fl.to_int()] })` binds a `number`,
 * not `"7"`.
 */
export function setVar<
  const As extends string,
  V extends Value,
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  as: As,
  value: V,
  a?: StatementOptions & { asFilters?: Fs },
): Statement & AsShapeBrand<As, ApplyFilters<ConstShape<V>, Fs>>;
export function setVar(as: string, value: Value, a?: StatementOptions): Statement;
export function setVar(as: string, value: Value, a?: StatementOptions): Statement {
  assertNewVarName("s.set_var", as, "name", a?.uncheckedAs);
  assertValueArg("s.set_var", "value", value);
  assertKnownKeys(`Statement "s.set_var": options`, a, OPTION_KEYS);
  return annotate(
    {
      name: SET_VAR,
      as,
      context: { value: value.value, tag: value.tag, filters: value.filters },
    },
    a,
  );
}

/**
 * Reassign existing stack variable `name` to `value` (`update $name { value = ... }`).
 *
 * A bare name brands the statement as a re-binding of that variable, with the
 * same shape a `set_var` of `value` binds ({@link ConstShape}), so a response
 * reading it after the update traces the new value. A dotted name (`"cart.total"`)
 * updates one member of the variable: the response walk sets that member to the
 * new value's type — or the union with its old type where the update may not
 * run (a branch, a loop, a `try`).
 */
export function updateVar<const N extends string, V extends Value>(
  name: N,
  value: V,
  a?: StatementAnnotations,
): N extends `${infer Base}.${infer Path}`
  ? Statement & MemberUpdateBrand<Base, Path, ConstShape<V>>
  : Statement & AsShapeBrand<N, ConstShape<V>>;
export function updateVar(name: string, value: Value, a?: StatementAnnotations): Statement;
export function updateVar(name: string, value: Value, a?: StatementAnnotations): Statement {
  assertVarName("s.update_var", name);
  assertValueArg("s.update_var", "value", value);
  assertKnownKeys(`Statement "s.update_var": options`, a, ANNOTATION_KEYS);
  return annotate(
    {
      name: UPDATE_VAR,
      context: { name, value: value.value, tag: value.tag, filters: value.filters },
      output: { filters: [] },
    },
    a,
  );
}

registerStatement(SET_VAR, setVar);
registerStatement(UPDATE_VAR, updateVar);
