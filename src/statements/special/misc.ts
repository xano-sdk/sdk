/**
 * Hand-authored miscellaneous specials — the remaining `!class` /
 * `!function` / declarative statements without a generated factory: array
 * map/union, the comment & placeholder nodes, raw-input access, post-process,
 * realtime events, auth-token creation, and the `expect.to_throw` test
 * assertion.
 *
 * `comment`, `realtime_event`, and `create_auth` have declarative transforms in
 * the engine schema and are encoded to match them; the rest are `!class` with no
 * persisted golden yet, so they are **structural** (reachable, byte-verified
 * later). Block fields map to same-named `context` entries unless the schema's
 * declarative transform says otherwise.
 *
 * array_map, array_union, get_input, and test_expect_to_throw are
 * golden-verified against live engine captures;
 * post_process is parser-verified. Remaining unverified spots:
 *   (1) array_map — the scalar `transform_value` path is byte-exact. The
 *       object-literal form (`transform_object` + `output_type:"object"`) is
 *       authorable and round-trips through codegen, but is modeled from the
 *       engine's declared context schema rather than a capture: no golden yet.
 *   (2) create_auth — input order is `id/dbtable/extras/expiration`, read from the
 *       engine's own input schema; `extras`/`expiration` are `?=` optionals and
 *       are omitted when unset. Only the `dbtable` const tag is unverified.
 *   (3) realtime_event — context.{channel,data,auth.{dbo_id,row_id}} CONFIRMED by
 *       the schema transform (auth_table via !map:dbo:constant → table guid).
 */
import type { Statement, AsShapeBrand } from "../statement.js";
import type { FilterXdo } from "../../types/xdo.js";
import type { ApplyFilters } from "../../values/filter-result.js";
import { encodeStatement, registerStatement, ANNOTATION_KEYS } from "../statement.js";
import type { Value } from "../../values/value.js";
import {
  c,
  isTaggedValue,
  barePatternRefusal,
  reversedOperandRefusal,
} from "../../values/value.js";
import { generated } from "../generated/factories.generated.js";
import { specialEnumValue, type SpecialEnum } from "./input-enums.js";
import { resolveRef } from "../../refs/guid.js";
import type { ObjectRef } from "../../refs/guid.js";
import { obj } from "../../values/obj.js";
import type { ObjInput } from "../../values/obj.js";
import { annotate } from "../statement.js";
import type { StatementAnnotations, StatementOptions } from "../statement.js";
import { argsOrEmpty, assertArg, assertStatements, assertValueArg, describeEntry, presentValueArg } from "../args.js";
import { assertKnownKeys, type AllKeys } from "../../util/known-keys.js";

function vf(v: Value): { value: string; tag: string; filters: unknown[] } {
  return { value: v.value, tag: v.tag, filters: v.filters };
}

// --- array map / union ------------------------------------------------------
// Stored shapes modeled on the engine transforms' decode() (authoritative for
// the persisted form), NOT the authoring arg names — these `!class` transforms
// rename their fields on the way to storage:
//   array_map   → { output_type:"value", collection:<source>, transform_value?:<map> }
//   array_union → { left:<source>, right?:<other>, transform_value?:<map> }

export interface ArrayMapArgs extends StatementOptions {
  /** The source array → stored `collection`. */
  source: Value;
  as?: string;
  /**
   * How each item maps. Three forms, and the form picks the engine's `output_type`:
   * - a single {@link Value} → each item maps to that scalar expression
   *   (`output_type:"value"`, stored `transform_value`);
   * - a record of values → each item maps to an OBJECT with those keys
   *   (`output_type:"object"`, stored `transform_object[]`);
   * - a list of `{key, value}` pairs → the same object form, for the keys a
   *   record cannot hold: one the engine COMPUTES per item, or two rows sharing
   *   a key (see {@link ArrayMapAttribute}).
   *
   * Use `ref("$this")` for the current item and `ref("$index")` for its position.
   * An empty record is rejected — the engine's object branch iterates
   * `transform_object` and would map every item to `{}`.
   */
  transform?: Value | Record<string, Value> | ArrayMapAttribute[];
}

/**
 * One key/value pair of an object transform, for the shapes a record cannot
 * hold.
 *
 * The engine evaluates `attribute_key` per item exactly as it evaluates the
 * value, so a key can be a variable, an input, or a filtered expression — and
 * two rows may carry the SAME key, which a record would silently collapse to
 * the last one. Reach for the record form whenever the keys are plain literals;
 * it is what an ordinary object mapping should read like.
 */
export interface ArrayMapAttribute {
  /** The key this row contributes, evaluated per item. */
  key: Value;
  /** The value stored under it. */
  value: Value;
}

/** A `transform` record (object form) rather than a single tagged value. */
function isTransformRecord(
  t: Value | Record<string, Value> | ArrayMapAttribute[],
): t is Record<string, Value> {
  return !isTaggedValue(t) && !Array.isArray(t);
}

/** Refuse a `transform` that is neither a value, a `{ key: value }` record, nor a `{ key, value }` list. */
function assertArrayMapTransform(t: unknown): void {
  const where = 'Statement "s.array.map": argument "transform"';
  if (isTaggedValue(t)) return;
  if (Array.isArray(t)) {
    t.forEach((pair, i) => {
      const ok =
        typeof pair === "object" && pair !== null && isTaggedValue((pair as ArrayMapAttribute).key) &&
        isTaggedValue((pair as ArrayMapAttribute).value);
      if (!ok) {
        throw new Error(`${where.slice(0, -1)}[${i}]" must be a { key, value } pair of tagged values — got ${describeEntry(pair)}.`);
      }
    });
    return;
  }
  if (typeof t !== "object" || t === null) {
    throw new Error(
      `${where} must be a tagged value, a { key: value } record, or a list of { key, value } pairs — got ${describeEntry(t)}.`,
    );
  }
  for (const [key, value] of Object.entries(t)) {
    if (!isTaggedValue(value)) {
      throw new Error(`${where.slice(0, -1)}.${key}" must be a tagged value (\`c.*\`, \`ref()\`, …) — got ${describeEntry(value)}.`);
    }
  }
}

const ARRAY_MAP_KEYS = /* @__PURE__ */ Object.keys({ source: 1, as: 1, transform: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<ArrayMapArgs>, 1>);

/**
 * `array.map <source>` — map each element through an expression (`mvp:array_map`).
 *
 * Both engine output modes are golden-verified against live captures. The object
 * path (`output_type:"object"` + `transform_object[]`) stores one
 * `{attribute_key, attribute_value}` entry per record key, in authored order,
 * and the key is a plain `const` text triple.
 *
 * Only the LIVE branch is emitted, and the capture confirms the engine agrees:
 * an imported object-mode statement stores NO `transform_value`, and a
 * value-mode one stores no `transform_object`. The EDITOR is the exception — it
 * builds its form from the whole context schema and saves every control, so an
 * editor-saved object-mode statement also carries `transform_value` at its
 * schema defaults. Both spellings are one state (the engine's object branch
 * never reads `transform_value`); `liveArrayMapContext` in validate/normalize.ts
 * is where that equivalence lives, so an editor-authored statement still reads
 * back to this factory instead of falling to `raw()`.
 *
 * ```ts
 * // scalar: ["a","b"] → ["A","B"]
 * s.array.map({ source: ref("names"), as: "upper", transform: withFilters(ref("$this"), fl.upper()) })
 * // object: [1,2] → [{id:1, pos:0}, {id:2, pos:1}]
 * s.array.map({ source: ref("ids"), as: "rows", transform: { id: ref("$this"), pos: ref("$index") } })
 * ```
 */
export function arrayMap<
  const As extends string = string,
  const T extends ArrayMapArgs["transform"] = undefined,
  const Fs extends readonly FilterXdo[] = readonly [],
  const Src extends Value = Value,
>(a: ArrayMapArgs & { source: Src; as?: As; transform?: T; asFilters?: Fs }): Statement & AsShapeBrand<As, ApplyFilters<MappedShape<Src, T>, Fs>> {
  a = argsOrEmpty(a);
  assertKnownKeys(`Statement "s.array.map"`, a, ARRAY_MAP_KEYS);
  assertValueArg("s.array.map", "source", a.source);
  const context: Record<string, unknown> = { output_type: "value", collection: vf(a.source) };
  // `null` is the absent transform. Anything that is not a value, a record or a
  // pair list was read as a record — `Object.entries("x")` is `[["0","x"]]` —
  // or crashed reading a pair off `null`.
  if (a.transform !== undefined && a.transform !== null) {
    assertArrayMapTransform(a.transform);
    // Both object spellings land in the same stored rows; only how the author
    // named the keys differs.
    const pairs: ArrayMapAttribute[] | undefined = isTransformRecord(a.transform)
      ? Object.entries(a.transform).map(([key, value]) => ({ key: c.text(key), value }))
      : Array.isArray(a.transform)
        ? a.transform
        : undefined;
    if (pairs) {
      if (pairs.length === 0) {
        throw new Error(
          "Statement \"s.array.map\": an object `transform` needs at least one key — the engine's object branch " +
            "iterates `transform_object` and an empty one maps every item to `{}`. Pass a record " +
            "of values (`{ id: ref('$this') }`), a list of `{ key, value }` pairs, or a single " +
            "value for the scalar form.",
        );
      }
      context.output_type = "object";
      context.transform_object = pairs.map(({ key, value }) => ({
        attribute_key: vf(key),
        attribute_value: vf(value),
      }));
    } else {
      context.transform_value = vf(a.transform as Value);
    }
  }
  return annotate({ name: "mvp:array_map", context, as: a.as ?? "", input: [] }, a) as unknown as Statement &
    AsShapeBrand<As, ApplyFilters<MappedShape<Src, T>, Fs>>;
}

/**
 * What `s.array.map` binds: a list of the transform's type, resolved where the
 * variable is read ({@link ArrayMapShape}) because the transform reads the
 * item (`ref("$this")`, `ref("$this.n")`), its position (`ref("$index")`) and
 * the stack — `string[]` for a `fl.upper()` scalar over strings, `{ id: number;
 * n: number }[]` for a record or `obj()` over numbers. A key list computes its
 * keys per item, so its elements are records of `unknown`.
 */
type MappedShape<Src, T> = T extends readonly ArrayMapAttribute[]
  ? Record<string, unknown>[]
  : T extends Value | Record<string, Value>
    ? ArrayMapShape<Src, T>
    : unknown;

/** An `s.array.map` binding: the `source` and `transform`, resolved against the stack where it is read. */
export interface ArrayMapShape<Src, T> {
  readonly __arrayMap: [Src, T];
}

export interface ArrayUnionArgs extends StatementOptions {
  /** The base array → stored `left`. */
  source: Value;
  /**
   * The array to union in → stored `right`.
   *
   * REQUIRED. It reads as optional — a union with nothing looks like a dedupe of
   * `source` — but the engine has no absent state for it: `right` declares
   * `tag?=input` with an undefaulted `value`, so an omitted block resolves as an
   * input named `""` and the request dies with
   * `500 ERROR_FATAL "Unable to locate input: "`. Measured on a live engine.
   */
  with: Value;
  as?: string;
  /** Optional per-item transform → stored `transform_value`. */
  transform?: Value;
}

const ARRAY_UNION_KEYS = /* @__PURE__ */ Object.keys({ source: 1, with: 1, as: 1, transform: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<ArrayUnionArgs>, 1>);

/**
 * `array.union <source>` — set-union of arrays (`mvp:array_union`).
 *
 * Golden-verified against a live capture: the field remap (source→left,
 * with→right, transform→transform_value) matches the engine's array-union format.
 */
export function arrayUnion(a: ArrayUnionArgs): Statement {
  a = argsOrEmpty(a);
  assertKnownKeys(`Statement "s.array.union"`, a, ARRAY_UNION_KEYS);
  assertValueArg("s.array.union", "source", a.source);
  // See `with` above — absent, the engine resolves it as an empty-named input
  // and 500s. There is no union-with-nothing.
  assertValueArg("s.array.union", "with", a.with);
  const context: Record<string, unknown> = { left: vf(a.source), right: vf(a.with) };
  if (presentValueArg("s.array.union", "transform", a.transform)) context.transform_value = vf(a.transform!);
  return annotate({ name: "mvp:array_union", context, as: a.as ?? "", input: [] }, a);
}

// --- comment / placeholder -------------------------------------------------

/**
 * `comment` — a no-op annotation node (`mvp:comment`). The text IS this
 * statement's `description`, so `text` and `a.description` set the same member
 * and an explicit `a.description` wins; `a.disabled` applies as it does anywhere.
 */
export function comment(text = "", a?: StatementAnnotations): Statement {
  // `s.comment(5)` and `s.comment(null)` emitted an empty comment in silence.
  if (typeof text !== "string") {
    throw new Error(`Statement "s.comment": argument "text" must be the comment as a string — got ${describeEntry(text)}.`);
  }
  assertKnownKeys(`Statement "s.comment": options`, a, ANNOTATION_KEYS);
  return annotate({ name: "mvp:comment", description: text, context: {}, input: [] }, a);
}

// `mvp:placeholder` deliberately has NO factory. The engine writes it into an
// export in place of a statement it could not resolve, then refuses those same
// bytes on import, so there is no destination where an authored one runs. It is
// decoded through `raw()` and blocked at `export()` — see
// {@link DECODE_ONLY_STATEMENTS}.

// --- raw input / post-process ---------------------------------------------

export interface GetRawInputArgs extends StatementOptions {
  as?: string;
  /**
   * How the body is decoded before it is bound: `"json"` (the default — a JSON
   * body binds as an object), `"yaml"`, `"x-www-form-urlencoded"`, or `"none"`
   * (the body's bytes as one string — what a signature check over the raw body
   * needs). A bare literal or `c.text(...)`; any other constant is refused.
   */
  encoding?: SpecialEnum<"mvp:get_input", "encoding"> | Value;
  /** Skip middleware-applied transforms. */
  excludeMiddleware?: Value;
}

const GET_RAW_INPUT_KEYS = /* @__PURE__ */ Object.keys({ as: 1, encoding: 1, excludeMiddleware: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<GetRawInputArgs>, 1>);

/**
 * `util.get_raw_input` / `util.get_input` — capture the raw request body
 * (`mvp:get_input`). Empty context, and up to two `input[]` entries — `encoding`
 * (`?=json`) and `exclude_middleware_modification` (note the full stored name;
 * `?=false`). Both are optional in the engine schema and are written only when
 * authored, matching what Xano's editor stores.
 */
export function getRawInput(a: GetRawInputArgs = {}): Statement {
  // `= {}` covers only `undefined`; `null` through `any` read `.as` off it.
  a = argsOrEmpty(a);
  assertKnownKeys(`Statement "s.util.get_raw_input"`, a, GET_RAW_INPUT_KEYS);
  return annotate({
    name: "mvp:get_input",
    context: {},
    as: a.as ?? "",
    // Both entries are `?=` optionals in the engine schema (`encoding?=json`,
    // `exclude_middleware_modification?=false`) and Xano's editor writes neither
    // for a plain body capture — so they are emitted only when authored.
    input: [
      ...(a.encoding !== undefined && a.encoding !== null
        ? [{ name: "encoding", ...vf(specialEnumValue(
            "mvp:get_input",
            "s.util.get_raw_input",
            "encoding",
            "encoding",
            a.encoding,
            '`"none"` binds the body\'s bytes as one string — what a signature check over the raw body needs.',
          )) }]
        : []),
      ...(presentValueArg("s.util.get_raw_input", "excludeMiddleware", a.excludeMiddleware)
        ? [{ name: "exclude_middleware_modification", ...vf(a.excludeMiddleware!) }]
        : []),
    ],
  }, a);
}

/**
 * `util.post_process { … }` — run a post-response sub-stack (`mvp:post_process`).
 * A pure block statement (engine schema `args: []`): no `as`, just the `run`
 * stack. Byte-verified (parser-minimal) against the engine's persisted shape.
 */
export function postProcess(body: Statement[], a?: StatementAnnotations): Statement {
  assertStatements("s.util.post_process", "body", body);
  assertKnownKeys(`Statement "s.util.post_process": options`, a, ANNOTATION_KEYS);
  return annotate(
    { name: "mvp:post_process", context: { run: body.map(encodeStatement) }, input: [] },
    a,
  );
}

// --- realtime event (declarative) ------------------------------------------

export interface RealtimeEventArgs extends StatementAnnotations {
  /** The channel to publish on. */
  channel: Value;
  /** The event payload. */
  data: Value;
  /** Optional auth table whose row scopes the event. */
  authTable?: ObjectRef;
  /** The auth row id. */
  authId: Value;
}

const REALTIME_EVENT_KEYS = /* @__PURE__ */ Object.keys({ channel: 1, data: 1, authTable: 1, authId: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<RealtimeEventArgs>, 1>);

/**
 * `api.realtime_event { … }` — publish a realtime event (`mvp:realtime_event`).
 *
 * @deprecated Superseded by {@link realtimePublish}. This publishes to Xano's older
 * workspace-global realtime layer, NOT to a `realtimeChannel()` — its `channel` is a
 * string against that layer, so pointing it at a current-layer channel path publishes
 * into the void.
 *
 * To originate an event on the current layer, use `s.realtime.publish`, which names the
 * owning `realtimeServer()` and so addresses a real `realtimeChannel()`.
 *
 * Still exported and still supported so `xanosdk codegen` can bring back a workspace
 * that holds one. Withheld from the `llms.txt` statement catalog and named only under
 * `llms/legacy.md`.
 */
export function realtimeEvent(a: RealtimeEventArgs): Statement {
  a = argsOrEmpty(a);
  assertKnownKeys(`Statement "s.api.realtime_event"`, a, REALTIME_EVENT_KEYS);
  assertValueArg("s.api.realtime_event", "channel", a.channel);
  assertValueArg("s.api.realtime_event", "data", a.data);
  assertValueArg("s.api.realtime_event", "authId", a.authId);
  const auth: Record<string, unknown> = { row_id: vf(a.authId) };
  if (a.authTable !== undefined && a.authTable !== null)
    auth.dbo_id = resolveRef("dbo", a.authTable, `Statement "s.api.realtime_event": argument "authTable"`);
  return annotate({
    name: "mvp:realtime_event",
    context: { channel: vf(a.channel), data: vf(a.data), auth },
    input: [],
  }, a);
}

// --- realtime publish (declarative) ----------------------------------------

/**
 * The realtime server to publish onto: a `realtimeServer()` handle, its bare name, or
 * a `Value` when the name is computed at runtime.
 *
 * The engine resolves this server by NAME within the current workspace and branch —
 * not by guid — so a handle contributes its `name`, not its identity.
 */
export type RealtimePublishServer = string | { name: string } | Value;

export interface RealtimePublishArgs extends StatementAnnotations {
  /**
   * The owning realtime server, by name. Required: a channel path is unique only
   * within its server, so the path alone cannot be addressed.
   */
  server: RealtimePublishServer;
  /**
   * The channel PATH to publish onto, already filled in — `"rooms/42"`, not the
   * `rooms/{room_id}` template. Build it with `realtimeChannel().getChannel({…})`
   * rather than concatenating by hand: its string goes here directly (a string
   * is the constant `c.text(…)`), and a path computed at runtime is a `Value`.
   */
  channel: string | Value;
  /** The event payload delivered to subscribers. */
  data: Value;
  /**
   * Optional message TYPE stamped on the frame, so a client that switches on type can
   * route a server-originated event the same way it routes a `realtimeMessage()` one.
   * Naming a type does NOT invoke that message's handler — see the note on delivery below.
   */
  message?: Value;
  /**
   * Optional ASSERTED identity attributed to the event: name an auth **table** (a
   * `table({ auth: true })` def or its name) and it resolves to that table's guid.
   *
   * This is attribution carried on the frame, NOT a credential — nothing validates it
   * and no auth gate consumes it. Do not use it to grant a publish that a channel's
   * `publish.who` would otherwise refuse; this statement bypasses that gate entirely.
   */
  authTable?: ObjectRef;
  /** The asserted identity's row id. Attribution only — see {@link RealtimePublishArgs.authTable}. */
  authId?: Value;
}

const REALTIME_PUBLISH_KEYS = /* @__PURE__ */ Object.keys({ server: 1, channel: 1, data: 1, message: 1, authTable: 1, authId: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<RealtimePublishArgs>, 1>);

/**
 * `realtime.publish { … }` — originate a server-authored event onto a realtime channel
 * from any function stack (`mvp:realtime_publish`).
 *
 * This is how a query, task, function, or trigger pushes to connected clients without a
 * client frame arriving first: "the auction closed", "the job finished", "row 42 changed".
 *
 * Three properties decide whether this is the right tool, and all three surprise people:
 *
 *  - **Delivery-only.** The event is fanned out to subscribers as-is. It does NOT invoke
 *    a `realtimeMessage()` handler, even when `message` names one, so no stack of yours
 *    runs on the delivery side. A channel `deliver` trigger still applies (it belongs to
 *    the channel, not to the message).
 *  - **Server-authoritative.** It bypasses the channel's `publish.who` policy — that gate
 *    governs CLIENTS. Any stack that can run this can publish, so guard it in your own
 *    stack if that matters.
 *  - **Fail-soft.** A missing or disabled server, a server with no minted canonical, or an
 *    unreachable bus is logged engine-side and returns quietly. NOTHING throws into your
 *    stack and there is no return value to check, so a mis-targeted publish is SILENT.
 *    The two references this SDK can check — `server` and `channel` — throw here at author
 *    time instead, because that is the only loud failure available.
 *
 * It does not rescue `deliverTo: "explicit"` on a `realtimeMessage()`: this originates an
 * event INTO a channel and never selects recipients from inside a handler.
 *
 * ```ts
 * const rooms = realtimeChannel({ name: "rooms/{room_id}", server: chat, input: { room_id: input.int() } });
 * s.realtime.publish({
 *   server: chat,
 *   channel: rooms.getChannel({ room_id: 42 }),
 *   message: c.text("post"),
 *   data: obj({ body: "the auction closed" }),
 * });
 * ```
 */
export function realtimePublish(a: RealtimePublishArgs): Statement {
  a = argsOrEmpty(a);
  assertKnownKeys(`Statement "s.realtime.publish"`, a, REALTIME_PUBLISH_KEYS);
  const server = publishServerValue(a.server);
  // `getChannel()` returns the path as a string, so the documented
  // `channel: rooms.getChannel({ room_id: 42 })` passes it straight through.
  const channel = typeof a.channel === "string" ? c.text(a.channel) : a.channel;
  if (!channel || channel.value === "") {
    throw new Error(
      "Statement \"s.realtime.publish\": required argument \"channel\" is missing — the filled-in channel path to publish onto (use `realtimeChannel().getChannel({…})`).",
    );
  }
  assertValueArg("s.realtime.publish", "channel", channel);
  assertFilledChannel(channel);
  assertValueArg("s.realtime.publish", "data", a.data);
  const context: Record<string, unknown> = {
    realtime_server: server,
    channel: vf(channel),
    data: vf(a.data),
  };
  if (a.message !== undefined && a.message !== null) {
    assertValueArg("s.realtime.publish", "message", a.message);
    context.message = vf(a.message);
  }
  const auth: Record<string, unknown> = {};
  if (a.authTable !== undefined && a.authTable !== null)
    auth.dbo_id = resolveRef("dbo", a.authTable, `Statement "s.realtime.publish": argument "authTable"`);
  if (a.authId !== undefined && a.authId !== null) {
    assertValueArg("s.realtime.publish", "authId", a.authId);
    auth.row_id = vf(a.authId);
  }
  if (Object.keys(auth).length > 0) context.auth = auth;
  return annotate({ name: "mvp:realtime_publish", context, input: [] }, a);
}

/**
 * Refuse a `channel` that is still a `{param}` TEMPLATE.
 *
 * `realtimeChannel({ name: "rooms/{room_id}" })` puts the template string in the
 * source, so copying it into a publish call reads completely natural — and it
 * publishes onto a literal path named `rooms/{room_id}`, which no client can
 * ever be subscribed to. Since the engine is fail-soft here (a mis-targeted
 * publish is swallowed and returns nothing), author time is the only place this
 * can be caught at all.
 *
 * A brace cannot appear in a real channel path: the stored-name charset that
 * `realtimeChannel()` enforces excludes it, so a constant carrying one is
 * unambiguously an unfilled template rather than an unusual path. Only a
 * CONSTANT is inspected — a `ref`/`inp` channel is computed at runtime and says
 * nothing here.
 */
function assertFilledChannel(channel: Value): void {
  if (!channel.tag.startsWith("const")) return;
  if (typeof channel.value !== "string" || !/[{}]/.test(channel.value)) return;
  throw new Error(
    `Statement "s.realtime.publish": \`channel\` is "${channel.value}", which is still a TEMPLATE — its ` +
      `{param} was never filled in, so this publishes onto a path no client can join, and the ` +
      `engine swallows the miss silently. Fill it in with ` +
      `\`channel.getChannel({ … })\` (e.g. \`c.text(rooms.getChannel({ room_id: 42 }))\`), or ` +
      `build the path at runtime from a \`ref\`/\`inp\`.`,
  );
}

/** Coerce the `server` argument to its stored value form — always the server's NAME. */
function publishServerValue(server: RealtimePublishServer): { value: string; tag: string; filters: unknown[] } {
  if (typeof server === "string") {
    if (server === "") throw new Error("Statement \"s.realtime.publish\": required argument \"server\" is missing — the owning realtime server's name.");
    return { value: server, tag: "const", filters: [] };
  }
  if (server && typeof server === "object" && "tag" in server) return vf(server as Value);
  const name = server && typeof server === "object" ? server.name : undefined;
  if (!name) {
    throw new Error(
      "Statement \"s.realtime.publish\": required argument \"server\" is missing — pass the `realtimeServer()` handle, its name, or a value naming it.",
    );
  }
  return { value: name, tag: "const", filters: [] };
}

// --- auth token (declarative) ----------------------------------------------

export interface CreateAuthTokenArgs<As extends string = string> extends StatementOptions {
  /**
   * The auth table the token authenticates against.
   *
   * `null` is the UNBOUND table the engine stores as a blank guid — deleted, or
   * never bound. It exists so `codegen` can reproduce such a statement instead
   * of throwing, the same "no target" spelling `db.query`'s `table` carries.
   */
  table: ObjectRef | null;
  /** Token id (the authenticated row id). */
  id: Value;
  /**
   * Extra claims embedded in the token. Defaults to `{}` (no extra claims). A
   * value, or a `{ key: value }` record, read as `obj(record)`.
   */
  extras?: Value | ObjInput;
  /** Expiry in seconds. Defaults to `86400` (24h); `0` never expires. */
  expiration?: Value;
  as?: As;
}

const CREATE_AUTH_TOKEN_KEYS = /* @__PURE__ */ Object.keys({ table: 1, id: 1, extras: 1, expiration: 1, as: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<CreateAuthTokenArgs>, 1>);

/**
 * `security.create_auth_token { … }` — mint an auth token (`mvp:create_auth`).
 *
 * Branded `AsShapeBrand<As, string>` (like the `db.*` producers) so a
 * `ref("<as>")` to the minted token traces to `string` via `InferResponse`
 * instead of `unknown` — the token is always a JWT string. The brand is phantom;
 * the emitted statement bytes are unchanged.
 */
export function createAuthToken<
  const As extends string = string,
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  a: CreateAuthTokenArgs<As> & { asFilters?: Fs },
): Statement & AsShapeBrand<As, ApplyFilters<string, Fs>> {
  a = argsOrEmpty(a);
  assertKnownKeys(`Statement "s.security.create_auth_token"`, a, CREATE_AUTH_TOKEN_KEYS);
  assertValueArg("s.security.create_auth_token", "id", a.id);
  assertArg("s.security.create_auth_token", "table", a.table, { nullable: true });
  const extras =
    typeof a.extras === "object" && a.extras !== null && !Array.isArray(a.extras) && !isTaggedValue(a.extras)
      ? obj(a.extras)
      : (a.extras as Value | undefined);
  return annotate({
    name: "mvp:create_auth",
    context: {},
    as: a.as ?? "",
    // Entry order and optionality come straight from the engine's own input
    // schema — `id`, `dbtable`, `extras?={}`, `expiration?=86400`. Xano's editor
    // writes this shape, so this is what a pulled workspace has.
    input: [
      { name: "id", ...vf(a.id) },
      {
        name: "dbtable",
        value: a.table === null ? "" : resolveRef("dbo", a.table, `Statement "s.security.create_auth_token": argument "table"`),
        tag: "const",
        filters: [],
      },
      ...(presentValueArg("s.security.create_auth_token", "extras", extras)
        ? [{ name: "extras", ...vf(extras!) }]
        : []),
      ...(presentValueArg("s.security.create_auth_token", "expiration", a.expiration)
        ? [{ name: "expiration", ...vf(a.expiration!) }]
        : []),
    ],
  } as unknown as Statement & AsShapeBrand<As, ApplyFilters<string, Fs>>, a);
}

// --- security.create_guid — REMOVED, and must not come back -----------------
//
// (grep: `NO_CREATE_GUID`)
//
// `s.security.create_guid` emitted `mvp:guid`. That statement is real at runtime,
// which is why modelling it looked correct — but it is INTERNAL, and the
// XanoScript language has no spelling for it:
//
//   - the only generator the script language offers is `security.create_uuid`,
//     which aliases `mvp:uuid4` (an RFC 4122 v4 UUID);
//   - no kind declares `mvp:guid` — the kind spelling is
//     `schema:security.create_uuid`, and there is no `schema:security.create_guid`;
//   - the builder UI no longer offers it either.
//
// The consequence is not cosmetic: a workspace containing `mvp:guid` renders the
// placeholder `"mvp:guid"` in a workspace pull, and pushing that document does
// NOT recreate the statement. So a builder emitting it would produce output
// that cannot survive a round trip.
//
// DO NOT re-add it. If a GUID is genuinely needed, the question is whether the
// ENGINE should gain a `security.create_guid` XanoScript spelling — not whether
// this builder should return. Until it has one, anything authored here is
// unroundtrippable by construction.
//
// NOT rerouted to `create_uuid`, deliberately: these are different generators
// producing different values, so a silent swap would change what callers' data
// contains.
//
// Stored `mvp:guid` still round-trips byte-for-byte via `raw()` — see
// `codegen/specials/misc.ts`. This only stops new code being written.

// --- expect.to_throw (structural) ------------------------------------------

export interface ExpectToThrowArgs extends StatementAnnotations {
  /** The statements expected to raise. */
  body: Statement[];
  /**
   * Text the raised error's message must CONTAIN (case-insensitive substring).
   * Omit to accept any error.
   */
  exception?: Value;
}

const EXPECT_TO_THROW_KEYS = /* @__PURE__ */ Object.keys({ body: 1, exception: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<ExpectToThrowArgs>, 1>);

/**
 * `expect.to_throw { … }` — assert a sub-stack throws (`mvp:test_expect_to_throw`).
 *
 * The matcher is stored as `context.value1` — the numbered slot every
 * `expect.*` statement keeps its operands in. It was emitted as
 * `context.exception` through 2.0.21, a key the engine never reads, so a
 * to_throw carrying one accepted ANY error instead of the one named.
 */
export function expectToThrow(a: ExpectToThrowArgs): Statement {
  a = argsOrEmpty(a);
  assertKnownKeys(`Statement "s.expect.to_throw"`, a, EXPECT_TO_THROW_KEYS);
  assertStatements("s.expect.to_throw", "body", a.body);
  const context: Record<string, unknown> = { run: a.body.map(encodeStatement) };
  if (presentValueArg("s.expect.to_throw", "exception", a.exception)) context.value1 = vf(a.exception!);
  return annotate({ name: "mvp:test_expect_to_throw", context, input: [] }, a);
}

// --- expect.to_match (guarded override of the generated factory) ------------

export interface ExpectToMatchArgs extends StatementAnnotations {
  /** The value under test — the SUBJECT the pattern is matched against. */
  expr?: Value;
  /** The regex PATTERN. Build it with `c.regex(...)`, not `c.text(...)`. */
  value?: Value;
}

const EXPECT_TO_MATCH_KEYS = /* @__PURE__ */ Object.keys({ expr: 1, value: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<ExpectToMatchArgs>, 1>);

/**
 * `expect.to_match` — assert a value matches a regex (`mvp:test_expect_to_match`).
 *
 * A typed, guarded pass-through to the generated factory: same bytes, same
 * fields. What it adds is a refusal. The `value`
 * slot is a PHP `preg_*` PATTERN, so a `c.text("^Xano SDK.*Engine$")` there is not
 * a stricter assertion — it is a pattern the engine cannot run, and the test
 * fails against the very string it was written for:
 *
 * ```
 * to_match failed - regex /"^Xano SDK.*Engine$"/ not matched in "Xano SDK Automated Testing Engine"
 * ```
 *
 * The refusal is build-time and inspects the value it was handed, exactly as the
 * `fl.regex_*` guard does: a bare `const` is refused and pointed at
 * `c.regex`, while a `ref`/`inp`/`env` pattern — whose text is not visible here —
 * is passed through untouched.
 */
export function expectToMatch(a: ExpectToMatchArgs = {}): Statement {
  a = argsOrEmpty(a);
  assertKnownKeys(`Statement "s.expect.to_match"`, a, EXPECT_TO_MATCH_KEYS);
  // Operand order first, for the same reason `withFilters` checks it first:
  // a swapped pair usually leaves a plain subject in the pattern slot,
  // which the bare-pattern refusal below would answer by pointing at `c.regex`
  // — advice that produces two patterns and no subject under test.
  // A plain value (through `any`) is refused before the refusals below read `.tag` off it.
  if (a.value !== undefined && a.value !== null) assertValueArg("s.expect.to_match", "value", a.value);
  if (a.expr !== undefined && a.expr !== null) assertValueArg("s.expect.to_match", "expr", a.expr);
  const reversed = reversedOperandRefusal(a.value, a.expr);
  if (reversed) {
    throw new Error(
      `Statement "s.expect.to_match": ${reversed} — \`expr\` is the value under test and \`value\` is ` +
        `the pattern.`,
    );
  }
  if (a.value) {
    const refusal = barePatternRefusal(a.value);
    if (refusal) throw new Error(`Statement "s.expect.to_match": ${refusal}.`);
  }
  return generated.expect.to_match(a);
}

registerStatement("mvp:array_map", arrayMap);
registerStatement("mvp:array_union", arrayUnion);
registerStatement("mvp:comment", comment);
registerStatement("mvp:get_input", getRawInput);
registerStatement("mvp:post_process", postProcess);
registerStatement("mvp:realtime_event", realtimeEvent);
registerStatement("mvp:realtime_publish", realtimePublish);
registerStatement("mvp:create_auth", createAuthToken);
registerStatement("mvp:test_expect_to_throw", expectToThrow);
