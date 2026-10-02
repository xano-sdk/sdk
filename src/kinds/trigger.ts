/**
 * Trigger kinds. All 6 trigger types share ONE stored envelope
 * discriminated by `obj_type` + a per-type `meta` block —
 * confirmed against the Xano engine's stored trigger shape. The canonical `meta`
 * carries all four action groups (database / toolset / workspace /
 * workspace_realtime_channel); each trigger type populates its own group and
 * leaves the others at their skeleton defaults.
 *
 * Response-bearing types (realtime, mcp_server, agent) emit `result[]`;
 * config-only types (table, workspace, error) do not.
 *
 * **Implied inputs.** A trigger's inputs are fixed by type — Xano
 * generates them in `mvp:trigger_update_defaults` and they cannot be edited.
 * Xano SDK injects the exact per-type input array (`impliedInputs`) at encode
 * time and exposes those inputs to the stack through a typed handle `t`:
 * `stack: (t) => [...]`. There is no user-supplied `input` field — the implied
 * inputs are the only inputs. For a database trigger bound to a `table()`
 * handle, `t.new` / `t.old` are typed against the table's row, with nullability
 * keyed on the enabled actions (delete → `new` is null, insert → `old` is null).
 */
import { assertKnownKeys } from "../util/known-keys.js";
import type { DiagnosticsFor } from "../workspace/diagnostics.js";
import type { ResultItemXdo, StackItemXdo, InputXdo } from "../types/xdo.js";
import type { Value } from "../values/value.js";
import { inp, ref, isTaggedValue } from "../values/value.js";
import { describeEntry } from "../statements/args.js";
import { assertDefShape } from "./def-shape.js";
import { setVar } from "../statements/set-var.js";
import { encodeStack } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { encodeExpression } from "../statements/expression.js";
import type { Condition } from "../statements/expression.js";
import { encodeResponse } from "../responses/response.js";
import type { ResponseDef } from "../responses/response.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";
import { encodeHistory, type HistoryInput } from "./history.js";
import { resolveRef } from "../refs/guid.js";
import type { ObjectRef } from "../refs/guid.js";
import type { InferRow } from "./table.js";
import { impliedInputs, isTriggerObjType } from "./trigger-inputs.js";
import { noteToolsetTarget, type ToolsetField } from "./toolset-target.js";
import type { ToolsetType, TriggerInputObjType } from "./trigger-inputs.js";
import { buildTriggerHandle } from "./trigger-handle.js";
import type {
  FieldAccessor,
  RealtimeInputs,
  RealtimeServerTriggerInputs,
  RealtimeChannelTriggerInputs,
  AgentTriggerInputs,
  McpServerTriggerInputs,
  WorkspaceInputs,
  ErrorInputs,
} from "./trigger-handle.js";
import { realtimeChannelGuid } from "./realtime-channel.js";
import type { RealtimeChannelDef } from "./realtime-channel.js";
import { brandDef } from "./def-brand.js";
import { refuseUnknown } from "./def-keys.js";
import type { NoExtraKeys } from "../fields/value-types.js";

/** The stored trigger `obj_type` (identical set to {@link TriggerInputObjType}). */
export type TriggerObjType = TriggerInputObjType;

export interface DatabaseActions {
  delete?: boolean;
  insert?: boolean;
  truncate?: boolean;
  update?: boolean;
}
export interface WorkspaceActions {
  branch_live?: boolean;
  branch_merge?: boolean;
  branch_new?: boolean;
}
export interface RealtimeActions {
  message?: boolean;
  join?: boolean;
}
/**
 * Realtime SERVER lifecycle actions (obj_type=realtime_server).
 *
 * `connect` GATES the connection — the stack's return admits or denies it. A
 * denial closes the socket (code 4401) after an `error` frame, before the
 * connection is ever ready, so it is a real front door and not just an observer.
 * Same return shape as a channel `join`: `{ allowed: c.bool(true) }` or any truthy value
 * admits, and an EMPTY OR FALSY return DENIES — including a gating trigger with
 * no `response`, which returns nothing and so refuses every client. A CRASH also
 * DENIES: a gate that cannot answer must not admit.
 *
 * So both failure modes lock the door rather than open it, and the risk to plan
 * for is a self-inflicted lockout — an unguarded drill into a `db.get` that
 * bound `null` raises, and every client is refused. The one thing that admits
 * without asking is NOT declaring the action at all: gating is opt-in, so a
 * server with no `connect` trigger accepts every connection.
 *
 * `disconnect` is OBSERVATIONAL: its return is ignored and a throw is swallowed,
 * because the connection is already gone and cleanup must always complete.
 *
 * Both are server-scoped, so `s.realtime.get_session` works but carries no
 * channel path and no bound params.
 */
export interface RealtimeServerActions {
  connect?: boolean;
  disconnect?: boolean;
}
/**
 * Realtime CHANNEL lifecycle actions (obj_type=channel). Independent booleans,
 * not a mode — one trigger may carry any combination.
 *
 * The three do NOT share a posture, and the difference decides what a stack
 * should return:
 *  - `join` GATES the join, and runs BEFORE the client becomes a member, so a
 *    denial means it never receives a fan-out. Return `{ allowed: c.bool(true) }` (an
 *    optional `reason` surfaces in the client's error frame) or any other truthy
 *    value to admit. AN EMPTY OR FALSY RETURN DENIES — a stack that just falls
 *    through, or a gating trigger with no `response`, refuses the join. A CRASH
 *    DENIES TOO, which is the INVERSE of a normal message: a message whose
 *    stack crashes still delivers, so one workspace bug cannot black-hole a
 *    channel. Note the asymmetry with `deliver` below, which is a hook that
 *    fails OPEN.
 *
 *    A lifecycle trigger's inputs are PINNED to `action`/`channel`/`payload`/
 *    `client`, so a channel path param is NOT among them: `inp("room_id")`
 *    RAISES inside a gate, which crashes it and so refuses every client. Take
 *    the param from `s.realtime.get_session` under `params`
 *    (`ref("session.params.room_id")`) and the gate can decide per room. A
 *    SERVER `connect`/`disconnect` trigger has no channel and so no params
 *    at all.
 *
 *    A gate also establishes NO auth, so `auth("id")` reads 0 even for an
 *    authenticated client (and `ref("auth.id")` raises: no `auth` variable) —
 *    identity is `t.client("permissions.row_id")` (0 is anonymous) or the
 *    session. `permissions.dbo_id` is the auth TABLE's id, not the caller. And once the returned object carries an
 *    `allowed` key, admission needs STRICTLY `true`: a computed `1` or `"yes"`
 *    in that shape DENIES, so produce a real bool.
 *  - `leave` is OBSERVATIONAL (return ignored, throws swallowed).
 *  - `deliver` GATES delivery PER RECIPIENT — it runs once for each client the
 *    message is about to reach. It is the heaviest of the three by a wide
 *    margin (a stack per recipient per message) and needs `delivery.perRecipient`
 *    on the channel to run at all.
 *
 *    ITS RETURN VALUES DO NOT READ LIKE A FILTER. Only an explicit **null**
 *    drops the message for that recipient. An **object** replaces that
 *    recipient's payload. ANYTHING ELSE — including `false`, `0`, and `""` —
 *    DELIVERS THE MESSAGE UNCHANGED, as does a crash. So `return false` from a
 *    yes/no redaction check sends the message it was meant to suppress; return
 *    null instead.
 *
 *    The delivered payload arrives NESTED under `payload`, so read
 *    `t.payload("<field>")`. And the two identities differ: `t.client` is the
 *    SENDER, while `s.realtime.get_session` describes the RECIPIENT this run is
 *    for — per-viewer redaction needs both, and reaching for the wrong one is
 *    silent.
 */
export interface RealtimeChannelActions {
  join?: boolean;
  leave?: boolean;
  deliver?: boolean;
}

// --- Database handle typing ---

/** The row type a database trigger references, or a `json` floor when no
 * `table()` handle is bound (a raw numeric `objId` carries no field brands). */
type TriggerRow<T> = [InferRow<T>] extends [never] ? Record<string, unknown> : InferRow<T>;

/** `new` is present when an insert or update action is enabled. */
type HasNew<A> = A extends { insert: true } ? true : A extends { update: true } ? true : false;
/** `old` is present when an update or delete action is enabled. */
type HasOld<A> = A extends { update: true } ? true : A extends { delete: true } ? true : false;

/**
 * The typed handle passed to a database trigger's `stack`. `action`/`datasource`
 * are always present; `new`/`old` are typed row accessors when their action is
 * enabled and `null` otherwise (delete → `new` null, insert → `old` null,
 * update → both, truncate → neither). A multi-action trigger offers both — the
 * runtime value can still be empty for the op that didn't fire, discriminated
 * via `t.action`.
 */
export type DatabaseInputs<Row, A> = {
  /** The database op (`"insert"` | `"update"` | `"delete"` | `"truncate"`). */
  action: Value;
  /** The data source label the change occurred on. */
  datasource: Value;
} & (HasNew<A> extends true ? { new: FieldAccessor<Row> } : { new: null }) &
  (HasOld<A> extends true ? { old: FieldAccessor<Row> } : { old: null });

/** The canonical four-group meta skeleton (per the engine's stored trigger shape). */
function baseMeta() {
  return {
    database: {
      datasource: [] as unknown[],
      search: { expression: [] as unknown[] },
      action: { delete: false, insert: false, truncate: false, update: false },
    },
    toolset: { action: { connection: false } },
    workspace: { action: { branch_live: false, branch_merge: false, branch_new: false } },
    workspace_realtime_channel: { action: { message: false, join: false } },
    // The two realtime lifecycle groups. Every trigger type carries the WHOLE
    // skeleton with only its own group's flags set — verified against a live
    // engine capture, which emits all six groups for a table trigger, a workspace
    // trigger, and both realtime lifecycle triggers alike.
    realtime_server: { action: { connect: false, disconnect: false } },
    channel: { action: { join: false, leave: false, deliver: false } },
  };
}

/**
 * Reject a trigger condition the enabled actions cannot evaluate.
 *
 * Mirrors the checks Xano's own trigger editor runs before it will save. They are
 * not stylistic: the pseudo-table a condition names has to EXIST for the action
 * that fired. An `insert` has no `OLD` row and a `delete` has no `NEW` one, so a
 * condition reading the missing side is unevaluable, and `truncate` fires once
 * for the whole table with no row to test at all.
 *
 * Raised at authoring time rather than left to the deploy, because the engine
 * accepts the object and the breakage surfaces later as a trigger that silently
 * does not fire.
 *
 * A multi-action trigger is checked against EVERY enabled action — `{insert,
 * update}` reading `OLD.*` is rejected, since the insert half could not run it.
 */
function assertSearchMatchesActions(
  name: string,
  expression: unknown,
  action: { delete: boolean; insert: boolean; truncate: boolean; update: boolean },
): void {
  if (action.truncate) {
    throw new Error(
      `tableTrigger "${name}": \`search\` is not supported with the \`truncate\` action — ` +
        `a truncate fires once for the whole table, with no row to test.`,
    );
  }
  const operands = collectOperands(expression);
  for (const [enabled, forbidden] of [
    [action.insert, "OLD"],
    [action.delete, "NEW"],
  ] as const) {
    if (!enabled) continue;
    const hit = operands.find((o) => o.startsWith(`${forbidden}.`));
    if (hit !== undefined) {
      const act = forbidden === "OLD" ? "insert" : "delete";
      throw new Error(
        `tableTrigger "${name}": \`search\` reads \`${hit}\`, which does not exist for the ` +
          `\`${act}\` action this trigger is enabled for. Use ${forbidden === "OLD" ? "`NEW.*`" : "`OLD.*`"}, ` +
          `or split the actions into separate triggers.`,
      );
    }
  }
}

/** Every `operand` string in an encoded expression tree, at any depth. */
function collectOperands(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(collectOperands);
  if (node === null || typeof node !== "object") return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "operand" && typeof value === "string") out.push(value);
    else out.push(...collectOperands(value));
  }
  return out;
}

/**
 * Internal trigger def produced by the `*Trigger` root factories.
 *
 * Generic over the branded stack tuple `S`, the literal response `Resp`, and a
 * declared `Res` (the `responseShape` override), so `InferResponse` resolves a
 * response-bearing trigger the way it resolves any other kind. All default, so
 * the bare `satisfies TriggerDef` form codegen emits is unchanged.
 *
 * The carriers arrive here through the factories' BUILDER CALLBACKS rather than
 * from plain fields — `stack: (t) => [...]` and `response: (t) => ({...})` are
 * invoked at factory time, and a `const` type parameter infers the callback's
 * return as a tuple exactly as it would a directly-passed array. Without that,
 * the resolved stack reached the returned def as a widened `Statement[]` and
 * every ref in the response bottomed out.
 */
export interface TriggerDef<
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  S extends readonly Statement[] = readonly Statement[],
> {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "trigger";
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  objType: TriggerObjType;
  /**
   * For a `toolset` trigger, which kind of toolset it binds. An `"mcp"` server's
   * trigger (the default) also receives `prompts` and `resources`; an
   * `"agent"`'s does not. Set by `mcpServerTrigger` / `agentTrigger`.
   */
  toolsetType?: ToolsetType;
  /** Accepted export warnings for this def ({@link DiagnosticsFor}). Never emitted. */
  diagnostics?: DiagnosticsFor<"trigger">;
  /**
   * The bound object id. For a database trigger this is the target table — pass
   * a `table()` handle/name via the `table` factory arg instead and it resolves
   * to the table's portable guid (the engine remaps guid→local id on import,
   * exactly like a query's `app` binding). A raw numeric id is the escape hatch.
   */
  objId?: number | string;
  description?: string;
  active?: boolean;
  /**
   * The resolved statement stack (the `stack` callback is invoked at factory
   * time). Captured as the literal tuple `S` so `InferResponse` can trace a
   * response ref back to the statement that bound it; a helper typed
   * `Statement[]` spread into the callback's return widens it and the trace
   * degrades — declare `responseShape` there.
   */
  stack?: S;
  /** The resolved response (response-bearing types only), captured as the
   * literal `Resp` so `InferResponse` can derive its keys and trace each member. */
  response?: Resp;
  /**
   * Type-only: declare the trigger's response shape so `InferResponse<typeof
   * trig>` recovers it exactly, overriding automatic derivation. The runtime
   * value is ignored by `encodeTrigger`; only its type is read.
   */
  responseShape?: Res;
  /** Whether this type emits a `result[]` (response-bearing). */
  hasResult: boolean;
  /** The per-type meta block (already populated for this type). */
  meta: Record<string, unknown>;
  /**
   * Request-history capture. Omit to inherit from the workspace (triggers have
   * no container tier). A scalar: `false` off, `true` on at default depth, a
   * number = capture depth, `"all"` unlimited. Any value stops inheriting.
   * Triggers default OFF. See {@link HistoryInput}.
   */
  history?: HistoryInput;
  /** Workspace tags (stored `tag: [{tag}]`), e.g. `["xano:quick-start"]`. */
  tags?: string[];
}

export interface TriggerXdo {
  name: string;
  active: boolean;
  description: string;
  /** Numeric local id, or the bound object's guid (the portable form). */
  obj_id: number | string;
  obj_type: TriggerObjType;
  history: { inherit: boolean; enabled: boolean; limit: number };
  output: unknown[];
  meta: Record<string, unknown>;
  tag: unknown[];
  input: InputXdo[];
  run: StackItemXdo[];
  result?: ResultItemXdo[];
}

/**
 * Any trigger def, whatever its stack/response — the parameter type every
 * consumer that only READS a def wants. `Res` is widened to `unknown` rather
 * than left at the `never` default, which would reject a def that declares
 * `responseShape`; the same widening `encodeQuery` uses.
 */
export type AnyTriggerDef = TriggerDef<unknown>;

export function encodeTrigger(def: AnyTriggerDef): TriggerXdo {
  if (!def.name) throw new Error("trigger: `name` is required.");
  // Through `any` a def that is not a trigger (a function def passed to
  // registerTriggers) reached the input catalog as `CATALOG[undefined]()` — a
  // TypeError naming nothing the author wrote.
  if (!isTriggerObjType(def.objType)) {
    throw new Error(
      `trigger "${def.name}": \`objType\` is ${describeEntry(def.objType)}, so this is not a trigger def — ` +
        `build one with tableTrigger, realtimeTrigger, realtimeServerTrigger, realtimeChannelTrigger, ` +
        `mcpServerTrigger, agentTrigger, workspaceTrigger or errorTrigger.`,
    );
  }
  const xdo: TriggerXdo = {
    name: def.name,
    active: def.active ?? true,
    description: def.description ?? "",
    obj_id: def.objId ?? 0,
    obj_type: def.objType,
    history: encodeHistory("trigger", def.history),
    output: [],
    meta: def.meta,
    tag: encodeTags(def.tags),
    // Inputs are implied by type (fixed by Xano, not user-editable) — always
    // inject the canonical per-type array, never a user-supplied map.
    input: impliedInputs(def.objType, def.toolsetType),
    run: encodeStack("trigger", def.name, def.stack),
  };
  if (def.hasResult) {
    xdo.result = encodeResponse(def.response);
  } else {
    xdo.result = [];
  }
  return xdo;
}

const RESPONSE_ARGS = ["response", "responseShape"];

/**
 * A factory's `actions`, every flag present in stored order. A misspelt key
 * (`inesrt`, `conect`) was dropped and the trigger deployed with every action
 * off — it never fires. Refused here; `export()` warns on an all-off set.
 */
function triggerActions<K extends string>(
  factory: string,
  args: { name?: unknown; actions?: object },
  keys: readonly K[],
): Record<K, boolean> {
  const actions = args.actions as Partial<Record<K, boolean>> | undefined;
  if (typeof actions === "object" && actions !== null) {
    refuseUnknown(`${factory} "${String(args.name)}" \`actions\``, actions, keys);
  }
  return Object.fromEntries(keys.map((k) => [k, actions?.[k] ?? false])) as Record<K, boolean>;
}

/**
 * Refuse a factory arg the trigger does not read. The factory copies named
 * fields into the def, so a misspelt one (`stak`, `action`) was gone before
 * `register*` could see it.
 */
function triggerArgs(factory: string, args: object, own: readonly string[]): void {
  assertKnownKeys(`${factory} "${(args as { name?: unknown }).name}"`, args, [
    "name", "guid", "description", "active", "objId", "tags", "history", "diagnostics", "stack", ...own,
  ]);
}

/** Fields common to every trigger factory. Note: no `input` — trigger inputs
 * are implied by type and cannot be user-supplied. */
interface CommonArgs {
  name: string;
  /** Explicit Xano `guid` (defaults to a guid derived from `name`). */
  guid?: string;
  description?: string;
  active?: boolean;
  objId?: number;
  /** Workspace tags (stored `tag: [{tag}]`), e.g. `["xano:quick-start"]`. */
  tags?: string[];
  /** Accepted export warnings for this trigger ({@link DiagnosticsFor}). Never emitted. */
  diagnostics?: DiagnosticsFor<"trigger">;
  /**
   * Request-history capture for THIS trigger. Omit to inherit from the
   * workspace (`workspaceConfig({ history: { trigger } })`, default off). A
   * trigger's own failure reaches the error log, and a failing table trigger
   * runs the workspace's error trigger, only while its history is on. See
   * {@link HistoryInput}.
   */
  history?: HistoryInput;
}

/**
 * Database table trigger (obj_type=database; XanoScript authoring term `table`).
 * Config-only (no response). The `stack` callback receives `t` with
 * `t.new`/`t.old` (typed against the bound `table` row) plus
 * `t.action`/`t.datasource`.
 */
export function tableTrigger<
  const T extends ObjectRef | undefined = undefined,
  const A extends DatabaseActions = DatabaseActions,
>(
  args: CommonArgs & {
    table?: T;
    datasources?: string[];
    actions?: A & NoExtraKeys<A, DatabaseActions, keyof DatabaseActions>;
    /**
     * Fire only for row changes matching this condition — Xano's "custom filter".
     *
     * Reference the changed row through the SQL-side pseudo-tables with `col()`:
     * `col("NEW.status")` is the row after the change, `col("OLD.status")` before
     * it. These are Postgres trigger operands, not the `t.new`/`t.old` stack
     * handle, because the condition is evaluated by the DATABASE before any stack
     * runs — which is also why a filtered trigger installs as a dynamic trigger
     * rather than a static one.
     *
     * Three rules the engine enforces, checked here instead of at deploy:
     * `truncate` admits no filter at all (there is no row to test), `insert` may
     * not read `OLD.*`, and `delete` may not read `NEW.*`.
     */
    search?: Condition;
    stack?: Statement[] | ((t: DatabaseInputs<TriggerRow<T>, A>) => Statement[]);
  },
): TriggerDef {
  triggerArgs("tableTrigger", args, ["table", "datasources", "actions", "search"]);
  const meta = baseMeta();
  assertDefShape("trigger", args as unknown as Record<string, unknown>);
  meta.database.datasource = (args.datasources ?? []).map((tag) => ({ tag }));
  meta.database.action = triggerActions("tableTrigger", args, ["delete", "insert", "truncate", "update"]);
  if (args.search !== undefined) {
    const encoded = encodeExpression(args.search);
    assertSearchMatchesActions(args.name, encoded.expression, meta.database.action);
    meta.database.search = encoded;
  }
  // Bind to the target table by its portable guid (a `table()` handle or
  // name); a raw numeric `objId` stays the escape hatch.
  const objId = args.table !== undefined ? resolveRef("dbo", args.table) : args.objId;
  const t = buildTriggerHandle("database") as unknown as DatabaseInputs<TriggerRow<T>, A>;
  return brandDef({
    name: args.name,
    guid: args.guid,
    diagnostics: args.diagnostics,
    description: args.description,
    active: args.active,
    tags: args.tags,
    history: args.history,
    objId,
    objType: "database",
    hasResult: false,
    meta,
    stack: triggerStack(args.name, args.stack, t),
  }, "trigger");
}

/**
 * LEGACY realtime trigger (obj_type=workspace_realtime_channel). Response-bearing.
 *
 * @deprecated Superseded. This fires against Xano's older workspace-global realtime
 * config, which is a DIFFERENT object from the current `channel` despite the shared
 * vocabulary — the two generations coexist and mixing them fails at runtime rather
 * than at compile.
 *
 * It is still exported and still supported because `xanosdk codegen` has to bring
 * back a workspace that holds one. Do not author it in new code:
 *  - its `join` action is now `realtimeChannelTrigger({ actions: { join: true } })`
 *  - its `message` action is now a `realtimeMessage()` handler, because a message is
 *    an authored unit with its own typed payload and stack rather than a trigger
 *    action
 *
 * Withheld from the object-kind catalog and named only in `llms/legacy.md`.
 */
export function realtimeTrigger<
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  const S extends readonly Statement[] = readonly [],
>(
  args: CommonArgs & {
    actions?: RealtimeActions;
    stack?: S | ((t: RealtimeInputs) => S);
    response?: Resp | ((t: RealtimeInputs) => Resp);
    responseShape?: Res;
  },
): TriggerDef<Res, Resp, S> {
  triggerArgs("realtimeTrigger", args, ["actions", ...RESPONSE_ARGS]);
  const meta = baseMeta();
  meta.workspace_realtime_channel.action = triggerActions("realtimeTrigger", args, ["message", "join"]);
  const t = buildTriggerHandle("workspace_realtime_channel") as unknown as RealtimeInputs;
  return brandDef({
    name: args.name,
    guid: args.guid,
    diagnostics: args.diagnostics,
    description: args.description,
    active: args.active,
    tags: args.tags,
    history: args.history,
    objId: args.objId,
    objType: "workspace_realtime_channel",
    hasResult: true,
    meta,
    // The `?? []` fallback matches `S`'s own `readonly []` default (which is what
    // `S` resolves to when the callback is omitted); the cast covers the branch
    // TypeScript cannot tie back to that default.
    stack: triggerStack(args.name, args.stack, t) as unknown as S,
    // Xano default: echo the `payload` input back. It is a plain
    // `Value` with no trace, so an omitted callback derives `unknown`.
    response: (args.response !== undefined ? triggerResponse(args.response, t) : inp("payload")) as Resp,
  }, "trigger");
}

/**
 * Realtime server lifecycle trigger (obj_type=realtime_server) — fires when a
 * client connects to or disconnects from a realtime server. Response-bearing.
 *
 * Bind the target with `realtimeServer` (a `realtimeServer()` handle or its
 * name); it resolves to the server's guid at export, so the binding survives a
 * `--reset` deploy. A raw numeric `objId` stays the escape hatch.
 *
 * Like every other trigger type, its `meta` carries the WHOLE six-group skeleton
 * with only its own group's flags set. An earlier version of this comment claimed
 * the realtime types stored a single-group `meta`; a live engine capture disproved
 * it — the engine emits all six groups for every type.
 */
export function realtimeServerTrigger<
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  const S extends readonly Statement[] = readonly [],
>(
  args: CommonArgs & {
    realtimeServer?: ObjectRef;
    actions?: RealtimeServerActions;
    stack?: S | ((t: RealtimeServerTriggerInputs) => S);
    response?: Resp | ((t: RealtimeServerTriggerInputs) => Resp);
    responseShape?: Res;
  },
): TriggerDef<Res, Resp, S> {
  triggerArgs("realtimeServerTrigger", args, ["realtimeServer", "actions", ...RESPONSE_ARGS]);
  const t = buildTriggerHandle("realtime_server") as unknown as RealtimeServerTriggerInputs;
  const serverMeta = baseMeta();
  serverMeta.realtime_server.action = triggerActions("realtimeServerTrigger", args, ["connect", "disconnect"]);
  return brandDef({
    name: args.name,
    guid: args.guid,
    diagnostics: args.diagnostics,
    description: args.description,
    active: args.active,
    tags: args.tags,
    history: args.history,
    objId:
      args.realtimeServer !== undefined
        ? resolveRef("realtime_server", args.realtimeServer)
        : args.objId,
    objType: "realtime_server",
    hasResult: true,
    meta: serverMeta,
    // See the `realtimeTrigger` note: the fallback matches `S`'s own default.
    stack: triggerStack(args.name, args.stack, t) as unknown as S,
    response: triggerResponse(args.response, t) as Resp | undefined,
  }, "trigger");
}

/**
 * Realtime channel lifecycle trigger (obj_type=channel) — fires when a client
 * joins or leaves a channel, or when a message is about to be delivered to one.
 * Response-bearing.
 *
 * Bind the target with `channel` (a `realtimeChannel()` handle, which also
 * carries its server) — a bare channel path is NOT accepted here, because a
 * path is unique only within a server and would bind ambiguously.
 *
 * The three actions have three different postures — see
 * {@link RealtimeChannelActions}. `deliver` is the one worth reading about before
 * enabling: it runs once per RECIPIENT per message, and its return decides that
 * recipient's copy of the payload.
 */
export function realtimeChannelTrigger<
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  const S extends readonly Statement[] = readonly [],
>(
  args: CommonArgs & {
    channel?: RealtimeChannelDef;
    actions?: RealtimeChannelActions;
    stack?: S | ((t: RealtimeChannelTriggerInputs) => S);
    response?: Resp | ((t: RealtimeChannelTriggerInputs) => Resp);
    responseShape?: Res;
  },
): TriggerDef<Res, Resp, S> {
  triggerArgs("realtimeChannelTrigger", args, ["channel", "actions", ...RESPONSE_ARGS]);
  const channel: unknown = args.channel;
  if (channel !== undefined && (typeof channel !== "object" || channel === null || !(channel as { server?: unknown }).server)) {
    throw new Error(
      `realtimeChannelTrigger ${JSON.stringify(args.name)}: \`channel\` must be a realtimeChannel() handle, which ` +
        `carries its server — got ${typeof channel === "string" ? `the bare path ${JSON.stringify(channel)}` : String(channel)}. ` +
        `A channel path is unique only within its server. Pass the handle: \`channel: <the realtimeChannel() result>\`.`,
    );
  }
  const t = buildTriggerHandle("channel") as unknown as RealtimeChannelTriggerInputs;
  const channelMeta = baseMeta();
  channelMeta.channel.action = triggerActions("realtimeChannelTrigger", args, ["join", "leave", "deliver"]);
  return brandDef({
    name: args.name,
    guid: args.guid,
    diagnostics: args.diagnostics,
    description: args.description,
    active: args.active,
    tags: args.tags,
    history: args.history,
    objId: args.channel !== undefined ? realtimeChannelGuid(args.channel) : args.objId,
    objType: "channel",
    hasResult: true,
    meta: channelMeta,
    // See the `realtimeTrigger` note: the fallback matches `S`'s own default.
    stack: triggerStack(args.name, args.stack, t) as unknown as S,
    response: triggerResponse(args.response, t) as Resp | undefined,
  }, "trigger");
}

/**
 * MCP server trigger (obj_type=toolset, connection action). Response-bearing.
 * Bind the target MCP server with `mcpServer` (a `mcpServer()` def handle or
 * its name) — it resolves to the toolset guid at export and survives a
 * `--reset` deploy. A raw numeric `objId` stays the escape hatch.
 *
 * `t` carries the server's `tools`, `prompts` and `resources`, and `auth` —
 * the signed-in user when the server has `oauth`, else null. Returning a
 * filtered `prompts`/`resources` narrows what this connection lists; a response
 * without that key leaves the list unfiltered. The default response returns the
 * four lists unchanged.
 */
export function mcpServerTrigger<
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  const S extends readonly Statement[] = readonly [],
>(
  args: CommonArgs & {
    mcpServer?: ObjectRef;
    stack?: S | ((t: McpServerTriggerInputs) => S);
    response?: Resp | ((t: McpServerTriggerInputs) => Resp);
    responseShape?: Res;
  },
): TriggerDef<Res, Resp, S> {
  triggerArgs("mcpServerTrigger", args, ["mcpServer", ...RESPONSE_ARGS]);
  return toolsetTrigger<Res, Resp, S, McpServerTriggerInputs>(args, args.mcpServer, "mcpServer");
}

/**
 * Agent trigger (obj_type=toolset, connection action). Response-bearing.
 * Bind the target agent with `agent` (an `agent()` def handle or its name),
 * resolved to the toolset guid at export; `objId` is the raw escape hatch.
 */
export function agentTrigger<
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  const S extends readonly Statement[] = readonly [],
>(
  args: CommonArgs & {
    agent?: ObjectRef;
    stack?: S | ((t: AgentTriggerInputs) => S);
    response?: Resp | ((t: AgentTriggerInputs) => Resp);
    responseShape?: Res;
  },
): TriggerDef<Res, Resp, S> {
  triggerArgs("agentTrigger", args, ["agent", ...RESPONSE_ARGS]);
  return toolsetTrigger(args, args.agent, "agent");
}

/** Workspace lifecycle trigger (obj_type=workspace). Config-only. */
export function workspaceTrigger(
  args: CommonArgs & {
    actions?: WorkspaceActions;
    stack?: Statement[] | ((t: WorkspaceInputs) => Statement[]);
  },
): TriggerDef {
  triggerArgs("workspaceTrigger", args, ["actions"]);
  const meta = baseMeta();
  meta.workspace.action = triggerActions("workspaceTrigger", args, ["branch_live", "branch_merge", "branch_new"]);
  const t = buildTriggerHandle("workspace") as unknown as WorkspaceInputs;
  return brandDef({
    name: args.name,
    guid: args.guid,
    diagnostics: args.diagnostics,
    description: args.description,
    active: args.active,
    tags: args.tags,
    history: args.history,
    objId: args.objId,
    objType: "workspace",
    hasResult: false,
    meta,
    stack: triggerStack(args.name, args.stack, t),
  }, "trigger");
}

/**
 * Error trigger (obj_type=error). Config-only, and the one type with no action
 * flags of its own — there is no `error` group in the meta skeleton, because an
 * error trigger fires on the error events its INPUT schema describes rather than
 * on a set of toggles.
 *
 * It still writes the full {@link baseMeta} skeleton, like every other type,
 * rather than `{}` — which would contradict both that rule and the one shipped
 * fixture (which stores two of the groups). All three spellings are inert: the
 * engine reads every group as `?? false`, so an absent group and an all-off
 * group are the same state, and `normalize` treats them as one. With no live
 * capture to settle which one Xano writes, matching the SDK's own rule is the
 * spelling that leaves no contradiction to trip over — not an engine-verified
 * correction.
 */
export function errorTrigger(
  args: CommonArgs & {
    stack?: Statement[] | ((t: ErrorInputs) => Statement[]);
  },
): TriggerDef {
  triggerArgs("errorTrigger", args, []);
  const t = buildTriggerHandle("error") as unknown as ErrorInputs;
  return brandDef({
    name: args.name,
    guid: args.guid,
    diagnostics: args.diagnostics,
    description: args.description,
    active: args.active,
    tags: args.tags,
    history: args.history,
    objId: args.objId,
    objType: "error",
    hasResult: false,
    meta: baseMeta(),
    stack: triggerStack(args.name, args.stack, t),
  }, "trigger");
}

/**
 * Shared MCP-server / agent trigger construction (both are `obj_type=toolset`).
 * `target` is the bound toolset handle (from `mcpServer`/`agent`); it resolves
 * against the shared `toolset` migrate type — matching the object's own
 * `md5("toolset:"+name)` guid — so binding is guid-stable across a `--reset`.
 * Mirrors the `table` trigger's handle-binding precedence (handle wins; a raw
 * numeric `objId` is the fallback escape hatch).
 *
 * `field` also picks the inputs: an MCP server's trigger receives `prompts` and
 * `resources` after `toolset`/`tools`, an agent's does not.
 */
function toolsetTrigger<
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  const S extends readonly Statement[] = readonly [],
  T extends AgentTriggerInputs = AgentTriggerInputs,
>(
  args: CommonArgs & {
    stack?: S | ((t: T) => S);
    response?: Resp | ((t: T) => Resp);
    responseShape?: Res;
  },
  target: ObjectRef | undefined,
  field: ToolsetField,
): TriggerDef<Res, Resp, S> {
  const meta = baseMeta();
  meta.toolset.action.connection = true;
  const toolsetType: ToolsetType = field === "agent" ? "agent" : "mcp";
  const t = buildTriggerHandle("toolset", toolsetType) as unknown as T;
  // Every input, in stored order: the default stack and response pass each one
  // through — except an MCP server's `auth`, which the platform's own default
  // leaves out (it is the signed-in user, not a list the response narrows).
  const passed = Object.keys(t).filter((name) => name !== "auth");
  const bound = target !== undefined ? resolveRef("toolset", target) : undefined;
  const authoredStack = args.stack !== undefined && args.stack !== null;
  // For an unregistered target's error: the SDK kind and the one field, not
  // the stored `toolset` and both fields.
  if (bound !== undefined) noteToolsetTarget(bound, field);
  return brandDef({
    name: args.name,
    guid: args.guid,
    diagnostics: args.diagnostics,
    description: args.description,
    active: args.active,
    tags: args.tags,
    history: args.history,
    objId: bound ?? args.objId,
    objType: "toolset",
    toolsetType,
    hasResult: true,
    meta,
    // Xano default: copy each input into a like-named stack var.
    // See the `realtimeTrigger` note on the cast; the default stack's `set_var`
    // bindings are untraceable anyway, so an omitted callback derives `unknown`.
    stack: (authoredStack
      ? triggerStack(args.name, args.stack, t)
      : passed.map((name) => setVar(name, inp(name)))) as unknown as S,
    // Xano default: return each input. Over the default stack it reads the
    // vars that stack set (the stored default); under an author's stack, which
    // binds none of them, it reads the inputs themselves.
    response: (args.response !== undefined && args.response !== null
      ? triggerResponse(args.response, t)
      : Object.fromEntries(passed.map((name) => [name, authoredStack ? inp(name) : ref(name)]))) as Resp,
  }, "trigger");
}

/**
 * A trigger's `stack`: the `(t) => [...]` callback (for the typed trigger
 * inputs), or a plain list of steps when the stack reads none of them. Through
 * `any`, anything else reported `args.stack is not a function` — refused here
 * by name instead.
 */
function triggerStack<C>(name: unknown, stack: unknown, t: C): Statement[] {
  if (stack === undefined || stack === null) return [];
  const steps = typeof stack === "function" && !isTaggedValue(stack) ? (stack as (t: C) => unknown)(t) : stack;
  if (!Array.isArray(steps)) {
    const what = typeof stack === "function" ? `the callback returned ${describeEntry(steps)}` : `got ${describeEntry(stack)}`;
    throw new Error(
      `Trigger ${JSON.stringify(String(name))}: stack must be a list of steps or a callback (t) => [ ... ] — ${what}.`,
    );
  }
  return steps as Statement[];
}

/**
 * A trigger's `response`: the `(t) => …` callback, or the response itself when
 * it reads no trigger input. A trigger field accessor (`t.new`) is a callable
 * VALUE, so a tagged callable is the response, not a callback.
 */
function triggerResponse<C>(response: unknown, t: C): unknown {
  if (response === undefined || response === null) return undefined;
  return typeof response === "function" && !isTaggedValue(response) ? (response as (t: C) => unknown)(t) : response;
}

export const triggerKind: ObjectKind<AnyTriggerDef, TriggerXdo> = {
  name: "trigger",
  payloadKey: "trigger",
  encode: encodeTrigger,
};

registerKind(triggerKind);
