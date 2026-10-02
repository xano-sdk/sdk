/**
 * Middleware **attachment** (U-mw) — the pre/post hooks a host primitive runs
 * around its own stack. Distinct from the middleware *object* (`middleware.ts`,
 * the reusable logic unit) and from the inline `middleware.call` statement
 * (`mvp:workspace_run_middleware`, a stack call).
 *
 * An attachment entry is an ordinary stack item whose statement is
 * **`mvp:middleware`** with `context.middleware.id` = the target middleware's
 * guid (the engine remaps guid→local id on import). Verified against the live
 * xdo corpus: each `middleware.pre[]` entry carries the full 12-key
 * `StackItemXdo` envelope — the engine types `pre[]`/`post[]` the same as the
 * main `run[]` stack. So entries flow through `encodeStatement` — never a
 * hand-built minimal literal.
 *
 * Inheritance is the engine's job, not
 * ours: Xano SDK only emits each tier's list plus the `pre_customize`/
 * `post_customize` override flags. Presence-driven: providing a phase's list
 * sets that phase's `_customize` flag (override); omitting it leaves the flag
 * `false` (inherit from the parent tier). An explicit empty list (`pre: []`, or
 * `middleware.clear()`) is "override with nothing — stop inheriting".
 */
import type { StackItemXdo } from "../types/xdo.js";
import { encodeStatement, registerStatement, RAW_ENVELOPE } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { resolveRef } from "../refs/guid.js";
import type { ObjectRef } from "../refs/guid.js";
import { isTaggedValue } from "../values/value.js";
import { emptyMiddleware } from "./common.js";
import type { MiddlewareBlock } from "./common.js";

/**
 * A single pre/post attachment. Either a bare middleware reference (a
 * `middleware()` def handle or its name) or a `{ middleware, active }` object
 * when the entry needs to be authored-but-disabled (`active: false` ⇒ stored
 * `disabled: true`, so the engine skips it while keeping it in the list).
 */
export type MiddlewareAttachEntry =
  | ObjectRef
  | { middleware: ObjectRef; active?: boolean }
  // A `raw()` passthrough, for an attachment the authoring forms above cannot
  // spell. The case that motivates it is a BLANK binding — a middleware slot
  // never bound, or whose target was deleted — which a real workspace carries as
  // `context.middleware.id: ""`. Neither an `ObjectRef` nor the `{middleware,
  // active}` wrapper can express "bound to nothing", so a pulled workspace
  // holding one emitted `{name: "", guid: ""}`, which the exporter then refused.
  // The bytes are the bytes: carried verbatim, it re-exports as it
  // was pulled and the defect stays visible instead of becoming unrepresentable.
  | Statement;

/**
 * The attachment authoring shape shared by every host primitive
 * (query/function/task/tool/api-group). Each phase is an ordered list resolved
 * **independently**: a host can override `pre` while inheriting `post`.
 */
export interface MiddlewareAttach {
  pre?: MiddlewareAttachEntry[];
  post?: MiddlewareAttachEntry[];
}

/**
 * Whether an entry is a `raw()` passthrough rather than a reference.
 *
 * Keyed on the envelope MARKER, not on shape. A raw statement and an `ObjectRef`
 * def handle both carry a `name`, so anything structural would misread one for
 * the other; the marker is present only on a `raw()` result.
 */
function isRawEntry(entry: MiddlewareAttachEntry): entry is Statement {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as Partial<Record<typeof RAW_ENVELOPE, unknown>>)[RAW_ENVELOPE] !== undefined
  );
}

/** Normalize an entry to its `{ ref, active }` parts. */
function parseEntry(entry: Exclude<MiddlewareAttachEntry, Statement>): { ref: ObjectRef; active?: boolean } {
  // The `{ middleware, active }` wrapper is the only non-ObjectRef form; a string
  // or a `{ name, guid? }` def handle is already an ObjectRef.
  if (typeof entry === "object" && "middleware" in entry) {
    return { ref: entry.middleware, active: entry.active };
  }
  return { ref: entry };
}

/**
 * The `mvp:middleware` attachment statement factory (pre-encode `Statement`).
 * Registered so `encodeStatement` accepts it. `context.middleware.id` resolves
 * to the target's guid via the shared reference resolver, so a rename
 * round-trips through the identity/lock layer.
 */
function middlewareAttachStatement(args: { middleware: ObjectRef; active?: boolean }): Statement {
  return {
    name: "mvp:middleware",
    context: { middleware: { id: resolveRef("middleware", args.middleware) } },
    ...(args.active === false ? { disabled: true } : {}),
  };
}
registerStatement("mvp:middleware", middlewareAttachStatement);

/** Encode one attachment entry into the full stored `StackItemXdo` envelope. */
export function encodeMiddlewareEntry(entry: MiddlewareAttachEntry): StackItemXdo {
  // A raw envelope is already persisted; `encodeStatement` returns it untouched.
  if (isRawEntry(entry)) return encodeStatement(entry);
  const { ref, active } = parseEntry(entry);
  return encodeStatement(middlewareAttachStatement({ middleware: ref, active }));
}

/**
 * Read the target middleware guid off an **encoded** attachment entry — the
 * `{ context: { middleware: { id } } }` shape {@link middlewareAttachStatement}
 * writes. Returns `undefined` for a malformed or foreign entry. Co-located with
 * the writer so the two stay in lockstep (used by the export-time auth guard).
 */
export function middlewareEntryGuid(entry: unknown): string | undefined {
  const id = (entry as { context?: { middleware?: { id?: unknown } } })?.context?.middleware?.id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Build the object-level {@link MiddlewareBlock} from an authoring
 * {@link MiddlewareAttach}. Omitted → the empty block (both `_customize:false`,
 * both lists `[]`) byte-identical to {@link emptyMiddleware}, so a host with no
 * middleware emits exactly as before. A phase present (even an empty array)
 * sets that phase's `_customize` flag.
 */
export function buildMiddlewareBlock(attach?: MiddlewareAttach): MiddlewareBlock {
  if (!attach) return emptyMiddleware();
  return {
    pre_customize: attach.pre !== undefined,
    post_customize: attach.post !== undefined,
    pre: encodeMiddlewareList(attach.pre),
    post: encodeMiddlewareList(attach.post),
  };
}

/**
 * Encode a bare list of attachment entries into stored stack items. Used by the
 * workspace tier, whose `{objType}_{phase}` map holds the same entries but with
 * no per-phase `_customize` flag (workspace is the terminal fallback).
 */
export function encodeMiddlewareList(entries?: MiddlewareAttachEntry[]): StackItemXdo[] {
  return (entries ?? []).map(encodeMiddlewareEntry);
}

/**
 * An explicit empty override — the readable spelling of `[]`. `pre: clear()`
 * means "customize this phase, run no middleware" (stop inheriting the parent
 * tier's chain), as opposed to omitting the phase (inherit).
 */
export function clear(): MiddlewareAttachEntry[] {
  return [];
}

/**
 * Does any statement in this middleware stack reference `auth()` (a tagged
 * {@link Value} with `tag === "auth"`)?
 *
 * Detection for the export-time guard (see `Xano.validateMiddlewareAuth`):
 * `auth("id")` is the idiomatic per-user rate-limit key, and when the middleware
 * lands on a host that can't resolve a request identity the key cannot be built —
 * the request fails with a 403 before the host runs, rather than degrading to one
 * shared bucket. This walk finds the reference so export can warn before that
 * ships.
 *
 * Accepts either the pre-encode authored `Statement[]` or the encoded `run[]`
 * (`StackItemXdo[]`) — the tag survives encoding, so the same deep walk finds it
 * in both. The export registry keeps only the encoded middleware, so the guard
 * passes the `run`; unit tests pass authored stacks. Hence `readonly unknown[]`.
 *
 * The walk is a generic deep traversal: it descends every object/array member —
 * statement `context`, `input` bindings, `output`, **and each value's
 * `filters[].arg[]`** — testing each node for an `auth`-tagged value. The
 * filter-arg descent is load-bearing: the canonical key
 * `withFilters(c.text("p:"), fl.concat(auth("id")))` hides the `auth()` as a
 * filter argument, not a top-level value.
 *
 * Boundary: it does **not** follow references into a *nested* function's own
 * stack (`s.function.run`), so an `auth()` buried inside a called function is a
 * known false negative — which degrades safely to today's no-guard behavior.
 */
export function stackReferencesAuth(stack?: readonly unknown[]): boolean {
  return (stack ?? []).some(nodeReferencesAuth);
}

/** Deep-walk any authored node for an `auth`-tagged value. */
function nodeReferencesAuth(node: unknown): boolean {
  // A tagged value can be a *callable* (the `t.new` trigger accessor form, which
  // `isTaggedValue` accepts), so admit functions as well as objects;
  // rejecting them here would skip a callable's own `filters[].arg[]`.
  if (node === null || (typeof node !== "object" && typeof node !== "function")) return false;
  // A tagged value (including the function-carrying form) is checked first;
  // `auth()` is exactly `{ tag: "auth", ... }`. Non-auth tagged values fall
  // through to the recursion so their `filters[].arg[]` are still walked.
  if (isTaggedValue(node) && node.tag === "auth") return true;
  if (Array.isArray(node)) return node.some(nodeReferencesAuth);
  return Object.values(node as Record<string, unknown>).some(nodeReferencesAuth);
}
