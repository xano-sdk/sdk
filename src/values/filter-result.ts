/**
 * Filter-aware result typing — what a value becomes after a filter chain runs.
 *
 * A filter changes the value at runtime, and until now the type system had no
 * way to follow: `withFilters(ref("row"), fl.count())` typed as `unknown`, and a
 * statement's `asFilters` chain did not change the bound variable's type at all
 * (which was worse — the declared type was a confident lie).
 *
 * The engine's own filter catalog declares a `result` for 190 of the 225
 * filters, and {@link FilterResults} turns those declarations into types. This
 * module folds a chain over them, left to right, exactly as the engine applies
 * them — confirmed live: `[fl.first(), fl.get("id")]` over `[{"id":1}]` returns
 * `1`, so each filter genuinely sees the previous one's output.
 *
 * **What this does NOT do.** It does not check that a filter can *accept* the
 * value it is given. A filter applied to an incompatible value returns `null` at
 * runtime rather than erroring — `"ab" |trim|lower|count` is `null`, because
 * `count` is an array filter — so a nonsensical chain still types as its
 * declared result. Modelling filter INPUT types is separate work; this models
 * output only.
 */
import type { FilterXdo } from "../types/xdo.js";
import type {
  ElementResult,
  FilterResults,
  GroupedArrayResult,
  SameArrayResult,
} from "./generated/filters.generated.js";

/**
 * The filter name a {@link FilterXdo} carries at the type level.
 *
 * `fl.upper()` is a `FilterXdo<"upper">`; the bare `filter(someString)` escape
 * hatch and every decoded envelope are `FilterXdo<string>`, which widens to the
 * `string` that {@link ApplyFilter} treats as "not statically known".
 */
type NameOf<F> = F extends FilterXdo<infer N> ? N : string;

/**
 * Apply ONE filter's declared result to `Shape`.
 *
 * Null propagates rather than being erased, matching `IndexShape`'s treatment of
 * a nullable base and the engine's runtime, where a filter over a null
 * binding yields null: a `db.get` row is `Row | null`, so counting it is
 * `number | null`, not `number`.
 *
 * Anything not in {@link FilterResults} — the `any`-result filters (`get`,
 * `set`, `transform`, `json_decode`, `lambda`, …) and a name that is not
 * statically known — lands on `unknown`. That is the honest floor, and it is
 * where this deliberately stops rather than guessing.
 *
 * An `unknown` (or `any`) `Shape` is settled FIRST, before the null branch:
 * `null extends unknown` is true and `Exclude<unknown, null>` is still
 * `unknown`, so that branch recursed until TS2589 on every call whose target's
 * response is not known — `s.function.run({ fn: "name", asFilters: […] })`, or
 * a def with no `response`. A filter with a fixed result (`count` → `number`)
 * still says so; one whose result depends on the input stays `unknown`.
 */
export type ApplyFilter<Shape, N extends string> = string extends N
  ? unknown
  : unknown extends Shape
    ? UnknownShapeResult<N>
  : null extends Shape
    ? ApplyFilter<Exclude<Shape, null>, N> | null
    : N extends keyof FilterResults
      ? FilterResults[N] extends ElementResult
        ? // `<T>` — the element of the array it was given.
          Shape extends readonly (infer E)[]
          ? E
          : unknown
        : FilterResults[N] extends SameArrayResult
          ? // `<T>[]` — an array of the same element type.
            Shape extends readonly unknown[]
            ? Shape
            : unknown
          : FilterResults[N] extends GroupedArrayResult
            ? // A group-by: an object keyed by the argument path, whose every
              // value is an ARRAY of the elements — one match included. The key
              // is `string` because JSON object keys are, whatever the grouped
              // column's own type is.
              Shape extends readonly (infer E)[]
              ? Record<string, E[]>
              : unknown
            : FilterResults[N]
      : unknown;

/** {@link ApplyFilter} over a shape nothing is known about: a fixed result, else `unknown`. */
type UnknownShapeResult<N extends string> = N extends keyof FilterResults
  ? FilterResults[N] extends ElementResult | SameArrayResult | GroupedArrayResult
    ? unknown
    : FilterResults[N]
  : unknown;

/**
 * Fold a whole chain over `Shape`, left to right.
 *
 * An empty chain leaves the shape untouched, so attaching no filters is exactly
 * the same type as attaching none — `asFilters: []` does not degrade anything.
 */
export type ApplyFilters<Shape, Fs> = Fs extends readonly [infer Head, ...infer Tail]
  ? ApplyFilters<ApplyFilter<Shape, NameOf<Head>>, Tail>
  : Fs extends readonly []
    ? Shape
    : // A chain whose length is not statically known (a `FilterXdo[]` built at
      // runtime) says nothing about the result.
      unknown;
