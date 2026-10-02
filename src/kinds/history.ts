/**
 * Request-history authoring model — the scalar surface every host shares.
 *
 * Xano's request history is an inherited setting (object → container → branch →
 * workspace). Xano SDK emits the *stored* config each tier persists plus the
 * `inherit` flag the engine's resolver reads; it never re-implements the walk.
 *
 * Authoring is a single scalar, matching Xano's own XanoScript ergonomics:
 *
 *   | Author intent        | `HistoryInput` | Stored (object tier)                  |
 *   | -------------------- | -------------- | ------------------------------------- |
 *   | Inherit (default)    | *(omit)*       | `{ inherit:true,  enabled:<kind>, limit:100 }` |
 *   | Off                  | `false`        | `{ inherit:false, enabled:false,  limit:100 }` |
 *   | On, default depth    | `true`         | `{ inherit:false, enabled:true,   limit:100 }` |
 *   | On, capture depth N  | `100`          | `{ inherit:false, enabled:true,   limit:N }`   |
 *   | On, unlimited depth  | `"all"`        | `{ inherit:false, enabled:true,   limit:-1 }`  |
 *
 * `limit` caps the number of statement executions captured in a single history
 * record's stack trace (debugger depth) — NOT record retention. `-1` is
 * unlimited (`"all"`). Providing any value flips `inherit:false` (customize) so
 * the authored value round-trips; an inherit block is normalized away.
 */
import type { HistoryBlock } from "./common.js";
import { defaultHistory } from "./common.js";

/** The scalar authoring surface for request history. Omit to inherit. */
export type HistoryInput = boolean | number | "all";

/**
 * Container-tier prefixes: an API group parents queries, a toolset parents
 * tools, and a realtime server / channel parents messages.
 */
export type ContainerPrefix = "query" | "tool" | "message";

/**
 * Whether a container tier is ON when nothing is authored. Query and tool
 * containers default on; the realtime tier defaults **off** — message history
 * is a hot path, so the engine keeps it opt-in.
 */
export const CONTAINER_DEFAULT_ENABLED: Readonly<Record<ContainerPrefix, boolean>> = {
  query: true,
  tool: true,
  message: false,
};

/**
 * A container tier's stored history block — `{ inherit, <prefix>_enabled,
 * <prefix>_limit }`. The API group (`app`) uses `query_*`; the toolset envelope
 * (agent/mcp_server/assistant) uses `tool_*`.
 */
export type ContainerHistoryBlock<P extends ContainerPrefix> = { inherit: boolean } & Record<
  `${P}_enabled`,
  boolean
> &
  Record<`${P}_limit`, number>;

/**
 * Object types the workspace-tier map carries a history pair for.
 *
 * `message` is the realtime tier and defaults off, like `function`, `middleware`,
 * and `trigger`. It belongs here because the engine stores a pair for it at the
 * workspace tier too — omitting it made the SDK emit a 12-key map against the
 * engine's 14, so `workspace.history` mismatched on every real workspace and no
 * workspace could round-trip clean.
 */
export const WORKSPACE_HISTORY_TYPES = [
  "query",
  "function",
  "task",
  "tool",
  "trigger",
  "middleware",
  "message",
  // The MCP primitives. Both default ON, like `tool`. An instance from before
  // they existed stores neither pair; it reads the absent pair as that default.
  "prompt",
  "resource",
] as const;
export type WorkspaceHistoryType = (typeof WORKSPACE_HISTORY_TYPES)[number];

/** The workspace-tier authoring map: a scalar per object type (all optional). */
export type WorkspaceHistoryDef = Partial<Record<WorkspaceHistoryType, HistoryInput>>;

/** The stored 18-key workspace history map (`{objType}_enabled`/`{objType}_limit`, no `inherit`). */
export type WorkspaceHistoryXdo = Record<`${WorkspaceHistoryType}_enabled`, boolean> &
  Record<`${WorkspaceHistoryType}_limit`, number>;

/** Map a scalar to its `{enabled, limit}` core. Throws on an invalid number. */
function scalarToEnabledLimit(input: HistoryInput): { enabled: boolean; limit: number } {
  if (input === false) return { enabled: false, limit: 100 };
  if (input === true) return { enabled: true, limit: 100 };
  if (input === "all") return { enabled: true, limit: -1 };
  if (!Number.isInteger(input) || (input as number) < 0) {
    // JSON, so `{ enabled: true }` reads as itself, not "[object Object]".
    throw new Error(
      `history takes true, false, "all" or an integer depth >= 0, got ${JSON.stringify(input)}`,
    );
  }
  return { enabled: true, limit: input };
}

/**
 * Object-tier history block. Omitting `input` yields the kind's inherit default
 * (see {@link defaultHistory}); any value flips `inherit:false`.
 */
export function encodeHistory(objType: string, input?: HistoryInput): HistoryBlock {
  if (input === undefined) return defaultHistory(objType);
  const { enabled, limit } = scalarToEnabledLimit(input);
  return { inherit: false, enabled, limit };
}

/**
 * Container-tier history block (`{ inherit, <prefix>_enabled, <prefix>_limit }`).
 * The omit path emits `inherit:true` plus the tier's own engine default (see
 * {@link CONTAINER_DEFAULT_ENABLED}) at `limit:100` — on for query (via app) and
 * tool (via toolset), off for message (via realtime server / channel).
 */
export function encodeContainerHistory<P extends ContainerPrefix>(
  prefix: P,
  input?: HistoryInput,
): ContainerHistoryBlock<P> {
  const { inherit, enabled, limit } =
    input === undefined
      ? { inherit: true, enabled: CONTAINER_DEFAULT_ENABLED[prefix], limit: 100 }
      : { inherit: false, ...scalarToEnabledLimit(input) };
  return {
    inherit,
    [`${prefix}_enabled`]: enabled,
    [`${prefix}_limit`]: limit,
  } as ContainerHistoryBlock<P>;
}

/**
 * Workspace-tier flat map (terminal fallback — no `inherit`). Wholesale: every
 * object type is emitted; a type absent from `map` falls back to its engine
 * default (`enabled` per the kind rule, `limit:100`). Matches the 18-key stored
 * shape.
 */
export function buildWorkspaceHistory(map: WorkspaceHistoryDef): WorkspaceHistoryXdo {
  const out = {} as Record<string, boolean | number>;
  for (const t of WORKSPACE_HISTORY_TYPES) {
    const input = map[t];
    const { enabled, limit } =
      input === undefined
        ? { enabled: defaultHistory(t).enabled, limit: 100 }
        : scalarToEnabledLimit(input);
    out[`${t}_enabled`] = enabled;
    out[`${t}_limit`] = limit;
  }
  return out as WorkspaceHistoryXdo;
}
