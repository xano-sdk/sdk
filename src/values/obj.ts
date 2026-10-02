/**
 * `obj({...})` — a **dynamic** object value: an object literal whose members can
 * be live references (`inp`/`ref`/`auth`/`col`) or constants. This is the
 * missing sibling of `c.obj`: `c.obj` takes plain JSON only and
 * rejects nested tagged values, so it can't express `{ id: inp("id") }`.
 *
 * Xano stores a dynamic object as a single value with `tag: "const:expr2"` whose
 * `value` is the object rendered as a **XanoScript expression string** (verified
 * against the Xano engine's stored inline-value format). So `obj`
 * serializes each member to its XanoScript form (`$input.x`, `$var.x`, `$auth`,
 * `$db.col`, quoted strings, numbers) and wraps them in `{ … }`.
 *
 * Why `const:expr2` and not a structured `const:obj`: the Xano runtime value
 * evaluator resolves `const:obj` by JSON-decoding its value — it
 * treats the value as a *static JSON string*, so dynamic members (`$input.x`)
 * would never resolve. Only `const:expr2` is run through the expression parser
 * (it normalizes to `const:expr` and evaluates), so it is the sole
 * representation that resolves live references inside an object literal. That
 * choice is therefore runtime-verified, not a preference.
 *
 * The rendered string form (spacing/escaping) is golden-verified: a
 * `call_agent` object-args capture pins the exact `const:expr` string this
 * encoder emits for `obj({ question: inp(...) })`.
 *
 * **Supported members:** `inp()`, `ref()`, `auth()`, `col()`, `env()` /
 * `setting()` / `sys.*`, `c.now()`, `c.text/int/decimal/bool/null`,
 * `c.obj(…)` / `c.array([…])`, nested records or `obj()` calls, and arrays of those —
 * each optionally carrying a **filter chain**, which renders as the expression
 * language's own postfix pipe (`$var.row|get:"address.city"`).
 *
 * A constant record or list has two spellings that mean the same thing here: a
 * bare `{…}` / `[…]` and `c.obj` / `c.array`. They render to identical bytes,
 * so the empty list works either way.
 *
 * A member may carry a filter chain. That matters constantly, because `db.get`
 * binds `null` on a miss — the SDK's own headline gotcha — so almost every
 * object built from a `db.get` result needs a null-safe drill, which compiles
 * through the `get` filter. Without it, each member costs a pure-plumbing
 * `s.set_var` statement.
 *
 * The engine stores `{ …, goals: [$q.goal_1, …]|filter:$$ != null, … }` as ONE
 * `const:expr2` string, so a per-member chain is exactly what it carries.
 *
 * **On evidence.** The value of an `expr2` is an expression string the engine
 * parses — it is NOT XanoScript, and nothing validates its contents ahead of a
 * live run. So what backs this is the engine's own parser fixtures (paired
 * source → stored JSON), which show the exact string its tooling produces. A
 * rendering outside that set is not "probably fine"; it is unverified. Keep the
 * emitted grammar to shapes a fixture demonstrates.
 *
 * What still throws: a filter argument carrying its OWN chain (a trailing `|`
 * binds to the whole value, so it cannot be written without changing meaning),
 * a **disabled** filter (an expression string has nowhere to record that), and
 * the remaining exotic tags (`output`/`response`/`toolset`/`reg`). Build those
 * in a prior stack step and reference them with `ref`.
 */
import type { NotObjMember, Value } from "./value.js";
import { isTaggedValue } from "./value.js";
import { describeEntry, protoKeyed } from "../statements/args.js";

/**
 * A member of an {@link obj} literal — a {@link Value}, a raw scalar literal
 * (`string`/`number`/`boolean`, coerced to the matching constant), a nested
 * record, or an array. Raw scalars let `obj({ max_age_days: 3 })` and
 * `obj({ greeting: "hi" })` *just work* without wrapping each in `c.int`/`c.text`.
 */
export type ObjMember = Value | string | number | boolean | ObjInput | ObjMember[];
/** The record shape {@link obj} accepts: keys → members. */
export interface ObjInput {
  [key: string]: ObjMember;
}

/**
 * A {@link Value} that also carries, **at the type level only**, the member
 * record it was built from (`obj({ id: ref("u.id") })` → `ObjValue<{ id:
 * RefValue<"u.id"> }>`). The `__obj` carrier is phantom — never present at
 * runtime — and exists so `InferResponse` can recurse into the members and
 * resolve each one the way it resolves a top-level response key.
 *
 * Before this, `obj()` returned a bare `Value`: the members were erased at the
 * signature, so the resolver saw no `__ref` to trace and every member landed on
 * the `unknown` floor. `{ user: obj({ id: ref("u.id") }) }` derived `{ user:
 * unknown }` while the identical refs written as object-literal keys derived
 * `{ id: number | null }` — and the mismatch only surfaced downstream, as
 * `unknown` flowing into a caller that had asked for a type.
 *
 * Because it is a subtype of `Value`, every existing `obj(...)` use — a request
 * body, an agent's `args`, a statement field — keeps type-checking unchanged.
 */
export type ObjValue<T extends ObjInput = ObjInput> = Value & { readonly __obj: T };

/**
 * What an `s.set_var` of an {@link obj} binds, at the type level: the member
 * record, resolved only where the variable is READ — against the stack before
 * the binding — since a member's `ref`/`inp` needs the stack and the def's
 * inputs, which the `set_var` call cannot see.
 */
export interface ObjShape<T> {
  readonly __objShape: T;
}

/**
 * `T` with every member `obj()` refuses ({@link NotObjMember} — `caught()`,
 * `toolset()`, `resp()`, `out()`) replaced by the reason, so the mistake is a
 * type error at the member instead of a throw at export.
 */
export type ObjMembersChecked<T> = {
  [K in keyof T]: T[K] extends NotObjMember<infer Tag>
    ? `obj() cannot carry a "${Tag}" value — bind it with s.set_var first and ref() the variable`
    : T[K] extends readonly (infer E)[]
      ? readonly ObjMembersChecked<{ e: E }>["e"][]
      : T[K] extends Value
        ? T[K]
        : T[K] extends object
          ? ObjMembersChecked<T[K]>
          : T[K];
};

/** Bare-identifier keys only (what XanoScript object literals accept unquoted). */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Render one {@link Value}, including its filter chain, to a XanoScript
 * expression fragment.
 *
 * The chain renders as the expression language's own postfix pipe —
 * `$var.row|get:"address.city"` — which the object-literal grammar carries per
 * member. That is settled against the engine's parser fixtures, not inferred:
 * a stored `mvp:array_push` holds
 * `{ …, goals: [$q.goal_1, …]|filter:$$ != null, … }` as ONE `const:expr2`
 * string. See the module doc for why this stopped being a rejection.
 */
function serializeValue(v: Value, path: string, followed: boolean): string {
  const record = objSetRecord(v, path, followed);
  if (record) return record;
  const nowExpr = serializeEpochMs(v);
  if (nowExpr !== null) return grouped(nowExpr + serializeFilters(v, path), v.filters, followed);
  return grouped(serializeAtom(v, path) + serializeFilters(v, path), v.filters, followed);
}

/**
 * Parenthesize a member that another member follows, when its chain ends in a
 * filter that takes arguments.
 *
 * The `,` that separates members does not close a filter's arguments: in
 * `{ a: "x"|concat:"y", b: $var.b }` the engine reads past the comma, so `a`
 * loses its final segment and `b` disappears from the result. Probed live, the
 * parenthesized spelling answers both members intact, and the engine's own
 * parser fixtures carry the grouping (`(now|to_timestamp)`). What the probes
 * also showed is left bare, so the bytes of every shape that already worked
 * stay as they were: a LAST member (the closing `}`/`]` ends the arguments),
 * and a chain whose final filter takes none (`|trim`) — nothing to read on.
 */
function grouped(rendered: string, chain: Value["filters"], followed: boolean): string {
  const tail = chain[chain.length - 1];
  return followed && tail !== undefined && tail.arg.length > 0 ? `(${rendered})` : rendered;
}

/**
 * `c.now()` rendered as the expression that actually evaluates to epoch-ms, or
 * null when `v` is not that tag.
 *
 * The identifier `now` is NOT a keyword of the expression language: the parser
 * lifts only `true`/`false`/`null` and numerics out of a bare token, so a bare
 * `now` stays the STRING "now" and gets served verbatim. The structured
 * `const:epochms` tag never had that problem because the tag itself is what
 * routes the value through the engine's epoch-ms coercion — and inside an
 * object literal there is no tag left, only text.
 *
 * `|to_epochms` restores exactly that coercion (it is the same filter the tag
 * applies), and the engine's own parser fixtures carry the spelling —
 * `(now|to_timestamp)`, `to_timestamp` being its alias. Probed live: bare `now`
 * answers `"now"`, `now|to_epochms` answers `1788225545290`.
 *
 * The coercion leads any chain the author wrote, which changes nothing for the
 * timestamp filters (they each run the same coercion on their input) and fixes
 * the rest — without it `withFilters(c.now(), fl.to_text())` would stringify
 * the identifier rather than the time.
 */
function serializeEpochMs(v: Value): string | null {
  if (v.tag !== "const:epochms") return null;
  // Only ever holds `"now"` — the same narrowing the decoder makes — so anything
  // else falls through to the rejection rather than being rendered as a `now` it
  // is not.
  if (v.value !== "now") return null;
  return "now|to_epochms";
}

/**
 * `c.obj({…})` rendered as the object literal it stands for, or null when `v`
 * is not that shape.
 *
 * A populated `c.obj` is stored as an empty `{}` base carrying one `set` filter
 * per key — the only populated form the engine reads back (see `objSetFilters`
 * in `value.ts`). That representation is a *storage* detail of a standalone
 * value; inside an object literal the whole thing is one expression string, so
 * the faithful rendering is the literal record the author wrote, which is
 * exactly what a bare nested record already renders to. Reading the payload back
 * off the `set` chain is what makes `c.obj` and a bare `{}` the same thing here.
 *
 * Only the LEADING run of plain `set` filters is payload. Anything after it is
 * an ordinary chain on the finished object and renders as the postfix pipe, so
 * `withFilters(c.obj({a: 1}), fl.get("a"))` stays writable.
 */
function objSetRecord(v: Value, path: string, followed: boolean): string | null {
  if (v.tag !== "const:obj") return null;
  // The blank form (`c.obj(null)`, stored `value: ""`) is a null, not an object.
  // It has a spelling here already, so say which one rather than rendering a
  // `{}` the engine would not have produced.
  if (v.value === "") {
    throw new Error(
      `obj(): \`${path}\` is \`c.obj(null)\`, the legacy BLANK object form — the engine ` +
        `evaluates it to null, not to {}. Write \`c.null()\` for the null, or \`c.obj()\` ` +
        `for an empty object.`,
    );
  }
  if (v.value !== "{}") {
    // A non-record routed through `c.obj` keeps its JSON string (an array, a
    // bare scalar). Render the JSON it carries.
    const parsed = parseJson(v.value);
    if (parsed === NOT_JSON) return null;
    return grouped(serializeJson(parsed, path) + serializeFilters(v, path), v.filters, followed);
  }
  const members: Array<[string, Value]> = [];
  const keys = new Set<string>();
  let i = 0;
  for (; i < v.filters.length; i++) {
    const f = v.filters[i]!;
    if (f.name !== "set" || f.disabled || f.arg.length !== 2) break;
    const [pathArg, member] = f.arg as [Value, Value];
    if (pathArg.tag !== "const" || pathArg.filters.length > 0) break;
    // A hand-written `fl.set` DRILLS — `fl.set("a.b", …)` writes one level down,
    // which is the filter's whole purpose and not a key of this record. The
    // encoder's own flat keys are distinguishable: `setPath` brackets anything
    // that is not a bare identifier, so a BARE non-identifier is a drill and
    // belongs in the chain, while a BRACKETED one is a literal key that an
    // object literal has no unquoted spelling for.
    const bracketed = pathArg.value.startsWith("[");
    const key = parseSetPath(pathArg.value);
    if (!IDENT.test(key)) {
      if (!bracketed) break;
      throw keyError(key, ` inside the \`c.obj\` at \`${path}\``);
    }
    // A `set` on a key the record already carries OVERWRITES it. Rendering both
    // would emit the key twice, so the override stays in the chain, where it
    // means what the standalone value means.
    if (keys.has(key)) break;
    keys.add(key);
    members.push([key, member]);
  }
  const parts = members.map(
    ([key, member], idx) =>
      `${key}: ${serializeValue(member, `${path}.${key}`, idx < members.length - 1)}`,
  );
  const rendered = parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
  // Whatever is left is an ordinary chain on the object.
  const rest = { ...v, filters: v.filters.slice(i) } as Value;
  return grouped(rendered + serializeFilters(rest, path), rest.filters, followed);
}

/**
 * A stored `set` path segment back to the key it stands for — the inverse of
 * the encoder's `setPath`. A bare segment IS the key; `["a.b"]` is the bracket
 * form, whose interior unescapes `\"` and `\\` in one pass.
 */
function parseSetPath(stored: string): string {
  const bracketed = /^\["(.*)"\]$/s.exec(stored);
  return bracketed ? bracketed[1]!.replace(/\\(["\\])/g, "$1") : stored;
}

/** The refusal for a key an object literal has no unquoted spelling for; `where` locates it. */
function keyError(key: string, where: string): Error {
  return new Error(
    `obj(): key "${key}"${where} must be a bare identifier ` +
      `([A-Za-z_][A-Za-z0-9_]*) — XanoScript object keys aren't quoted.`,
  );
}

/** Sentinel for "this string is not JSON" — `undefined` and `null` are both valid JSON results. */
const NOT_JSON = Symbol("not-json");

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON;
  }
}

/**
 * Plain JSON rendered to the object-literal grammar — the same fragments
 * {@link serializeMember} produces for a bare scalar, array or record, so
 * `c.array([1, 2])` and `[1, 2]` land on identical bytes.
 */
function serializeJson(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  // Matches `objMember`: a non-finite number is what `JSON.stringify` writes.
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (Array.isArray(value)) {
    return `[${value.map((el, i) => serializeJson(el, `${path}[${i}]`)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>).map(([key, member]) => {
      if (!IDENT.test(key)) {
        throw keyError(key, ` at \`${path}\``);
      }
      return `${key}: ${serializeJson(member, `${path}.${key}`)}`;
    });
    return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
  }
  // `undefined` — JSON.parse never produces one, so this is unreachable from a
  // stored value and exists so the function is total.
  return "null";
}

/**
 * The filter chain as `|name:arg:arg`, or `""` when there is none.
 *
 * Two shapes stay rejected, because neither has an expression spelling that
 * means what the author wrote:
 *
 * - **A filter arg that carries its own chain.** `|add:$var.n|mul:2` parses as
 *   two filters on the OUTER value, not one filter on a computed argument, so
 *   emitting it would silently change the result.
 * - **A disabled filter.** `disabled` is a property of the structured
 *   `filters[]` array; an expression string has nowhere to put it, so the only
 *   faithful renderings are "drop it" (changes nothing visibly, loses the
 *   author's intent to re-enable) or "keep it" (runs a filter the author
 *   switched off). Refusing is the honest third option.
 */
function serializeFilters(v: Value, path: string): string {
  let out = "";
  for (const f of v.filters) {
    if (f.disabled) {
      throw new Error(
        `obj(): the value at \`${path}\` carries a DISABLED \`${f.name}\` filter. An object ` +
          `literal is stored as one expression string, which has no spelling for a disabled ` +
          `filter — drop it, or build the value in a prior step (e.g. \`s.set_var\`) and ` +
          `reference it with \`ref\`.`,
      );
    }
    const args = f.arg.map((a, i) => {
      if (a.filters.length > 0) {
        // Named for the case that surprised: a null-safe `ref(…, { safe: true })`
        // IS such a chain (its variable piped through `get`), written by no one.
        throw new Error(
          `obj(): the \`${f.name}\` filter on member \`${path}\` has an argument (#${i}) that carries ` +
            `its own filter chain (\`ref(…, { safe: true })\` is one). In an expression a trailing \`|\` binds ` +
            `to the whole value, not to one argument, so this cannot be written without changing what it ` +
            `means. Compute the argument in a prior step (\`s.set_var\`) and reference it with \`ref\`.`,
        );
      }
      return serializeAtom(a, `${path}|${f.name}[${i}]`);
    });
    out += `|${f.name}${args.length > 0 ? `:${args.join(":")}` : ""}`;
  }
  return out;
}

/** Render one {@link Value}'s BASE (tag + value), ignoring any filter chain. */
function serializeAtom(v: Value, path: string): string {
  switch (v.tag) {
    case "const":
      return JSON.stringify(v.value); // double-quoted + escaped, valid XanoScript string
    case "const:int":
    case "const:decimal":
      return v.value; // already the numeric literal (e.g. "123", "1.5")
    case "const:bool":
      return v.value === "true" ? "true" : "false";
    case "const:null":
      return "null";
    case "input":
      return `$input.${v.value}`;
    case "var":
      return `$var.${v.value}`;
    case "auth":
      return v.value ? `$auth.${v.value}` : "$auth";
    case "col":
      return `$db.${v.value}`;
    // A workspace env var and a built-in request var are the SAME tag; the
    // built-ins just carry a `$`-prefixed name. Both spell `$env.` + the name,
    // so `sys.remoteIp()` renders `$env.$remote_ip` and `env("STRIPE_KEY")`
    // renders `$env.STRIPE_KEY`.
    case "setting":
      return `$env.${v.value}`;
    // The engine's native current-time constant reaches this function ONLY as a
    // filter argument — a member position is answered by `serializeEpochMs`
    // above. There it is unwritable: the value needs a leading `|to_epochms` to
    // evaluate as a time at all (see `serializeEpochMs`), and inside an argument
    // a trailing `|` binds to the whole value rather than to the argument, which
    // is the same wall a pre-filtered argument hits.
    case "const:epochms":
      throw new Error(
        `obj(): \`${path}\` is \`c.now()\` used as a FILTER ARGUMENT. In an expression the ` +
          `current-time constant has to carry a \`|to_epochms\` coercion, and a \`|\` inside an ` +
          `argument binds to the whole value instead — so this cannot be written without ` +
          `changing what it means. Compute it in a prior step (\`s.set_var("now", c.now())\`) and ` +
          `reference it with \`ref("now")\`.`,
      );
    // `c.array([…])` stores plain JSON, and the literal grammar spells the same
    // list — so it renders to the identical bytes a bare `[…]` member does. The
    // bare form always worked and this one used to throw, which made the empty
    // list (`c.array([])`) an export failure with no named way through.
    // A nested `obj()` (or `c.expression`) is already expression source: a
    // record literal inlines as the same bytes a bare `{…}` member renders; any
    // other expression is grouped so a following `|` or `,` cannot split it.
    case "const:expr2":
      return v.value[0] == "{" ? v.value : `(${v.value})`;
    case "const:array": {
      const parsed = parseJson(v.value);
      if (parsed !== NOT_JSON) return serializeJson(parsed, path);
      break;
    }
  }
  throw new Error(
    `obj(): \`${path}\` is a value tagged "${v.tag}", which an object literal cannot carry. ` +
      `Bind it in a prior step (\`s.set_var("x", …)\`) and use \`ref("x")\`.`,
  );
}

/** Render any {@link ObjMember} (scalar literal, value, nested record, or array). */
function serializeMember(m: ObjMember, path: string, followed = false): string {
  // Raw scalar literals coerce to the matching constant fragment — same rendering
  // as `c.text`/`c.int`/`c.decimal`/`c.bool` (see serializeValue's const cases).
  if (typeof m === "string") return JSON.stringify(m);
  if (typeof m === "number") return String(m);
  if (typeof m === "boolean") return m ? "true" : "false";
  // A bare `null` is the null literal, as `c.null()` renders — not "a Value, got object".
  if (m === null) return "null";
  if (isTaggedValue(m)) return serializeValue(m, path, followed);
  if (Array.isArray(m)) {
    return `[${m.map((el, i) => serializeMember(el, `${path}[${i}]`, i < m.length - 1)).join(", ")}]`;
  }
  // A PLAIN record only. A Date, Map, Set or class instance has no enumerable
  // own keys (or not the ones that hold its data), so it rendered as `{}` and
  // the value was lost without a word — the same deep-JSON rule `c.obj` applies.
  // Anything else falls through to the refusal below, which names it.
  const proto = typeof m === "object" ? (Object.getPrototypeOf(m) as unknown) : 0;
  if (proto === Object.prototype || proto === null) return serializeRecord(m as ObjInput, path);
  throw new Error(
    `obj(): \`${path}\` must be a Value (inp/ref/auth/col/c.*), a scalar literal ` +
      `(string/number/boolean), a nested object, or an array (got ${describeEntry(m)}).`,
  );
}

/** Render a record to a `{ k: v, … }` XanoScript object literal. */
function serializeRecord(rec: ObjInput, path: string): string {
  const entries = Object.entries(rec);
  const parts = entries.map(([key, member], idx) => {
    if (!IDENT.test(key)) {
      throw keyError(key, path ? ` at \`${path}\`` : "");
    }
    return `${key}: ${serializeMember(member, path ? `${path}.${key}` : key, idx < entries.length - 1)}`;
  });
  return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
}

/**
 * Build a dynamic object {@link Value} from a record of members. Members may be
 * references (`inp`/`ref`/`auth`/`col`), constants (`c.*`), nested records, or
 * arrays. Emits `tag:"const:expr2"` — the engine's dynamic-object representation.
 *
 * ```ts
 * obj({ id: inp("id"), name: c.text("Bob"), tags: [c.text("a"), ref("t")] })
 * // → { value: '{ id: $input.id, name: "Bob", tags: ["a", $var.t] }', tag: "const:expr2", filters: [] }
 * ```
 *
 * The member record is preserved on the return type as {@link ObjValue}, so a
 * response built with `obj()` traces through `InferResponse` exactly as the same
 * members written as object-literal keys would. A dynamically-built
 * `ObjInput` has no literal to read and degrades to unknown-valued members.
 */
export function obj<T extends ObjInput>(fields: T & NoInfer<ObjMembersChecked<T>>): ObjValue<T> {
  // Through `any`, `obj(null)` reported `Cannot convert undefined or null to
  // object`, and a list or a value was read as a record keyed "0", "1", ….
  if (typeof fields !== "object" || fields === null || Array.isArray(fields) || isTaggedValue(fields) || protoKeyed(fields)) {
    throw new Error(
      `obj() takes a { key: value } record — got ${isTaggedValue(fields) ? "a value (`c.*`/`ref()`), which needs no obj()" : describeEntry(fields)}.`,
    );
  }
  // `__obj` is a phantom (type-only) carrier — the runtime object is exactly the
  // plain `{value, tag, filters}` Value; the cast attaches the members to the type.
  return {
    value: serializeRecord(fields, ""),
    tag: "const:expr2",
    filters: [],
  } as unknown as ObjValue<T>;
}
