/**
 * `inp("<implied>")` → the typed trigger handle `t`.
 *
 * A trigger has no user-supplied inputs: its input array is fixed by `obj_type`
 * and re-injected by the encoder. The factories therefore hand the stack a typed
 * handle rather than making authors guess input names — `tableTrigger` types
 * `t.new`/`t.old` against the bound table's row.
 *
 * A decoded stack arrives referencing those inputs as raw strings, because that
 * is what the engine stores. Emitting them verbatim inside a factory call would
 * type-check but throw away exactly the checking the factory exists to provide.
 * This transform is the inverse: it is why a pulled trigger catches a renamed
 * column instead of silently referencing one that no longer exists.
 *
 * The handle member is a {@link FieldAccessor} — callable, not a property bag.
 * `t.new` is the whole-input `Value` and `t.new("id")` is `inp("new.id")`, so the
 * rewrite targets an `inp` CALL and produces either a bare identifier or another
 * call. See `src/kinds/trigger-handle.ts`.
 *
 * Only names in `impliedInputs(objType)` are rewritten. Since a trigger has no
 * other inputs there is nothing else `inp()` can legitimately name, but scoping
 * to the implied set keeps that provable rather than merely true today — and it
 * makes the transform safe to run over a stack whose statements the decoder fell
 * back to `raw()` for.
 */
import type { Expr } from "../print.js";
import { arr, call, id, lit, obj, spread } from "../print.js";
import { impliedInputs } from "../../kinds/trigger-inputs.js";
import type { ToolsetType, TriggerInputObjType } from "../../kinds/trigger-inputs.js";

/** Implied input names per `obj_type` (and toolset type), derived once from the injected array. */
const MEMBERS = new Map<string, ReadonlySet<string>>();

function membersOf(objType: TriggerInputObjType, toolsetType?: ToolsetType): ReadonlySet<string> {
  const key = `${objType}:${toolsetType ?? "mcp"}`;
  let names = MEMBERS.get(key);
  if (!names) {
    names = new Set(impliedInputs(objType, toolsetType).map((i) => i.name));
    MEMBERS.set(key, names);
  }
  return names;
}

/**
 * Rewrite every implied-input reference in `node` to handle access.
 *
 * Structure-preserving: a subtree containing no rewritable reference is returned
 * as-is, so this can run over a whole stack without disturbing statements that
 * reference nothing.
 */
export function rewriteTriggerInputRefs(node: Expr, objType: TriggerInputObjType, toolsetType?: ToolsetType): Expr {
  // An agent's handle has no `prompts`/`resources`, so those stay `inp()` there.
  const members = membersOf(objType, toolsetType);

  function walk(current: Expr): Expr {
    switch (current.kind) {
      case "call": {
        const rewritten = handleRef(current, members);
        if (rewritten) return rewritten;
        return call(current.callee, ...current.args.map(walk));
      }
      case "array":
        return arr(current.items.map(walk));
      case "object":
        return obj(current.entries.map(([k, v]) => [k, walk(v)] as const));
      case "spread":
        return spread(
          walk(current.base),
          current.entries.map(([k, v]) => [k, walk(v)] as const),
        );
      case "arrow":
        return { kind: "arrow", params: current.params, body: walk(current.body) };
      // `id` is already-formed source and `literal` is plain data — neither can
      // contain a node to rewrite. A literal whose TEXT happens to spell `inp(…)`
      // is a string, not a reference, and is deliberately left alone.
      case "id":
      case "literal":
        return current;
    }
  }

  return walk(node);
}

/** `inp("new.id")` → `t.new("id")`, or `null` when this call is not one. */
function handleRef(node: Expr & { kind: "call" }, members: ReadonlySet<string>): Expr | null {
  if (node.callee !== "inp" || node.args.length !== 1) return null;
  const arg = node.args[0]!;
  if (arg.kind !== "literal" || typeof arg.value !== "string") return null;

  // Split on the FIRST dot only: the accessor's path parameter takes the whole
  // remainder (`${K}.${string}`), and `newest` must not match `new`.
  const dot = arg.value.indexOf(".");
  const base = dot === -1 ? arg.value : arg.value.slice(0, dot);
  if (!members.has(base)) return null;

  return dot === -1 ? id(`t.${base}`) : call(`t.${base}`, lit(arg.value.slice(dot + 1)));
}
