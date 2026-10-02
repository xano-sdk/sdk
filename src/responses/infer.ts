/**
 * `InferResponse<Q>` — the response type for a query or function def,
 * the read-side counterpart of `InferInput`. Closes the round trip: rename or
 * retype what an endpoint returns and every consumer that types a response
 * against `InferResponse` lights up at compile time.
 *
 * ```ts
 * const listLinks = query({ verb: "GET", apiGroup: links, name: "list_links",
 *   stack: [s.db.query({ table: link, as: "rows" })], response: ref("rows"),
 *   responseShape: [] as InferRow<typeof link>[] });
 *
 * type Links = InferResponse<typeof listLinks>;   // InferRow<typeof link>[]
 * const res = await fetch(BASE + listLinks.getPath());
 * const links: Links = await res.json();          // typed end to end
 * ```
 *
 * **Hybrid resolution** (mirrors how the Xano engine derives its OpenAPI response
 * schema — a static walk that degrades to `json` where truth isn't statically
 * knowable):
 *   1. A declared `responseShape` on the def always wins (the override).
 *   2. Otherwise the shape is auto-derived from `response` + `stack`
 *      ({@link DeriveResponse}) — object-literal keys and a single variable
 *      traced to a typed `db.get`/`db.query`. A dotted `ref("var.field")`
 *      traces the base variable, then indexes the subpath into its shape.
 *   3. Anything the walk can't resolve (lambdas, a var bound only inside a
 *      branch, a call target named by string, streams) resolves to `unknown`,
 *      which the author narrows or overrides via `responseShape`.
 */
import type { Value, RefValue, FilteredValue, InpValue, AuthValue, ConstValue, CaughtValue, CaughtShape } from "../values/value.js";
import type { TableDef } from "../kinds/table.js";
import type { InferInput } from "../inputs/infer.js";
import type { ObjShape, ObjValue } from "../values/obj.js";
import type { ArrayMapShape } from "../statements/special/misc.js";
import type { AuthShape, WidenConst } from "../statements/set-var.js";
import type { ApplyFilters } from "../values/filter-result.js";
import type {
  AppendBrand,
  AsShapeBrand,
  BodyBrand,
  BranchesBrand,
  CatchBrand,
  FoundBrand,
  MaybeBodyBrand,
  MemberUpdateBrand,
} from "../statements/statement.js";
import type { Prettify } from "../fields/value-types.js";
import type { PathParams } from "../kinds/path-params.js";

/**
 * The author-declared response shape, read from a def's `responseShape` field
 * (captured by `query()`/`defineFunction()`), or `never` when undeclared.
 *
 * Read structurally rather than off the `Res` type argument: an undeclared def
 * carries `responseShape?: never`, whose optional-collapsed field type is
 * `undefined` — the `[R] extends [undefined]` gate maps that to `never` (→ route
 * to derivation). A declared shape's field type is `T | undefined`; stripping the
 * optional `undefined` with `Exclude` recovers `T` **while preserving a
 * deliberate `| null`** (e.g. `InferRow<...> | null` stays nullable).
 */
type DeclaredResponse<Q> = Q extends { responseShape?: infer R }
  ? [R] extends [undefined]
    ? never
    : Exclude<R, undefined>
  : never;

/**
 * What a response resolves to when the stack is a plain `Statement[]` rather
 * than a tuple.
 *
 * A widened stack has no heads to walk, so EVERY `as` binding in it is invisible
 * and every `ref()` bottoms out. Resolving that to `unknown` made the failure
 * silent and moved the error downstream ("Property 'model_id' does not exist on
 * type '{}'", in the page that consumes the response). Resolving it to this
 * named type puts the cause and the two fixes in the error itself.
 *
 * The cause is almost always a shared helper typed `Statement[]` spread into the
 * stack: `...assertOk("res")`. Return `statements(...)` from the helper to keep
 * the tuple, or declare `responseShape` on this def.
 */
export interface StackTupleWidened {
  readonly __xanosdk_response_not_inferred: "This stack is a `Statement[]`, not a tuple, so no `as` binding in it can be traced. A helper returning `Statement[]` and spread into the stack is the usual cause: return `statements(...)` from the helper (fixed arity), or declare `responseShape` on this def.";
}

/**
 * Is `S` a widened array (not a fixed tuple)? A fixed tuple's `length` is a
 * literal. A REST tuple (`[DbGet, ...Statement[]]` — what a stack with a helper
 * spread at the END looks like) has a `number` length too, which is why the
 * report below is gated on the trace actually failing rather than on this
 * alone: a binding declared before the spread still traces perfectly.
 */
type IsWidenedStack<S> = S extends readonly unknown[]
  ? number extends S["length"]
    ? true
    : false
  : false;

/**
 * Report the collapse only where it actually happened: an unresolved value
 * (`unknown`) against a stack whose tuple was widened. A ref that still traced —
 * because it was bound before the spread, in a rest tuple — keeps its type, and
 * an unresolvable ref in a proper tuple keeps the honest `unknown` floor (it is
 * a filter/lambda/control-flow case, not a widening one).
 */
type ReportWidened<T, S> = IsWidenedStack<S> extends true
  ? unknown extends T
    ? StackTupleWidened
    : T
  : T;

/** Where an inlined `try` body starts and ends ({@link Inline}). Type-only markers. */
interface TryStart {
  readonly __tryStart: true;
}
interface TryEnd {
  readonly __tryEnd: true;
}

/**
 * Walk to the LAST binding of `Name` the response can see. `InTry` counts the
 * open `try` bodies around the walk: a `try` may stop at any statement, so a
 * binding inside one unions with the binding from before it ({@link OrPrior}).
 * A `try_catch` both of whose blocks re-bind the name, and a branch statement
 * every branch of which re-binds it ({@link BranchesBrand}), replace the value
 * from before with the union of their blocks. `Floor` is what a walk that finds
 * no binding resolves to.
 */
type TraceBinding<
  Name extends string,
  S,
  Full = S,
  I = unknown,
  Before extends readonly unknown[] = [],
  InTry extends readonly unknown[] = [],
  Floor = unknown,
> = S extends readonly [infer Head, ...infer Tail]
  ? Head extends TryStart
    ? TraceBinding<Name, Tail, Full, I, [...Before, Head], [...InTry, Head], Floor>
    : Head extends TryEnd
      ? TraceBinding<Name, Tail, Full, I, [...Before, Head], InTry extends readonly [unknown, ...infer Open] ? Open : [], Floor>
      : Head extends CatchBrand<infer Try, infer Catch>
        ? [RebindsLater<Name, Inline<Try>>, RebindsLater<Name, Inline<Catch>>] extends [true, true]
          ? RebindsLater<Name, SkipTry<Tail>> extends true
            ? TraceBinding<Name, Tail, Full, I, [...Before, Head], InTry, Floor>
            :
                | TraceBinding<Name, Inline<Try>, Full, I, Before>
                | TraceBinding<Name, Inline<Catch>, Full, I, Before>
                | MaybeRebound<Name, SkipTry<Tail>, [...Before, Head], I>
                | OrPrior<Name, InTry, Before, Full, I>
          : TraceBinding<Name, Tail, Full, I, [...Before, Head], InTry, Floor>
        : Head extends BranchesBrand<infer Branches>
          ? AllRebind<Name, Branches> extends true
            ? RebindsLater<Name, Tail> extends true
              ? TraceBinding<Name, Tail, Full, I, [...Before, Head], InTry, Floor>
              :
                  | BranchTraces<Name, Branches, Full, I, Before>
                  | MaybeRebound<Name, Tail, [...Before, Head], I>
                  | OrPrior<Name, InTry, Before, Full, I>
            : TraceBinding<Name, Tail, Full, I, [...Before, Head], InTry, Floor>
          : Head extends AsShapeBrand<infer As, infer Shape>
            ? [As, Name] extends [Name, As]
              ? RebindsLater<Name, Tail> extends true
                ? TraceBinding<Name, Tail, Full, I, [...Before, Head], InTry, Floor>
                :
                    | Accumulate<NarrowFound<BoundShape<Shape, Before, I>, Name, Tail>, Appended<Name, Tail, Full>>
                    | MaybeRebound<Name, Tail, [...Before, Head], I>
                    | OrPrior<Name, InTry, Before, Full, I>
              : TraceBinding<Name, Tail, Full, I, [...Before, Head], InTry, Floor>
            : TraceBinding<Name, Tail, Full, I, [...Before, Head], InTry, Floor>
  : Floor;

/**
 * Inside a `try` body, the binding the walk lands on may never run — the body
 * can stop before it — so the binding from before it stays possible. `never`
 * outside a `try`, or when nothing bound the name before.
 */
type OrPrior<Name extends string, InTry extends readonly unknown[], Before extends readonly unknown[], Full, I> = InTry extends readonly []
  ? never
  : TraceBinding<Name, Before, Full, I, [], [], never>;

/** `S` past the `try` body {@link Inline} spliced in at its head. */
type SkipTry<S, Open extends readonly unknown[] = []> = S extends readonly [infer Head, ...infer Tail]
  ? Head extends TryStart
    ? SkipTry<Tail, [...Open, Head]>
    : Head extends TryEnd
      ? Open extends readonly [unknown, ...infer Rest]
        ? Rest extends readonly []
          ? Tail
          : SkipTry<Tail, Rest>
        : S
      : Open extends readonly []
        ? S
        : SkipTry<Tail, Open>
  : S;

/** Does every branch re-bind `Name` at its top level? */
type AllRebind<Name extends string, Branches> = Branches extends readonly [infer B, ...infer Rest]
  ? RebindsLater<Name, Inline<B>> extends true
    ? AllRebind<Name, Rest>
    : false
  : true;

/** The union of what each branch binds `Name` to, each resolved against the statements before the branch statement. */
type BranchTraces<Name extends string, Branches, Full, I, Before extends readonly unknown[]> = Branches extends readonly [
  infer B,
  ...infer Rest,
]
  ? TraceBinding<Name, Inline<B>, Full, I, Before> | BranchTraces<Name, Rest, Full, I, Before>
  : never;

/**
 * The shapes `Name` may be re-bound to by a sub-stack after its last top-level
 * binding that MAY run — a conditional branch or a loop body
 * ({@link MaybeBodyBrand}), or a `try_catch`'s `catch` ({@link CatchBrand}). The
 * response reads either the top-level value or one of these, so the trace is
 * their union: `set_var("on", c.bool(false))` then a branch setting it `true`
 * reads `boolean`, and a `db.query` re-bound to a `db.get` in a loop reads
 * `Row[] | Row | null`. A body's bindings resolve against the statements before
 * the body.
 */
type MaybeRebound<Name extends string, S, Before extends readonly unknown[], I> = S extends readonly [infer Head, ...infer Tail]
  ?
      | (Head extends MaybeBodyBrand<infer B> ? BindsIn<Name, Inline<B>, Before, I> : never)
      | (Head extends CatchBrand<readonly unknown[], infer C> ? BindsIn<Name, Inline<C>, Before, I> : never)
      | MaybeRebound<Name, Tail, [...Before, Head], I>
  : never;

/** Every shape a sub-stack binds `Name` to, nested sub-stacks included. */
type BindsIn<Name extends string, S, Before extends readonly unknown[], I> = S extends readonly [infer Head, ...infer Tail]
  ?
      | (Head extends AsShapeBrand<infer As, infer Shape> ? ([As] extends [Name] ? ([Name] extends [As] ? BoundShape<Shape, Before, I> : never) : never) : never)
      | (Head extends MaybeBodyBrand<infer B> ? BindsIn<Name, Inline<B>, Before, I> : never)
      | (Head extends CatchBrand<readonly unknown[], infer C> ? BindsIn<Name, Inline<C>, Before, I> : never)
      | BindsIn<Name, Tail, Before, I>
  : never;

/**
 * A `set_var` of an `obj()` ({@link ObjShape}) resolved against the statements
 * BEFORE it — what its members can read — so it types as the same object
 * written straight into `response` would.
 */
type BoundShape<Shape, Before, I> = Shape extends ObjShape<infer Members>
  ? ResolveObj<Members, Before, I>
  : Shape extends ArrayMapShape<infer Src, infer T>
    ? MapElement<T, ElementOf<ResolveValue<Src, Before, I>>, Before, I>[]
    : Shape extends AuthShape<infer Path>
      ? AuthAt<I, Path>
      : Shape;

/** The element type of a list shape; `unknown` for anything else. */
type ElementOf<L> = L extends readonly (infer E)[] ? E : unknown;

/**
 * One `s.array.map` transform resolved per item `E`: `ref("$this")` is the
 * item, `ref("$this.path")` a path into it, `ref("$index")` its position, and
 * any other value resolves against the stack before the map. A record or
 * `obj()` transform resolves member by member.
 */
type MapElement<T, E, S, I> = T extends RefValue<"$this">
  ? E
  : T extends RefValue<`$this.${infer P}`>
    ? IndexShape<E, P>
    : T extends RefValue<"$index">
      ? number
      : T extends FilteredValue<infer Base, infer Chain>
        ? ApplyFilters<MapElement<Base, E, S, I>, Chain>
        : T extends ObjValue<infer Members>
          ? Prettify<{ -readonly [K in keyof Members]: Members[K] extends Value ? MapElement<Members[K], E, S, I> : ResolveMember<Members[K], S, I> }>
          : T extends Value
            ? ResolveValue<T, S, I>
            : Prettify<{ -readonly [K in keyof T]: MapElement<T[K], E, S, I> }>;

/**
 * A list binding widened by what the stack after it appends
 * ({@link AppendBrand}): `set_var("acc", c.array([]))` then
 * `array.push({ name: "acc", value })` traces to `Value[]`, not the empty tuple
 * it was bound as. An empty list nothing visibly appends to is `unknown[]` —
 * an accumulator, not a list that stays empty.
 */
type Accumulate<Shape, Added> = [Added] extends [never]
  ? Shape extends readonly []
    ? unknown[]
    : Shape
  : Shape extends readonly (infer E)[]
    ? (E | Added)[]
    : Shape;

/**
 * The element types `S` appends to `Name` before re-binding it, looking inside
 * loop and branch bodies ({@link MaybeBodyBrand}) too — an accumulator is
 * nearly always filled in a loop. A value reading `Name` itself is not traced.
 */
type Appended<Name extends string, S, Full> = S extends readonly [infer Head, ...infer Tail]
  ? Head extends AsShapeBrand<Name, unknown>
    ? never
    :
        | (Head extends AppendBrand<Name, infer V, infer Spread> ? AppendedValue<Name, V, Spread, Full> : never)
        | (Head extends MaybeBodyBrand<infer B> ? Appended<Name, B, Full> : never)
        | (Head extends BodyBrand<infer B> ? Appended<Name, B, Full> : never)
        | (Head extends CatchBrand<infer T, infer C> ? Appended<Name, T, Full> | Appended<Name, C, Full> : never)
        | Appended<Name, Tail, Full>
  : never;

type AppendedValue<Name extends string, V, Spread, Full> = V extends RefValue<Name | `${Name}.${string}`>
  ? unknown
  : ResolveValue<V, Full> extends infer T
    ? Spread extends true
      ? T extends readonly (infer E)[]
        ? E
        : unknown
      : T
    : never;

/**
 * Drop `| null` from a traced binding when a statement AFTER it proves the
 * binding non-null ({@link FoundBrand} — `guard.found`, `guard.owner`), and
 * nothing re-binds the name after that. A re-binding on either side of the
 * proof keeps the `| null`: before it, the proof covers a later value than the
 * one traced; after it, the response returns a value the proof never saw. A
 * check placed before the binding is never reached by this scan, and a
 * hand-written `s.precondition` carries no brand, so neither narrows.
 */
type NarrowFound<Shape, Name extends string, S> = S extends readonly [infer Head, ...infer Tail]
  ? Head extends FoundBrand<infer F>
    ? [F] extends [Name]
      ? RebindsLater<Name, Tail> extends true
        ? Shape
        : Exclude<Shape, null>
      : NarrowFound<Shape, Name, Tail>
    : Head extends AsShapeBrand<Name, unknown>
      ? Shape
      : NarrowFound<Shape, Name, Tail>
  : Shape;

/** Does any statement in `S` bind `Name` again — directly, or in every branch of a branch statement? */
type RebindsLater<Name extends string, S> = S extends readonly [infer Head, ...infer Tail]
  ? Head extends AsShapeBrand<Name, unknown>
    ? true
    : Head extends BranchesBrand<infer Branches>
      ? AllRebind<Name, Branches> extends true
        ? true
        : RebindsLater<Name, Tail>
      : RebindsLater<Name, Tail>
  : false;

/**
 * Walk a dotted subpath `Path` into an already-traced binding `Shape`, one
 * segment at a time: `IndexShape<AgentRunResult<string>, "result">` → `string`.
 *
 * **Null-propagating**: when the base is nullable (e.g. a `db.get` row,
 * `Row | null`), the null flows *through* the projection rather than erasing it —
 * `IndexShape<Row | null, "slug">` → `string | null`, mirroring the engine's
 * runtime where `$row.slug` on a missed (null) row is itself null. Without this,
 * `keyof (Row | null)` narrows to `never` and every dotted ref into a nullable
 * base would bottom out at `unknown`, silently dropping the projection.
 *
 * A segment that genuinely isn't a key of the (non-null) shape — including a
 * shape that is already `unknown` (whose `keyof` is `never`) — still bottoms out
 * at `unknown`, the same honest floor as an untraceable whole ref.
 */
type IndexShape<Shape, Path extends string> = unknown extends Shape
  ? IndexStep<Shape, Path>
  : null extends Shape
    ? IndexShape<Exclude<Shape, null>, Path> | null
    : undefined extends Shape
      ? IndexShape<Exclude<Shape, undefined>, Path> | undefined
      : IndexStep<Shape, Path>;

/**
 * One non-null indexing step for {@link IndexShape}: split the head segment off
 * `Path` and project it into `Shape`, recursing (back through the null-aware
 * {@link IndexShape}) for the tail. A segment that isn't a key bottoms out at
 * `unknown`. Kept separate so the `unknown extends Shape` guard in `IndexShape`
 * (true for exactly `unknown`/`any` — the bases where null-distribution can't
 * terminate) routes straight here without looping.
 */
type IndexStep<Shape, Path extends string> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof Shape
    ? IndexShape<Shape[Head], Rest>
    : unknown
  : Path extends keyof Shape
    ? Shape[Path]
    : unknown;

/**
 * Resolve a `ref` name against the branded stack `S`. A **dotted** name projects
 * a subpath: the head names the bound variable (traced via
 * {@link TraceBinding}) and the tail indexes into that variable's shape (via
 * {@link IndexShape}), so `ref("generated.result")` types to the completion, not
 * `unknown`. A bare name traces the whole binding. Stack-variable names are
 * identifiers (no dots), so the first `.` always splits the variable from the
 * subpath — matching how the engine resolves `$generated.result`.
 */
type TraceVar<Name extends string, S, I = unknown> = Name extends `${infer Base}.${infer Path}`
  ? IndexShape<Traced<Base, S, I>, Path>
  : Traced<Name, S, I>;

/**
 * A variable's traced binding with the dotted `s.update_var`s after its last
 * top-level binding applied in order ({@link ApplyUpdates}): an unconditional
 * one replaces the member, one in a branch, loop, `try` or `catch` widens it.
 */
type Traced<Name extends string, S, I> = [MemberUpdates<Name, Inline<S>>] extends [never]
  ? TraceBinding<Name, Inline<S>, Inline<S>, I>
  : ApplyUpdates<Name, AfterLastBind<Name, Inline<S>>, TraceBinding<Name, Inline<S>, Inline<S>, I>, I>;

/** Whether `S` holds a dotted `s.update_var` of `Name`, sub-stacks included. */
type MemberUpdates<Name extends string, S> = S extends readonly [infer Head, ...infer Tail]
  ?
      | (Head extends MemberUpdateBrand<infer N, string, unknown> ? ([N, Name] extends [Name, N] ? true : never) : never)
      | (Head extends MaybeBodyBrand<infer B> ? MemberUpdates<Name, Inline<B>> : never)
      | (Head extends CatchBrand<readonly unknown[], infer C> ? MemberUpdates<Name, Inline<C>> : never)
      | MemberUpdates<Name, Tail>
  : never;

/** `S` past the last statement that re-binds `Name` whole at the top level. */
type AfterLastBind<Name extends string, S, Rest = S> = S extends readonly [infer Head, ...infer Tail]
  ? Head extends AsShapeBrand<infer As, unknown>
    ? [As, Name] extends [Name, As]
      ? AfterLastBind<Name, Tail, Tail>
      : AfterLastBind<Name, Tail, Rest>
    : Head extends BranchesBrand<infer Branches>
      ? AllRebind<Name, Branches> extends true
        ? AfterLastBind<Name, Tail, Tail>
        : AfterLastBind<Name, Tail, Rest>
      : AfterLastBind<Name, Tail, Rest>
  : Rest;

/**
 * Fold the dotted `s.update_var`s of `Name` in `S` over `State`, in order. A
 * top-level one replaces the member; inside a `try` (between its markers) it
 * may not run, so it widens. A branch statement folds each branch from the
 * same state and joins them — every branch writing the member replaces it, a
 * branch that leaves it alone keeps the old type in the join. A loop body or a
 * `catch` may not run, so it joins with the state before it.
 */
type ApplyUpdates<Name extends string, S, State, I, InTry extends readonly unknown[] = []> = S extends readonly [
  infer Head,
  ...infer Tail,
]
  ? Head extends TryStart
    ? ApplyUpdates<Name, Tail, State, I, [...InTry, Head]>
    : Head extends TryEnd
      ? ApplyUpdates<Name, Tail, State, I, InTry extends readonly [unknown, ...infer Open] ? Open : []>
      : ApplyUpdates<Name, Tail, UpdateStep<Name, Head, State, I, InTry extends readonly [] ? false : true>, I, InTry>
  : State;

type UpdateStep<Name extends string, Head, State, I, Maybe extends boolean> = Head extends MemberUpdateBrand<infer N, infer P, infer V>
  ? [N, Name] extends [Name, N]
    ? Maybe extends true
      ? JoinStates<State | SetMember<State, P, BoundShape<V, [], I>>>
      : SetMember<State, P, BoundShape<V, [], I>>
    : State
  : Head extends AsShapeBrand<infer As, infer Shape>
    ? [As, Name] extends [Name, As]
      ? BoundShape<Shape, [], I>
      : State
    : Head extends BranchesBrand<infer Branches>
      ? [MemberUpdates<Name, Inline<Branches[number]>>] extends [never]
        ? State
        : JoinStates<BranchStates<Name, Branches, State, I>>
      : Head extends MaybeBodyBrand<infer B>
        ? [MemberUpdates<Name, Inline<B>>] extends [never]
          ? State
          : JoinStates<State | ApplyUpdates<Name, Inline<B>, State, I>>
        : Head extends CatchBrand<readonly unknown[], infer C>
          ? [MemberUpdates<Name, Inline<C>>] extends [never]
            ? State
            : JoinStates<State | ApplyUpdates<Name, Inline<C>, State, I>>
          : State;

/** The state each branch leaves `Name` in, folded from the same `State`. */
type BranchStates<Name extends string, Branches, State, I> = Branches extends readonly [infer B, ...infer Rest]
  ? ApplyUpdates<Name, Inline<B>, State, I> | BranchStates<Name, Rest, State, I>
  : never;

/**
 * `Shape` with member `Path` set to `V`. A member the shape lacks is added —
 * a missing middle key as a new object holding the rest of the path. A
 * null base stays null, and a base the walk cannot index into (a list, a
 * scalar, `unknown`) is `unknown` — never the pre-update type.
 */
type SetMember<Shape, Path extends string, V> = unknown extends Shape
  ? unknown
  : Shape extends null | undefined
    ? Shape
    : Shape extends readonly unknown[]
      ? unknown
      : Shape extends object
        ? Path extends `${infer Head}.${infer Rest}`
          ? Prettify<Omit<Shape, Head> & { [K in Head]: SetMember<Head extends keyof Shape ? Shape[Head] : Record<never, never>, Rest, V> }>
          : Prettify<Omit<Shape, Path> & { [K in Path]: V }>
        : unknown;

/**
 * The union of the states a join reaches, its object members merged into one
 * object whose members are the union of theirs — `{ a: string } | { a: number }`
 * reads `{ a: string | number }`. A member only some states have is optional.
 */
type JoinStates<T> = unknown extends T
  ? unknown
  : [Extract<T, object>] extends [never]
    ? T
    : [Extract<T, readonly unknown[]>] extends [never]
      ? Exclude<T, object> | MergeObjects<Extract<T, object>>
      : T;

type MergeObjects<O> = Prettify<
  { [K in Extract<keyof O, PropertyKey>]: ValueAt<O, K> } & { [K in Exclude<AllKeys<O>, keyof O>]?: ValueAt<O, K> }
>;
type AllKeys<O> = O extends unknown ? keyof O : never;
type ValueAt<O, K extends PropertyKey> = O extends unknown ? (K extends keyof O ? O[K] : never) : never;

/**
 * `S` with every always-run sub-stack ({@link BodyBrand} — `db.transaction`,
 * `group`, `try_catch`'s `finally`) spliced in after its statement, so a
 * binding made inside one traces like a top-level one. A `try_catch`'s `try`
 * is spliced in too, between {@link TryStart}/{@link TryEnd} markers, since it
 * may stop part way. A branch or loop body stays where it is and is read
 * through its brand.
 */
type Inline<S> = S extends readonly [infer Head, ...infer Tail]
  ? [
      Head,
      ...(Head extends CatchBrand<infer T, readonly unknown[]> ? [TryStart, ...Inline<T>, TryEnd] : []),
      ...(Head extends BodyBrand<infer B> ? Inline<B> : []),
      ...Inline<Tail>,
    ]
  : S;

/**
 * Resolve one response {@link Value} to its type against the branded stack `S`.
 *
 * A FILTERED value resolves its base and then folds the chain over it
 * ({@link ApplyFilters}), so `withFilters(ref("rows"), fl.count())` is `number`
 * rather than `unknown`: the catalog declares a result for most filters, and
 * those declarations are live-verified. The remaining filters (`get`, `set`,
 * `json_decode`, …) still land on `unknown` through the fold itself.
 *
 * Otherwise a branded `ref` traces to the statement that produced it
 * ({@link TraceVar}); anything else (a non-ref value, an untraceable ref) is
 * `unknown` — the honest floor.
 *
 * A CONSTANT types by its `c.*` constructor, widened to its primitive the way
 * an `s.set_var` of it is ({@link WidenConst}): `response: { deleted:
 * c.bool(true) }` derives `{ deleted: boolean }`.
 */
type ResolveValue<V, S, I = unknown> = V extends ObjValue<infer Members>
  ? ResolveObj<Members, S, I>
  : V extends FilteredValue<infer Base, infer Chain>
    ? ApplyFilters<ResolveValue<Base, S, I>, Chain>
    : V extends RefValue<infer Name>
      ? TraceVar<Name, S, I>
      : V extends InpValue<infer Name>
        ? InputAt<I, Name>
        : V extends AuthValue<infer Path>
          ? AuthAt<I, Path>
          : V extends CaughtValue<infer Path>
            ? CaughtShape<Path>
            : V extends ConstValue<infer T>
              ? WidenConst<T>
              : unknown;

/**
 * `auth("id")` on a def whose `auth` names ONE table (`I` is the def): that
 * table's `id` type. The identity carries the row's id, not its columns, so
 * every other path — and a def with no table known statically — is `unknown`.
 */
type AuthAt<I, Path extends string> = Path extends "id"
  ? I extends { auth?: infer A }
    ? [Exclude<A, undefined>] extends [TableDef<string, infer Row>]
      ? IndexShape<Row, "id">
      : unknown
    : unknown
  : unknown;

/**
 * An `inp(name)` read, typed from the def's declared `input` (`I`, the def
 * itself): `inp("")` is the whole payload, a dotted name projects into an
 * object input. An optional input the request left out reads as `null`; a
 * path param (a query's `{param}`, a message's channel `{param}`) never does.
 */
type InputAt<I, Name extends string> = unknown extends InputsOf<I>
  ? unknown
  : Name extends ""
    ? InferInput<I>
    : InputHead<Name> extends ChannelParams<I>
      ? InputHead<Name> extends keyof InferInput<ChannelOf<I>>
        ? Exclude<IndexShape<Required<InferInput<ChannelOf<I>>>, Name>, null>
        : string
      : IndexShape<Required<InferInput<I>>, Name> extends infer T
        ? InputHead<Name> extends QueryPathParams<I>
          ? Exclude<T, null>
          : InputHead<Name> extends RequiredKeys<InferInput<I>> ? T : T | null
        : never;

type InputHead<Name extends string> = Name extends `${infer Head}.${string}` ? Head : Name;

/** A query's `{param}` names — a path param is always present, whatever its `required`. */
type QueryPathParams<I> = I extends { verb: string; name: infer N extends string } ? PathParams<N> : never;

/** A realtime message's owning channel, whose path params reach its stack as inputs. */
type ChannelOf<I> = I extends { channel: infer C extends object } ? C : never;
type ChannelParams<I> = ChannelOf<I> extends { name: infer N extends string } ? PathParams<N> : never;

/** The keys of `T` that are not optional. */
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];

/**
 * Resolve every member of an {@link ObjValue}'s record — the same
 * walk {@link DeriveResponse} runs over a top-level object literal, one level
 * down. `obj()` is the SDK's answer for a nested response object, and it must
 * not cost the caller its types: the members are ordinary {@link Value}s with
 * ordinary bindings, so they trace.
 *
 * The widened-stack report ({@link ReportWidened}) is applied per MEMBER rather
 * than to the record as a whole, so a collapsed tuple still names itself at the
 * leaf that failed — `{ user: { id: StackTupleWidened } }` — instead of
 * flattening back into a silent `unknown`.
 *
 * A dynamically-built `ObjInput` (no literal to read) maps its index signature
 * and lands on `{ [key: string]: unknown }` — the honest floor, same as any other
 * value the walk cannot see through.
 */
type ResolveObj<Members, S, I = unknown> = Prettify<{
  -readonly [K in keyof Members]: ReportWidened<ResolveMember<Members[K], S, I>, S>;
}>;

/**
 * Resolve one {@link ObjMember} — the member grammar `obj()` accepts, which is
 * wider than {@link Value}.
 *
 * The branch order is load-bearing:
 *   - a {@link Value} (including a nested `obj()`, a filtered value, or a `ref`)
 *     goes to {@link ResolveValue}, so a `c.*` constant types like a set_var of it;
 *   - a RAW SCALAR literal types itself — `obj({ count: 3 })` really is a number,
 *     and unlike `c.int(3)` the type is right there to read. Each scalar is
 *     widened to its primitive here — `obj()`'s member check keeps the literal
 *     (`3`, `"hi"`, `true`) on `T` — so scalars read uniformly; `responseShape`
 *     states a literal deliberately;
 *   - an ARRAY resolves element-wise (checked before the record branch, since an
 *     array is also an object);
 *   - a nested plain RECORD recurses. This is the spelling `response: { user: {
 *     id: ref(...) } }` uses — the auto-wrap, which `encodeResponse` hands
 *     to `obj()` anyway, so the two spellings must and now do infer alike.
 */
type ResolveMember<M, S, I = unknown> = M extends Value
  ? ResolveValue<M, S, I>
  : M extends boolean
    ? boolean
    : M extends string
      ? string
      : M extends number
        ? number
        : M extends readonly (infer Element)[]
          ? ResolveMember<Element, S, I>[]
          : M extends object
            ? ResolveObj<M, S, I>
            : unknown;

/**
 * Best-effort automatic derivation of a response shape from the def's `response`
 * field and branded `stack`. Mirrors the Xano engine's static walk:
 *   - a record response (object literal) → an object with **those keys** (each
 *     member resolved individually, recursing into a nested `obj()` or plain
 *     object literal); keys are known regardless of traceability;
 *   - a single {@link Value} response → resolve it against the stack;
 *   - no response / an unresolvable shape → `unknown`.
 * Kept separate from {@link DeclaredResponse} so the user override always wins.
 */
export type DeriveResponse<Q> = Q extends { response?: infer Resp; stack?: infer S }
  ? [Resp] extends [undefined]
    ? unknown
    : Resp extends Value
      ? ReportWidened<ResolveValue<Resp, S, Q>, S>
      : Resp extends Record<string, unknown>
        ? Prettify<{ -readonly [K in keyof Resp]: ReportWidened<ResolveMember<Resp[K], S, Q>, S> }>
        : unknown
  : unknown;

/** The def itself when it declares a literal `input` map — what {@link InputAt} checks for — else `unknown`. */
type InputsOf<Q> = [ChannelParams<Q>] extends [never]
  ? Q extends { input?: infer M } ? ([NonNullable<M>] extends [never] ? unknown : string extends keyof NonNullable<M> ? unknown : Q) : unknown
  : Q;

/**
 * Recover a query/function's response type. A declared `responseShape` wins;
 * otherwise fall back to automatic derivation (which itself bottoms out at
 * `unknown` for anything the static walk can't resolve).
 */
export type InferResponse<Q> = [DeclaredResponse<Q>] extends [never]
  ? DeriveResponse<Q>
  : DeclaredResponse<Q>;
