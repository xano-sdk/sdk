/**
 * Response → `result[]` mapping, shared by every response-bearing kind
 * (function, query, tool, middleware, and the response-bearing triggers).
 * Extracted from the MVP's compile.ts so kinds beyond function can reuse it.
 */
import type { ResultItemXdo } from "../types/xdo.js";
import type { Value } from "../values/value.js";
import { obj } from "../values/obj.js";
import type { Statement } from "../statements/statement.js";
import { rawResponseItems } from "./raw-response.js";
import { emitDiagnostic } from "../workspace/diagnostics.js";
import { describeEntry } from "../statements/args.js";

/**
 * A member of a record response — a {@link Value}, or a nested plain object
 * literal which is auto-wrapped via {@link obj} (so `response: { user: { id:
 * ref(x) } }` just works instead of failing tsc against `TaggedValue`).
 * A nested record refuses at the type level the values `obj()` refuses
 * (`caught()`, `toolset()`, `resp()`, `out()`); a top-level key carries them.
 */
export type ResponseMember = Value | ResponseRecord;

/** A nested response record: an `ObjInput` whose members are never `NotObjMember`s. */
export interface ResponseRecord {
  [key: string]: ResponseRecordMember;
}
type ResponseRecordMember =
  // The phantom's type IS the message: a `caught()`/`toolset()`/`resp()`/`out()`
  // value's tag fails against it, and the compiler quotes it (as `obj()` does).
  | (Value & { readonly __notObjMember?: NestedRecordRefusal })
  | string
  | number
  | boolean
  | ResponseRecord
  | ResponseRecordMember[];

/** What a nested response record says to a value it cannot carry. */
type NestedRecordRefusal = "a nested response record cannot carry this value — bind it with s.set_var first and ref() the variable, or move it to a top-level response key";

/** A single `Value` response, or a record of named result items. */
export type ResponseDef = Value | Record<string, ResponseMember>;

/**
 * Warn when a response-bearing def (query/function) has a top-level
 * `s.return(...)` (`mvp:return`) in its stack but declares no `response`.
 *
 * What this used to say — that the def "returns nothing" — is not what a live
 * engine does, and the correction matters more than the warning did. Probed
 * against a real ephemeral environment, over public HTTP for the query:
 *
 *   - a query whose whole stack is `s.return(c.text("done"))`, with no
 *     `response`, answers `200 "done"`. The runtime `return` short-circuits the
 *     stack and carries its own value out, regardless of the empty stored
 *     `result` envelope.
 *   - with BOTH, whichever executes decides: an early `s.return` that fires wins
 *     over the declared `response`; if it does not fire, `response` applies.
 *
 * So the real cost is not an empty response — it is an UNTYPED one. `result`
 * still encodes as `[]`, which is the only thing `InferResponse` can read, so a
 * typed consumer of that endpoint sees nothing while the endpoint returns
 * something. The declared `response` is what makes the shape knowable to the
 * SDK, to a typed frontend, and to codegen.
 *
 * Only *top-level* `mvp:return`s are flagged: a `return` nested inside a
 * `conditional`/`foreach`/`group` is a legitimate early return and never gates
 * the declared response, so scanning the top of the stack avoids false alarms.
 */
export function warnUnboundReturn(
  kind: "query" | "function",
  name: string,
  stack: readonly Statement[] | undefined,
  response: ResponseDef | undefined,
): void {
  if (response !== undefined) return;
  if (!Array.isArray(stack) || !stack.some((statement) => statement?.name === "mvp:return")) return;
  emitDiagnostic({
    severity: "warning",
    code: "response.unbound-return",
    message:
      `${kind} "${name}" ends with s.return(...) but has no \`response\` field. The value DOES ` +
      `come back at runtime — a top-level s.return short-circuits the stack and carries its own ` +
      `value out — but the stored response envelope is empty, so the shape is invisible to ` +
      `InferResponse, to a typed frontend, and to codegen. Declare it too: \`response: <value>\` ` +
      `(e.g. \`response: ref("...")\`). Where both exist, whichever executes wins — an early ` +
      `s.return that fires beats the declared response.`,
  });
}

function isValue(x: ResponseDef | ResponseMember): x is Value {
  return (
    x !== undefined &&
    x !== null &&
    typeof (x as Value).tag === "string" &&
    "value" in (x as object) &&
    "filters" in (x as object)
  );
}

/** Map a response into `result[]`: one unnamed item for a single value, or
 * one named item per key for a record. A record member that is a nested plain
 * object is auto-wrapped via {@link obj} (a dynamic `const:expr2` value). */
export function encodeResponse(response: ResponseDef | undefined): ResultItemXdo[] {
  if (response === undefined || response === null) {
    return [];
  }
  // Through `any`, a bare `5` or `true` read as a record with no members and
  // stored an EMPTY response — the endpoint answered nothing, silently.
  if (typeof response !== "object" && typeof response !== "function") {
    throw new Error(
      `response must be a value (\`ref("x")\`, \`c.int(5)\`, …) or a { key: value } record — got ${describeEntry(response)}.`,
    );
  }
  // Checked before `isValue`: a raw marker carries no `tag`, so it would
  // otherwise fall through to the record branch and be encoded as named members.
  const carried = rawResponseItems(response);
  if (carried !== undefined) return carried;
  if (isValue(response)) {
    return [
      { filters: response.filters, name: "", tag: response.tag, value: response.value, _xsid: "", disabled: false },
    ];
  }
  return Object.entries(response).map(([name, member]) => {
    // Usually a typo'd or unset variable (`cfg.missing`): there is no value to
    // return under this key, and leaving it out would hide that.
    if (member === undefined) {
      throw new Error(
        `\`response.${name}\` is undefined — a response key takes a value (\`ref("x")\`, \`c.*\`) or a ` +
          `{ key: value } record. Check the expression that produced it, or drop the key.`,
      );
    }
    const value = isValue(member) ? member : obj(member);
    return { filters: value.filters, name, tag: value.tag, value: value.value, _xsid: "", disabled: false };
  });
}
