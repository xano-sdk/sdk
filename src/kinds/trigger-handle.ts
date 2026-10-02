/**
 * Typed input handle `t` for trigger stacks.
 *
 * A trigger's inputs are fixed by type (see `trigger-inputs.ts`). Rather than
 * make authors guess `inp("new")` as an untyped string, the `trigger.*`
 * factories pass a typed handle `t` to `stack: (t) => [...]` (and `response:
 * (t) => ...` on response-bearing types). Each member is a {@link FieldAccessor}:
 * it is a {@link Value} referencing the whole input **and** callable for typed
 * column/child access — `t.new("email")` → `inp("new.email")`. This
 * mirrors the `auth("id")` callable-value precedent and keeps the
 * `{value,tag,filters}` shape so it composes with `withFilters`.
 *
 * Runtime member names are sourced from `impliedInputs(objType)` so the handle
 * can never drift from the injected input array.
 */
import type { Value } from "../values/value.js";
import { inp } from "../values/value.js";
import { impliedInputs } from "./trigger-inputs.js";
import type { ToolsetType, TriggerInputObjType } from "./trigger-inputs.js";

/**
 * A trigger input reference: usable whole (as a {@link Value}) or called to
 * reference a child/column by name — `t.new("email")` → `inp("new.email")`.
 * `Cols` types the callable's accepted paths (immediate child names, plus a
 * dotted `child.rest` escape for deeper nesting). A `json`/untyped field uses
 * `Record<string, unknown>`, whose key set widens to `string` (any path).
 */
export type FieldAccessor<Cols = Record<string, unknown>> = Value &
  (<K extends keyof Cols & string>(path: K | `${K}.${string}`) => Value);

// --- Per-type handle shapes (database lives in trigger.ts, generic over row + actions) ---

/** Realtime channel trigger inputs. */
export interface RealtimeInputs {
  /** The channel action (`"message"` | `"join"`). */
  action: Value;
  /** The channel name. */
  channel: Value;
  /** The connecting client — `permissions` gates the realtime row/table access. */
  client: FieldAccessor<{
    extras: unknown;
    permissions: { dbo_id: number; row_id: string };
  }>;
  /** Connection options. */
  options: FieldAccessor<{ authenticated: boolean; channel: string }>;
  /** The message payload (nullable). */
  payload: Value;
}

/** The connecting client, shared by both realtime lifecycle trigger types. */
export type RealtimeClient = FieldAccessor<{
  extras: unknown;
  permissions: { dbo_id: number; row_id: string };
}>;

/** Realtime server lifecycle trigger inputs (connect / disconnect). */
export interface RealtimeServerTriggerInputs {
  /** The connection action (`"connect"` | `"disconnect"`). */
  action: Value;
  /** The realtime server being connected to. */
  realtime_server: Value;
  /** The connecting client — `permissions` gates its realtime row/table access. */
  client: RealtimeClient;
}

/** Realtime channel lifecycle trigger inputs (join / leave / deliver). */
export interface RealtimeChannelTriggerInputs {
  /** The membership action (`"join"` | `"leave"` | `"deliver"`). */
  action: Value;
  /** The channel path the client addressed. */
  channel: Value;
  /**
   * The message body on a `deliver` run, null on join/leave. It arrives NESTED,
   * so read a field as `t.payload("text")`. A flat `inp("text")` names an input
   * this trigger does not declare and RAISES at runtime, which for `deliver`
   * means the hook fails open and the recipient gets the original.
   */
  payload: FieldAccessor;
  /**
   * The client — the JOINING client on join/leave, and the SENDING client on
   * `deliver` (the recipient that run is for is `s.realtime.get_session`).
   * `permissions` gates its realtime row/table access.
   */
  client: RealtimeClient;
}

/** Agent trigger inputs. */
export interface AgentTriggerInputs {
  /** The toolset being connected to. */
  toolset: FieldAccessor<{ id: number; name: string; instructions: string }>;
  /** The toolset's tools, each `{id, name, instructions}` (a list value). */
  tools: FieldAccessor<{ id: number; name: string; instructions: string }>;
}

/**
 * MCP server trigger inputs. The response narrows what this connection lists:
 * return `prompts`/`resources` filtered and only those ids are served (an
 * entry's `description` replaces the listed one); a response without the key
 * leaves that list unfiltered.
 */
export interface McpServerTriggerInputs extends AgentTriggerInputs {
  /** The server's prompts, each `{id, name, description}` (a list value). */
  prompts: FieldAccessor<{ id: number; name: string; description: string }>;
  /** The server's resources, each `{id, name, description, uri}` (a list value). */
  resources: FieldAccessor<{ id: number; name: string; description: string; uri: string }>;
  /**
   * The signed-in user when the server has `oauth`: `{dbo, id, extras}` of the
   * auth-table row (`t.auth("id")`). Null on a server without sign-in, so
   * gate on it before reading a member.
   */
  auth: FieldAccessor<{ dbo: unknown; id: unknown; extras: unknown }>;
}

/** Workspace lifecycle trigger inputs. */
export interface WorkspaceInputs {
  /** The branch the action targets. */
  to_branch: FieldAccessor<{ id: number; label: string }>;
  /** The source branch (for merges). */
  from_branch: FieldAccessor<{ id: number; label: string }>;
  /** The lifecycle action (`"branch_live"` | `"branch_merge"` | `"branch_new"`). */
  action: Value;
}

/** Error trigger inputs — the error signature schema. */
export interface ErrorInputs {
  /** Which event fired (`"new"` | `"regression"` | `"fixed"`). */
  event: Value;
  /** The error signature row id. */
  id: Value;
  /** Stable signature hash. */
  signature: Value;
  /** Error code + message from the failing run. */
  error: FieldAccessor<{ code: string; message: string }>;
  /** Where the error originated (null on `"fixed"`). */
  caller: FieldAccessor<{ type: string; id: number; name: string | null }>;
  /** The failing statement (null on `"fixed"`). */
  statement: FieldAccessor<{ name: string; xsid: string }>;
  /** The user who marked the error fixed (only on `"fixed"`). */
  actor: FieldAccessor<{ id: number; name: string | null }>;
  /** Occurrence counts. */
  count: FieldAccessor<{ total: number; last_hour: number }>;
  /** ISO-8601 first occurrence. */
  first_seen: Value;
  /** ISO-8601 most recent occurrence. */
  last_seen: Value;
  /** ISO-8601 fixed-at (nullable). */
  fixed_at: Value;
}

/**
 * Build a {@link FieldAccessor}: a callable that references `base.<path>`, with
 * the whole-input `Value` (`inp(base)`) merged on so it doubles as a plain
 * reference. The `{value,tag,filters}` props ride on the function object, so a
 * later `{...t.new}` spread (e.g. inside `withFilters`) yields the plain Value.
 */
function accessor(base: string): FieldAccessor {
  const fn = (path: string): Value => inp(`${base}.${path}`);
  return Object.assign(fn, inp(base)) as FieldAccessor;
}

/**
 * Build the runtime handle object for a trigger `obj_type` — one
 * {@link accessor} per implied input, keyed by input name. The `trigger.*`
 * factories cast the result to the matching typed interface (the runtime is a
 * uniform superset; the type narrows plain-value members).
 */
export function buildTriggerHandle(
  objType: TriggerInputObjType,
  toolsetType?: ToolsetType,
): Record<string, FieldAccessor> {
  const handle: Record<string, FieldAccessor> = {};
  for (const { name } of impliedInputs(objType, toolsetType)) {
    handle[name] = accessor(name);
  }
  return handle;
}
