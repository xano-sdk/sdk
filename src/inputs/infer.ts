/**
 * `InferInput<Q>` — the request-payload TS type for a query (or function) def's
 * declared inputs, computed at compile time from the inputs' value brands. No
 * codegen, no build step: the type is derived from the def, so it can never
 * drift from what the endpoint actually accepts.
 *
 * ```ts
 * const meQuery = query({ verb: "POST", apiGroup: auth, name: "me",
 *   input: { email: input.email({ required: true }), password: input.password({ required: true }) } });
 *
 * type MePayload = InferInput<typeof meQuery>;   // { email: string; password: string }
 * fetch(BASE + meQuery.getPath(), { body: JSON.stringify(payload satisfies MePayload) });
 * ```
 *
 * Works for any def carrying an `input` map, so `defineFunction` handles infer
 * the same way (functions share the input system) even though only queries have
 * a URL path.
 */
import type { FromFieldMap } from "../fields/value-types.js";

/**
 * The `input` map of a def-like `{ input?: ... }`, or an empty map when absent.
 * The empty case must be `Record<never, never>` (keyof `never`) — NOT
 * `Record<string, never>`, whose string index signature would make
 * {@link FromFieldMap} emit an index-signature payload instead of `{}`.
 */
type InputMapOf<Q> = Q extends { input?: infer M }
  ? [M] extends [undefined]
    ? Record<never, never>
    : NonNullable<M>
  : Record<never, never>;

/**
 * Turn a query/function def's declared `input` map into its request-payload
 * type: required inputs become required keys, the rest optional; `nullable`
 * adds `| null`, `array`/`list` produce `T[]`, `enum` a literal union, and a
 * nested `object` input recurses.
 */
export type InferInput<Q> = FromFieldMap<InputMapOf<Q>>;
