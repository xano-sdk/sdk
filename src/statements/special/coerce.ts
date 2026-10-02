/**
 * Shared coercion plumbing for the hand-authored statement wrappers — the units
 * that turn an ergonomic, literal-friendly authored field into the `Value` the
 * generated factory encodes, so the wrapper delegates for byte-parity.
 *
 * Two families live here. The HTTP-request fields (`api.request`,
 * `stream.from_request`, `webflow.request`, `microservice.request`) were hoisted
 * per the rule of three once the second wrapper landed. The DB row CELL joined
 * them: it is a self-contained coercion unit that landed in `db.ts`
 * only because that is where its caller is, and its siblings — `coerceScalar`,
 * `coerceObj`, `coerceHeaders` — were already here.
 */
import type { Value } from "../../values/value.js";
import { c, filter, withFilters, isTaggedValue, objTaggedList, toPlainValue } from "../../values/value.js";
import { SCALAR_FAMILY, type ColumnDef } from "../../kinds/table.js";
import { isListColumn } from "../../fields/field.js";
import type { ObjectRef } from "../../refs/guid.js";
import { describeEntry } from "../args.js";

/**
 * The HTTP verbs the engine's runtime input schema accepts. Enforced: the
 * wrapper coerces to a `Value` and delegates to the generated factory, whose
 * spec carries the same set and rejects a constant outside it.
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "HEAD" | "OPTIONS" | "PATCH";

/**
 * A tagged {@link Value} — the dynamic-binding escape hatch for any typed field.
 * Accepts a *callable* Value too: a trigger field accessor (`t.new`) is a
 * function carrying the `{value,tag,filters}` props, so `typeof` is "function".
 */
export function isValue(w: unknown): w is Value {
  return (
    (typeof w === "object" || typeof w === "function") &&
    w !== null &&
    !Array.isArray(w) &&
    "tag" in w &&
    "value" in w
  );
}

/**
 * Flatten a {@link Value} to a plain `{value,tag,filters}` object. A trigger
 * field accessor (`t.new`) is a *callable* Value — a function object — and the
 * workspace encoder (`phpJsonEncode`) serializes a function to `null`, silently
 * dropping the field. Passing the accessor through a coercer normalizes it to a
 * plain object so it survives export. A plain Value is returned
 * unchanged (byte-identical shape).
 */
const plain = (v: Value): Value => toPlainValue(v);

// Overloaded so a REQUIRED field's coercion stays non-optional: a class-required
// input (see CLASS_REQUIRED in schema-dsl/overrides.ts) has no undefined arm to
// widen into, and threading `| undefined` through it would force a cast at every
// such call site.
export function coerceText(v: string | Value, where?: string): Value;
export function coerceText(v: string | Value | undefined, where?: string): Value | undefined;
export function coerceText(v: string | Value | undefined, where = "argument"): Value | undefined {
  // `null` (through `any`) is absent, not the text "null": the factory the value
  // is handed to then names the required argument it leaves unset.
  if (v === undefined || v === null) return undefined;
  if (isValue(v)) return plain(v);
  if (typeof v !== "string") throw new Error(`${where} must be a string or a tagged value — got ${describeEntry(v)}.`);
  return c.text(v);
}
/**
 * The literal-or-Value coercions, each refusing a wrong-typed literal with the
 * field named (`where`) — `timeout: {}` reached `c.int` and printed
 * `got [object Object]. Use c.decimal([object Object])`, naming no statement.
 */
export const coerceInt = (v: number | Value | undefined, where = "argument"): Value | undefined => {
  if (v === undefined || v === null) return undefined;
  if (isValue(v)) return plain(v);
  if (typeof v !== "number") throw new Error(`${where} must be an integer or a tagged value — got ${describeEntry(v)}.`);
  try {
    return c.int(v);
  } catch (err) {
    throw new Error(`${where}: ${(err as Error).message}`);
  }
};
/** The request timeout's bounds, in seconds — what the statement's input accepts. */
const TIMEOUT_MIN = 1;
const TIMEOUT_MAX = 86400;

/** {@link coerceInt}, refusing a literal outside 1–86400 seconds (`n` or `c.int(n)`). */
export const coerceTimeout = (v: number | Value | undefined, where: string): Value | undefined => {
  const out = coerceInt(v, where);
  const p = out === undefined ? undefined : (plain(out) as { tag?: unknown; value?: unknown; filters?: unknown[] });
  if (p?.tag !== "const:int" || (p.filters?.length ?? 0) > 0) return out;
  const n = Number(p.value);
  if (n < TIMEOUT_MIN || n > TIMEOUT_MAX) {
    throw new Error(`${where} is ${n} seconds — it must be ${TIMEOUT_MIN}–${TIMEOUT_MAX}; the statement fails its input check on every call otherwise.`);
  }
  return out;
};
export const coerceBool = (v: boolean | Value | undefined, where = "argument"): Value | undefined => {
  if (v === undefined || v === null) return undefined;
  if (isValue(v)) return plain(v);
  if (typeof v !== "boolean") throw new Error(`${where} must be true, false, or a tagged value — got ${describeEntry(v)}.`);
  return c.bool(v);
};
/**
 * Coerce an object field (`params`, …) to its `Value` form.
 *
 * - `undefined` → dropped downstream.
 * - a tagged {@link Value} → passed through (the dynamic escape hatch), flattened
 *   to a plain object if it is a callable accessor like `t.new`.
 * - an array → a `c.obj` constant, as before (a pure-JSON array stays the JSON
 *   string `[…]`; an array holding a tagged value still throws). An
 *   object-of-values is a record, never a list.
 * - a plain **pure-JSON** record → a `c.obj` constant (`tag:"const:obj"`), which
 *   is itself an empty `{}` carrying one `set` filter per key.
 * - a plain record that **contains tagged values** at the top level → a real
 *   object-of-values: the same `c.obj` base over the literal-valued keys, then one
 *   more `set` filter per Value-valued key. This makes `params: { count: ref("count") }`
 *   *just work*, mirroring the record-of-values `response: { key: value }` accepts
 *   — instead of routing into `c.obj`, which refuses to embed a
 *   tagged value.
 *
 * Only **top-level** Value keys are lifted. A value nested *inside* a sub-object
 * or array lands in the `c.obj` literal subset and still trips that guard — a loud
 * failure, not a silent drop (the documented flat-only boundary).
 */
export const coerceObj = (v: object | Value | undefined, where = 'argument "params"'): Value | undefined => {
  // `null` (through `any`) is the absent field it means, as for the scalars.
  if (v === undefined || v === null) return undefined;
  // A string reached `Object.entries` below and became a character-indexed
  // record (`{ "0": "a", … }`) with a numeric-keys warning that named nothing
  // the author wrote.
  if (typeof v !== "object" && typeof v !== "function") {
    throw new Error(`${where} must be a record ({ … }) or a tagged value (\`c.*\`, \`ref()\`, …) — got ${describeEntry(v)}.`);
  }
  // Strict tagged-value check (a real `Tag` + `filters[]`), NOT the loose local
  // `isValue`: a params record like `{ tag: "sale", value: "50" }` structurally
  // matches the loose shape and would be passed through as a bogus node. The
  // strict check — the same one `c.obj`'s nested-value guard rejects on — only
  // matches an actual Value, so such a record correctly falls through to the
  // record path.
  if (isTaggedValue(v)) return plain(v);
  // Arrays: a pure array serializes as an array constant, and an array holding
  // a Value throws the nested-value error. They never become an
  // object-of-values (that shape is a record, not a list).
  if (Array.isArray(v)) return objTaggedList(v);
  // Null-prototype: a key spelled `__proto__` (a column, a stored JSON member) is
  // stored here, where assigning it on a plain `{}` sets a prototype instead.
  const literals = Object.create(null) as Record<string, unknown>;
  const valueEntries: [string, Value][] = [];
  for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
    if (isTaggedValue(val)) valueEntries.push([key, val]);
    else literals[key] = val;
  }
  // `c.obj` still enforces the nested-value rule on the literal subset — a
  // value nested inside a sub-object stays here and throws (the flat-only
  // boundary). With no top-level Value keys the result IS `c.obj(v)`, lifted
  // keys only append to its chain.
  const base = c.obj(literals);
  if (valueEntries.length === 0) return base;
  return withFilters(
    base,
    ...valueEntries.map(([key, val]) => {
      // The engine `set` filter reads `.`/`[` in the path as a nested-path DSL
      // (`"a.b"` → `{a:{b:…}}`), so a dotted key carrying a Value would encode
      // differently than the same key with a literal value (which `c.obj` keeps
      // flat, via the bracket-escaped path form). Fail loud on that ambiguity
      // rather than silently diverging; `c.obj`'s escape could be reused here to
      // lift the restriction, which is a change to make deliberately, not as a
      // side effect of something else.
      if (/[.[]/.test(key))
        throw new Error(
          `coerceObj: object key ${JSON.stringify(key)} carries a tagged value but contains "." or "[", ` +
            `which the engine's set filter reads as a nested path ("a.b" → {a:{b:…}}) — the same key with a ` +
            `plain value would stay flat. Use a nested object, or a key without "." / "[".`,
        );
      return filter("set", c.text(key), val);
    }),
  );
};
export const coerceArray = (v: readonly string[] | Value | undefined): Value | undefined =>
  v === undefined ? undefined : isValue(v) ? plain(v) : c.array(v as string[]);

/** A headers map: full header lines built from `Name: value` pairs. */
export type HeaderMap = Readonly<Record<string, string | Value>>;

/**
 * The characters a header name may hold — RFC 7230's token set. Checked because
 * the record form is the surface that invites a COMPUTED value into a header,
 * and a `:` or a newline in a name is header splicing rather than a style slip.
 */
export const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * The text a header slot will carry when it is known at build time: a plain
 * string, or a text constant (`c.text("…")`) with no filters. `undefined` for
 * anything the engine computes at request time.
 */
export function literalText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (!isValue(v)) return undefined;
  const p = plain(v as Value) as { tag?: unknown; value?: unknown; filters?: unknown[] };
  return (p.tag === "const" || p.tag === "const:text") && typeof p.value === "string" && (p.filters?.length ?? 0) === 0
    ? p.value
    : undefined;
}

/** CR, LF or NUL — what splices a second header line (or truncates one). */
export const HEADER_BREAK = /[\r\n\0]/;

/**
 * Coerce the `headers` field to its `Value` form.
 *
 * A header line is `"Name: value"`, so a header carrying a computed value — an
 * API key from `env()`, a token from a `ref()` — is a computed STRING inside an
 * ARRAY, and the literal branch takes plain strings only. Reaching it meant
 * building the whole array as one `Value` through a four-call filter chain,
 * while the same credential in the URL was a one-liner: the comfortable spelling
 * was the one that publishes the secret on `request.url`.
 *
 * The record form mirrors `params` and makes the two the same length. Literal
 * pairs join into the base `c.array`; a tagged pair appends an `array_push` of
 * the name concatenated with the value — the chain an author writing this by
 * hand would produce. Literal pairs therefore lead the emitted array and computed
 * ones follow, so the WIRE order is not the record's key order. Header semantics
 * do not depend on order between distinct names, and a repeated name is the
 * author's to avoid: HTTP field names are case-insensitive while JS object keys
 * are not, so `Authorization` and `authorization` are two keys here and one
 * header on the wire.
 *
 * The `string[]` and whole-`Value` branches encode byte-identically to before.
 *
 * **What the splice check does and does not cover.** A LITERAL — a plain string
 * in the record or in the `string[]` — is checked here and refused. A TAGGED
 * value cannot be: its content is produced by the engine at request time, so a
 * `ref()` or `inp()` carrying CRLF splices a second header into the outbound
 * request and nothing in this build can see it. Treat a header value bound to
 * caller-controlled input as unsanitized and strip it in the stack before it
 * reaches this slot.
 */
const assertNoSplice = (line: string, what: string): string => {
  if (!HEADER_BREAK.test(line)) return line;
  throw new Error(
    `headers: ${what} contains a newline or NUL, which would splice a second header into the request. ` +
      "Strip it, or send the content as the request body.",
  );
};

/**
 * One literal header line from the `string[]` form: a string, holding a `:`
 * after a non-empty name. A line with no colon names no header — the engine
 * sends it as-is and the server drops or rejects it — so it is refused here.
 */
function headerLine(line: unknown, i: number, where: string): string {
  if (typeof line !== "string") {
    throw new Error(`${where}[${i}] must be a "Name: value" string — got ${describeEntry(line)}.`);
  }
  if (line.indexOf(":") <= 0) {
    throw new Error(
      `${where}[${i}] ${JSON.stringify(line)} is not a header line — it needs "Name: value", with a colon after the name.`,
    );
  }
  assertNoSplice(line, `line ${i}`);
  const name = line.slice(0, line.indexOf(":"));
  if (!HEADER_NAME.test(name)) {
    throw new Error(
      `${where}[${i}]: ${JSON.stringify(name)} is not a valid header name. Use the token charset ` +
        "(letters, digits and !#$%&'*+-.^_`|~), with the colon straight after the name.",
    );
  }
  return line;
}

export const coerceHeaders = (
  v: readonly string[] | HeaderMap | Value | undefined,
  where = 'argument "headers"',
): Value | undefined => {
  // `null` (through `any`) is the absent field it means.
  if (v === undefined || v === null) return undefined;
  // The STRICT check, matching `coerceObj` one screen above: the loose `isValue`
  // only looks for `tag` and `value` keys, so a header record that happens to
  // name two headers `tag` and `value` would be read as a tagged node and
  // returned as a malformed one.
  if (isTaggedValue(v)) return plain(v as Value);
  if (typeof v !== "object") {
    throw new Error(
      `${where} must be a { "Name": value } record, an array of "Name: value" lines, or a tagged value — got ${describeEntry(v)}.`,
    );
  }
  if (Array.isArray(v)) return c.array((v as unknown[]).map((line, i) => headerLine(line, i, where)));
  const entries = Object.entries(v as HeaderMap);
  const lines: string[] = [];
  const computed: Array<[string, Value]> = [];
  for (const [name, val] of entries) {
    if (!HEADER_NAME.test(name)) {
      throw new Error(
        `headers: ${JSON.stringify(name)} is not a valid header name. A header line is "Name: value", so a ` +
          'name carrying ":" , a space or a newline would splice a second header into the request. Use the ' +
          "token charset (letters, digits and !#$%&'*+-.^_`|~).",
      );
    }
    if (isValue(val)) {
      const literal = literalText(val);
      if (literal !== undefined) assertNoSplice(literal, `the value of ${JSON.stringify(name)}`);
      computed.push([name, plain(val)]);
      continue;
    }
    if (val === null || val === undefined) {
      throw new Error(`${where}: the value of ${JSON.stringify(name)} is ${val === null ? "null" : "undefined"} — give it a string or a tagged value, or leave the header out.`);
    }
    lines.push(`${name}: ${assertNoSplice(val, `the value of ${JSON.stringify(name)}`)}`);
  }
  const base = c.array(lines);
  if (computed.length === 0) return base;
  return withFilters(
    base,
    ...computed.map(([name, val]) =>
      filter("array_push", withFilters(c.text(`${name}: `), filter("concat", val))),
    ),
  );
};

/**
 * A value acceptable in a call/agent `input` map — a raw scalar literal, a nested
 * object/array, or a tagged {@link Value}. Widening the maps to this lets
 * `input: { max_age_days: 3 }` compile without wrapping every literal in `c.int`.
 */
export type InputValue = string | number | boolean | object | Value;

/**
 * Coerce one {@link InputValue} to a {@link Value} for a call/agent input map.
 * - a tagged {@link Value} → passed through (flattened if a callable accessor).
 * - `number` → `c.int` when integral, else `c.decimal` (the unambiguous split;
 *   ambiguous nested cases fail loud inside {@link coerceObj}).
 * - `string` → `c.text`; `boolean` → `c.bool`.
 * - an object/array → {@link coerceObj} (record-of-values or JSON constant).
 */
export const coerceScalar = (v: InputValue): Value => {
  // `null` is a literal an input can carry — `input: { parent: null }` sends
  // null — so it encodes as the null constant rather than reaching
  // `Object.entries(null)` below.
  if (v === null) return c.null() as Value;
  if (isValue(v)) return plain(v);
  if (typeof v === "number") return (Number.isInteger(v) ? c.int(v) : c.decimal(v)) as Value;
  if (typeof v === "string") return c.text(v);
  if (typeof v === "boolean") return c.bool(v);
  return coerceObj(v) as Value;
};

/** The shared TLS/HTTP fields carried by `api.request` / `stream.from_request` / `webflow.request`. */
export interface HttpRequestFields {
  method?: HttpMethod | (string & {}) | Value;
  params?: object | Value;
  headers?: readonly string[] | HeaderMap | Value;
  timeout?: number | Value;
  follow_location?: boolean | Value;
  verify_host?: boolean | Value;
  verify_peer?: boolean | Value;
  ca_certificate?: string | Value;
  certificate?: string | Value;
  certificate_pass?: string | Value;
  private_key?: string | Value;
  private_key_pass?: string | Value;
}

/** Coerce the shared HTTP fields to their `Value` forms (undefined fields dropped downstream). */
export function coerceHttpFields(a: HttpRequestFields, statement = "s.api.request"): Record<string, Value | undefined> {
  const at = (field: string): string => `Statement "${statement}": argument "${field}"`;
  return {
    method: coerceText(a.method, at("method")),
    params: coerceObj(a.params, at("params")),
    headers: coerceHeaders(a.headers, at("headers")),
    timeout: coerceTimeout(a.timeout, at("timeout")),
    follow_location: coerceBool(a.follow_location, at("follow_location")),
    verify_host: coerceBool(a.verify_host, at("verify_host")),
    verify_peer: coerceBool(a.verify_peer, at("verify_peer")),
    ca_certificate: coerceText(a.ca_certificate, at("ca_certificate")),
    certificate: coerceText(a.certificate, at("certificate")),
    certificate_pass: coerceText(a.certificate_pass, at("certificate_pass")),
    private_key: coerceText(a.private_key, at("private_key")),
    private_key_pass: coerceText(a.private_key_pass, at("private_key_pass")),
  };
}

/** A field's statically-known emptiness: `"unknown"` for a dynamic `Value` we can't resolve. */
function textState(v: string | Value | undefined): "empty" | "nonempty" | "unknown" {
  if (v === undefined) return "empty"; // absent → engine's empty default
  if (typeof v === "string") return v === "" ? "empty" : "nonempty";
  if (isValue(v) && v.tag === "const") return v.value === "" ? "empty" : "nonempty";
  return "unknown"; // inp/ref/filtered — indeterminate at build time
}

function boolState(v: boolean | Value | undefined, engineDefault: boolean): "true" | "false" | "unknown" {
  if (v === undefined) return engineDefault ? "true" : "false";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (isValue(v) && v.tag === "const:bool") return v.value === "true" ? "true" : "false";
  return "unknown";
}

/**
 * Enforce the engine's TLS/mTLS field interdependencies (as enforced by the
 * Xano engine's API-request handler) at build time — but ONLY when the combination is *statically
 * provable* invalid. A dynamic `Value` in any relevant field yields `"unknown"`
 * and is skipped, so this never rejects a workspace the engine would accept: it
 * is a strict superset of the engine's runtime checks, surfacing the same errors
 * earlier. The frontend does not block on these; the engine throws at runtime.
 */
export function assertSslConsistency(label: string, a: HttpRequestFields): void {
  const cert = textState(a.certificate);
  const key = textState(a.private_key);
  if (cert === "nonempty" && key === "empty")
    throw new Error(`${label}: \`certificate\` requires \`private_key\` — a client certificate needs its matching key.`);
  if (key === "nonempty" && cert === "empty")
    throw new Error(`${label}: \`private_key\` requires \`certificate\` — a client key needs its matching certificate.`);

  const ca = textState(a.ca_certificate);
  const verifyPeer = boolState(a.verify_peer, true);
  if (ca === "nonempty" && verifyPeer === "false")
    throw new Error(`${label}: \`ca_certificate\` requires \`verify_peer: true\` — the engine only consults a CA cert when peer verification is on.`);
}

/**
 * The bare JS literals a row cell accepts for a column whose row type is `V`,
 * mirroring the `Scalar` union `fl.*` arguments and `seed` rows already take.
 *
 * Keyed on the column's own inferred type, so the widening is STRICTER than the
 * tagged spelling it replaces: `{ is_hidden: "yes" }` on an `f.bool()` column is
 * a compile error here, where `{ is_hidden: c.text("yes") }` was always accepted.
 * An `f.enum` column keeps its literal union, so a non-member is refused too.
 *
 * `null` is admitted on EVERY column, including the ones that refuse every other
 * literal — an `obj`/`json`/list/`geo`/`vector` column has no bare-literal form
 * and throws for a string, number or boolean, but takes `null`. That asymmetry
 * is the decision, not an oversight: nulling a cell is a legitimate
 * write whatever the column reads back as, and it matches what a seed row does
 * with a `null` (see `coerceScalarValue` — nullability is the engine's to
 * enforce, and a column config this layer does not fully model is not something
 * to guess at). Two consequences worth knowing, both stated on the grounding
 * surface: on a column with no literal form, `null` is the ONLY literal the cell
 * type offers; and an explicit `null` is not the same as omitting the key, which
 * takes the type default in {@link defaultCell} instead.
 *
 * A column whose inferred value is `unknown` — a raw `ColumnDef[]` schema, or an
 * `f.json()` column, which reads back as `unknown` by construction — has nothing
 * to key on, so it falls back to the whole scalar union and leans on the
 * encoder's own check. The escape hatch is not made stricter than it was.
 */
export type ScalarCell<V> = [unknown] extends [V]
  ? string | number | boolean | null
  : (V extends string | number | boolean ? V : never) | null;

/**
 * How a bare literal is checked and tagged for each kind of scalar column. One
 * entry per kind rather than three parallel switches, so a column type added to
 * the map below is a single edit.
 *
 * `enum` is the one kind that admits two literal types: the engine stores string
 * and numeric options alike, so its tag follows the literal's own runtime type.
 */
const CELL_KINDS = {
  bool: { wants: "a boolean", takes: (x: unknown) => typeof x === "boolean", tag: (x: unknown) => c.bool(x as boolean) },
  int: { wants: "a number", takes: (x: unknown) => typeof x === "number", tag: (x: unknown) => c.int(x as number) },
  decimal: { wants: "a number", takes: (x: unknown) => typeof x === "number", tag: (x: unknown) => c.decimal(x as number) },
  text: { wants: "a string", takes: (x: unknown) => typeof x === "string", tag: (x: unknown) => c.text(x as string) },
  enum: {
    wants: "a string or a number",
    takes: (x: unknown) => typeof x === "string" || typeof x === "number",
    tag: (x: unknown) => (typeof x === "number" ? c.int(x) : c.text(x as string)),
  },
} as const;

/**
 * Which kind each declared column type takes its literal as, over the shared
 * {@link SCALAR_FAMILY} grouping rather than a second copy of it. A
 * type with no family — obj, json, a file resource, a geography, a vector — has
 * no bare-literal form and is rejected rather than guessed at.
 *
 * Two entries are this surface's own policy, not the family's:
 * - `epochms` takes its cell as an INT, so a `Date` (which a seed row accepts) is
 *   refused here — a cell encodes to a constant, and the constant is the number.
 * - `date` has no family (a seed ships it as authored) and takes its cell as
 *   text here, which is what it encodes to.
 *
 * `password` follows the family to text and the value is written through
 * UNCHANGED, which is correct: the column hashes on write, so the plaintext is
 * the value to pass and a cell hashed here or by a filter chain would be hashed
 * twice and never match `security.check_password`. Nothing is warned
 * about, because the short spelling is the right one.
 */
const CELL_KIND: Readonly<Record<string, keyof typeof CELL_KINDS>> = {
  ...(Object.fromEntries(
    Object.entries(SCALAR_FAMILY).map(([type, family]) => [type, family === "epochms" ? "int" : family]),
  ) as Record<string, keyof typeof CELL_KINDS>),
  date: "text",
};

/**
 * Coerce a bare JS literal in a row cell to the constant an author would have
 * written by hand, keyed on the COLUMN's declared type rather than the literal's
 * runtime type.
 *
 * Keying on the column is what makes the widening stricter rather than looser:
 * `10` on an `f.decimal()` column takes `const:decimal`, matching `c.decimal(10)`
 * and not the `const:int` a runtime-type split would pick, and a literal whose
 * type contradicts the column is refused here instead of being cast to text and
 * handed to the engine. The contradiction case is the one a raw-`ColumnDef[]`
 * table cannot catch at compile time, so this check carries it.
 */
export function coerceCell(table: ObjectRef, col: ColumnDef, cell: string | number | boolean | null): Value {
  // Ahead of the column-kind gate deliberately — see {@link ScalarCell} for why
  // `null` is accepted where every other literal is refused.
  if (cell === null) return c.null();
  const where = `db row: column "${col.name}" of table "${typeof table === "string" ? table : table.name}"`;
  const isList = isListColumn(col);
  const kind = isList ? undefined : (Object.hasOwn(CELL_KIND, col.type) ? CELL_KIND[col.type] : undefined);
  if (kind === undefined) {
    throw new Error(
      `${where} is declared "${col.type}"${isList ? " (a list)" : ""}, which has no bare-literal form. ` +
        `Author it as a tagged value (\`c.obj({…})\`, \`c.array([…])\`, \`c.text(…)\`) or pass the entry ` +
        "through `data:` instead.",
    );
  }
  const spec = CELL_KINDS[kind];
  if (!spec.takes(cell)) {
    throw new Error(
      // `describeEntry`, never `JSON.stringify`: a bigint cell (through `any`)
      // threw from inside this message and lost it.
      `${where} is declared "${col.type}", so its cell must be ${spec.wants} — got ${describeEntry(cell)}. ` +
        `Fix the literal, or write the value you meant explicitly as a tagged ` +
        "value if the column's declared type is wrong.",
    );
  }
  if (kind === "int" && !Number.isInteger(cell)) {
    throw new Error(
      `${where} is declared "${col.type}", so its cell must be a whole number — got ${String(cell)}. ` +
        "Round it, or change the column to `f.decimal()`.",
    );
  }
  return spec.tag(cell);
}
