/**
 * Toolset family. A `tool` is its own kind (`mvp_tool`, payload key `tool`) —
 * function-like (input/run/result) plus `instructions`/`middleware`. The two AI
 * primitives that persist as `obj_type=toolset` — **MCP servers**
 * (`mcp-server.ts`, `type:"mcp"`) and **agents** (`agent.ts`, `type:"agent"`) —
 * are their own root kinds; both build on the shared {@link encodeToolsetBase}
 * envelope exported here (name/description/instructions/docs/enabled/canonical/
 * spec/tags/tool-refs). Verified against the Xano engine's stored mcp_server and
 * agent formats.
 *
 * Notes from that verification:
 *  - Xano's MCP server has **no** server-level `authentication` field — auth is
 *    per-tool (`tool[].auth`, a stored `json`, engine default `false`).
 *  - Toolset-level middleware is **not** an engine feature: neither transform
 *    reads a `middleware` block, and the tiers that resolve a middleware chain
 *    host only query/function/task/**tool**. The stored empty `middleware`
 *    skeleton is an inert default, emitted here for shape parity but never
 *    authorable.
 */
import { refuseUnknown } from "./def-keys.js";
import type { DiagnosticsFor } from "../workspace/diagnostics.js";
import type { ResultItemXdo, StackItemXdo, InputXdo } from "../types/xdo.js";
import { encodeStack } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { encodeResponse } from "../responses/response.js";
import type { ResponseDef } from "../responses/response.js";
import { encodeInput } from "../inputs/input.js";
import type { InputDescriptor } from "../inputs/input.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { emptyMiddleware, encodeTags } from "./common.js";
import type { MiddlewareBlock } from "./common.js";
import {
  encodeHistory,
  encodeContainerHistory,
  type ContainerHistoryBlock,
  type HistoryInput,
} from "./history.js";
import { buildMiddlewareBlock } from "./middleware-attach.js";
import type { MiddlewareAttach } from "./middleware-attach.js";
import { resolveRef } from "../refs/guid.js";
import type { ObjectRef } from "../refs/guid.js";
import { resolveAuthRef } from "../refs/auth.js";
import type { AuthRef } from "../refs/auth.js";
import { resolveCanonicalToken } from "./canonical.js";
import { assertStoredName, assertCanonical } from "./stored-name.js";
import { emitDiagnostic } from "../workspace/diagnostics.js";
import { brandDef } from "./def-brand.js";
import { encodeIcons, encodeTitle, encodeToolAnnotations } from "./mcp-metadata.js";
import type { McpIcon, McpIconXdo, ToolAnnotations, ToolAnnotationsXdo } from "./mcp-metadata.js";

/** Every key a `{ tool, … }` wrapper reads. */
const TOOL_REF_KEYS = ["tool", "id", "enabled", "auth", "type", "resourceUri", "toolMeta"] satisfies (keyof ToolsetToolRef)[];

// ---------- tool ----------

/**
 * Generic over its input map `I`, branded stack tuple `S`, literal response
 * `Resp`, and declared `Res` — the same carriers `QueryDef` holds, so
 * `InferInput`/`InferResponse` work identically here. All default,
 * so a bare `ToolDef` is unchanged.
 *
 * A tool's response is the value an AGENT reads back, which makes it as
 * client-facing as an endpoint's.
 */
export interface ToolDef<
  I extends Record<string, InputDescriptor> = Record<string, InputDescriptor>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  S extends readonly Statement[] = readonly Statement[],
> {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "tool";
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  instructions?: string;
  docs?: string;
  enabled?: boolean;
  toolsetId?: number;
  /**
   * Human-readable display name MCP clients show instead of `name`
   * (`"Search orders"` for `search_orders`). Omit to show the name.
   */
  title?: string;
  /**
   * Behavior hints for MCP clients (`readOnlyHint`, `destructiveHint`,
   * `idempotentHint`, `openWorldHint`). An unset hint is derived by the
   * platform; a set one overrides it. Hints only — they never change what the
   * tool does.
   */
  annotations?: ToolAnnotations;
  /** Icons MCP clients may show for this tool. See {@link McpIcon} for what `src` accepts. */
  icons?: McpIcon[];
  /**
   * The tool's structured-output schema — the SAME field grammar as `input`.
   * When set, a plain object the tool returns is sent to MCP clients as
   * `structuredContent` (plus a text copy), and a result that does not match
   * the schema becomes a tool error naming the failing field.
   */
  output?: Record<string, InputDescriptor>;
  /** Accepted export warnings for this def ({@link DiagnosticsFor}). Never emitted. */
  diagnostics?: DiagnosticsFor<"tool">;
  tags?: string[];
  /**
   * Request-history capture. Omit to inherit (toolset → workspace). A scalar:
   * `false` off, `true` on at default depth, a number = capture depth, `"all"`
   * unlimited. Any value stops inheriting. See {@link HistoryInput}.
   */
  history?: HistoryInput;
  input?: I;
  /**
   * The tool's statement stack. Captured as the literal tuple `S` (via `tool()`'s
   * `const` inference) so `InferResponse` can trace a response ref back to the
   * statement that bound it; a dynamically-built `Statement[]` widens it and the
   * trace degrades — declare `responseShape` there.
   */
  stack?: S;
  /** What the tool returns to the caller. Captured as the literal `Resp` so
   * `InferResponse` can derive its keys and trace each member. */
  response?: Resp;
  /**
   * Type-only: declare the tool's response shape so `InferResponse<typeof tool>`
   * recovers it exactly, overriding automatic derivation. The runtime value is
   * ignored by `encodeTool`; only its type is read.
   */
  responseShape?: Res;
  /**
   * Pre/post middleware attachment (per-tool — the `tool_pre`/`tool_post`
   * workspace keys). Providing a phase sets its `_customize` flag; an
   * un-customized phase inherits from the workspace. `pre: middleware.clear()`
   * overrides with nothing.
   */
  middleware?: MiddlewareAttach;
}

export interface ToolXdo {
  name: string;
  description: string;
  instructions: string;
  docs: string;
  enabled: boolean;
  output: unknown[];
  middleware: MiddlewareBlock;
  tag: Array<{ tag: string }>;
  history: { inherit: boolean; enabled: boolean; limit: number };
  toolset: { id: number };
  input: InputXdo[];
  result: ResultItemXdo[];
  run: StackItemXdo[];
  test: unknown[];
  /** The MCP metadata — each written only when authored. */
  title?: string;
  annotations?: ToolAnnotationsXdo;
  icons?: McpIconXdo[];
  output_schema?: InputXdo[];
}

/**
 * Any tool def, whatever its inputs/stack/response — the parameter type every
 * consumer that only READS a def wants. `Res` is widened to `unknown` rather
 * than left at the `never` default, which would reject a def that declares
 * `responseShape`; the same widening `encodeQuery` uses.
 */
export type AnyToolDef = ToolDef<Record<string, InputDescriptor>, unknown>;

export function encodeTool(def: AnyToolDef): ToolXdo {
  if (!def.name) throw new Error("tool: `name` is required.");
  // A tool name carries the same stored charset as a query's, and the same
  // silent-NULL on violation — an unnamed tool is one no model can call.
  const owner = `tool "${def.name}"`;
  assertStoredName(owner, def.name, "route");
  const title = encodeTitle(owner, def.title);
  const annotations = encodeToolAnnotations(owner, def.annotations);
  const icons = encodeIcons(owner, def.icons);
  const output = Object.entries(def.output ?? {}).map(([name, d]) => encodeInput(name, d));
  return {
    name: def.name,
    description: def.description ?? "",
    instructions: def.instructions ?? "",
    docs: def.docs ?? "",
    enabled: def.enabled ?? true,
    output: [],
    middleware: buildMiddlewareBlock(def.middleware),
    tag: encodeTags(def.tags),
    history: encodeHistory("tool", def.history),
    toolset: { id: def.toolsetId ?? 0 },
    input: Object.entries(def.input ?? {}).map(([name, d]) => encodeInput(name, d)),
    result: encodeResponse(def.response),
    run: encodeStack("tool", def.name, def.stack),
    test: [],
    // Omitted at their defaults, so a tool that sets none of them keeps the
    // exact bytes it had before they existed.
    ...(title !== undefined ? { title } : {}),
    ...(annotations !== undefined ? { annotations } : {}),
    ...(icons !== undefined ? { icons } : {}),
    ...(output.length > 0 ? { output_schema: output } : {}),
  };
}

export const toolKind: ObjectKind<AnyToolDef, ToolXdo> = {
  name: "tool",
  payloadKey: "tool",
  encode: encodeTool,
};
registerKind(toolKind);

/**
 * Authoring factory for a `tool` — a function-like operation a toolset
 * references. The exact input map, stack tuple, and response are preserved on
 * the return type, so `InferInput`/`InferResponse` recover them.
 */
export function tool<
  const I extends Record<string, InputDescriptor>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  const S extends readonly Statement[] = readonly [],
>(def: ToolDef<I, Res, Resp, S>): ToolDef<I, Res, Resp, S> {
  return brandDef(def, "tool");
}

// ---------- shared toolset internals (used by mcp-server.ts + agent.ts) ----------

/**
 * A tool reference within a toolset.
 *
 * Prefer `tool` — a `tool()` def handle (or its name). It resolves to the
 * tool's guid at export, the same cross-object-reference mechanism the call
 * family uses (`s.tool.call`), so the toolset and the tool's payload `guid`
 * agree and a sync import remaps both together. `id` (a raw numeric engine id)
 * remains as an escape hatch for adopting an existing engine-side toolset.
 */
export interface ToolsetToolRef {
  /** The tool to expose: a `tool()` def handle or its name (resolved to the tool's guid at export). */
  tool?: ObjectRef;
  /** Raw numeric engine id — escape hatch; prefer `tool`. */
  id?: number;
  enabled?: boolean;
  /**
   * Per-tool auth — the only auth surface a toolset has (there is no
   * server-level gate). Name an auth **table** (a `table({ auth: true })` def or
   * its name) and it resolves to that table's guid at export; a raw numeric
   * `dbo.id` is the escape hatch, and `false`/omitted means no auth.
   *
   * ⚠ It is also what gives the tool's stack a CALLER, on an `agent()` exactly
   * as on an `mcpServer()`. `auth()` inside a tool whose entry names no table
   * does NOT return null: the tool call answers a NORMAL result carrying
   * `{"code":"ERROR_FATAL","message":""}`, so the model reads a successful tool
   * result and reports success while nothing is written. A caller token does not
   * rescue it — the entry is what supplies identity, so this cannot be fixed
   * from the client side. Any tool reading `auth()` wants
   * `{ tool: saveNote, auth: users }`; `export()` warns
   * (`toolset.tool-reads-auth-ungated`) when one does not have it.
   */
  auth?: AuthRef;
  /**
   * What this entry publishes the target as: a callable **tool** (the default),
   * or an MCP **resource**.
   *
   * An MCP server that only ever sets tools exposes tools and no resources —
   * which is what every toolset this SDK could author did, because the entry had
   * no way to say otherwise. A resource entry needs {@link resourceUri} too; the
   * engine refuses any spelling but these two, deliberately, because a typo
   * coerced to `"tool"` would silently republish a resource as a tool and change
   * what the server advertises.
   */
  type?: "tool" | "resource";
  /**
   * The URI a `type: "resource"` entry is addressed by (`file:///notes/{id}`,
   * `https://…`). Meaningful only on a resource; the engine drops a stale one
   * left on a tool entry, and so does this encoder.
   */
  resourceUri?: string;
  /**
   * Extra MCP metadata for a `type: "tool"` entry, carried verbatim. Meaningful
   * only on a tool; the engine drops a stale one left on a resource entry.
   */
  toolMeta?: string;
}

/**
 * One entry of a toolset's `tools`: a bare `tool()` handle (or its name) for the
 * common case, or a {@link ToolsetToolRef} wrapper when `enabled`/`auth` are
 * needed.
 *
 * The bare form exists because every other collection in the SDK takes handles
 * directly (`registerTools([saveNote])`, `bind: [{ table: users }]`), so
 * `tools: [saveNote]` is the spelling authors reach for by analogy — and the
 * wrapper's fields are all optional, so TypeScript's weak-type check let a bare
 * handle through and the export emitted `id: 0`, a null reference.
 * Normalizing here removes the failure mode rather than documenting around it.
 */
export type ToolsetToolEntry = ToolsetToolRefEntry | ToolDef | string;

/**
 * A {@link ToolsetToolRef} as an entry: `type: "resource"` REQUIRES its
 * `resourceUri` at compile time — without one the entry is refused at export,
 * since an unaddressed resource publishes nothing — and each type refuses the
 * other's payload field, which the engine drops.
 */
export type ToolsetToolRefEntry = ToolsetToolRef &
  ({ type?: "tool"; resourceUri?: undefined } | { type: "resource"; resourceUri: string; toolMeta?: undefined });

/** Encoded tool reference: `id` carries the resolved guid; `auth` the resolved auth-table guid / dbo.id / `false`. */
interface ToolsetToolXdo {
  id: number | string;
  enabled: boolean;
  auth: false | number | string;
  /**
   * The three FR-1196 connection fields, all presence-preserving.
   *
   * Live-verified: a deployed toolset whose entries carry them exports back with
   * `type`/`resource_uri` on the resource entry and `tool_meta` on the tool one.
   *
   * An engine-captured entry carries `{id, auth, enabled}` and nothing else, so
   * writing these unconditionally would add keys the engine never wrote to every
   * existing workspace. They appear only when the author sets one — and, like
   * the engine's own transform, `resource_uri` rides only a resource and
   * `tool_meta` only a tool, so a value left over from flipping `type` is
   * dropped rather than persisted against the wrong kind of entry.
   */
  type?: "tool" | "resource";
  resource_uri?: string;
  tool_meta?: string;
}

/**
 * Normalize one authored entry to the wrapper shape. A bare handle/name becomes
 * `{ tool: entry }`; a wrapper passes through. An object that is neither (no
 * `tool`/`id`, no `name`) can only encode to the `id: 0` null reference, so it
 * throws here rather than shipping.
 */
function normalizeToolEntry(entry: ToolsetToolEntry, index: number, owner: string): ToolsetToolRef {
  if (typeof entry === "string") return { tool: entry };
  if (entry === null || typeof entry !== "object") {
    throw new Error(
      `${owner} \`tools[${index}]\`: expected a \`tool()\` handle, a tool name, or a ` +
        `{ tool, enabled?, auth? } wrapper (got ${entry === null ? "null" : typeof entry}).`,
    );
  }
  const ref = entry as ToolsetToolRef & { name?: unknown };
  if (ref.tool !== undefined || ref.id !== undefined) {
    // A misspelt `auth` was dropped, shipping the tool with no caller.
    refuseUnknown(`${owner} \`tools[${index}]\``, ref, TOOL_REF_KEYS);
    return ref;
  }
  // A `tool()` def handle: its own `name` is what identifies it. Only the
  // reference is taken — a `ToolDef` also carries `enabled`, but that is the
  // TOOL's own switch, not "is this toolset exposing it", and quietly reading it
  // as the latter would make a disabled tool silently disable its own ref.
  if (typeof ref.name === "string" && ref.name !== "") {
    return { tool: ref as { name: string; guid?: string } };
  }
  // `{ tol: t }` is a wrapper with a misspelt key — name the key it meant
  // rather than saying the entry names no tool.
  if (ref.name === undefined) refuseUnknown(`${owner} \`tools[${index}]\``, ref, TOOL_REF_KEYS);
  throw new Error(
    `${owner} \`tools[${index}]\`: names no tool. Pass the \`tool()\` handle (\`tools: [saveNote]\`), ` +
      `its name, or a wrapper (\`{ tool: saveNote, auth: users }\`). An entry with neither \`tool\` ` +
      `nor \`id\` encodes to \`id: 0\` — a reference to nothing, which deploys as a toolset whose ` +
      `tool is silently missing.`,
  );
}

/** Resolve a list of {@link ToolsetToolEntry}s to their stored `tool[]` entries. */
export function encodeToolRefs(tools?: ToolsetToolEntry[], owner = "toolset"): ToolsetToolXdo[] {
  return (tools ?? []).map((entry, index) => {
    const t = normalizeToolEntry(entry, index, owner);
    if (t.tool !== undefined && t.id !== undefined) {
      throw new Error(`${owner} \`tools[${index}]\`: set either \`tool\` (handle/name) or \`id\` (raw), not both.`);
    }
    const id = t.tool !== undefined ? resolveRef("tool", t.tool) : (t.id ?? 0);
    // Engine ids start at 1, so 0 is never a tool: the entry is structurally
    // valid and references nothing, and the toolset deploys with a tool it can
    // never call. WARNS rather than throws, on the same grounds as a middleware
    // `input`: `codegen` emits this shape for a stored `id: 0` — which is what
    // older SDKs persisted for a bare handle — and refusing it would make such a
    // workspace impossible to pull, edit and push back. The way to author one is
    // a deliberate `{ id: 0 }`; every other spelling resolves.
    if (id === 0 || id === "" || id === "0") {
      emitDiagnostic({
        severity: "warning",
        code: "toolset.tool-ref-zero",
        message:
          `${owner} \`tools[${index}]\` is \`id: 0\`, which references no tool — engine ids start ` +
          `at 1. It deploys as a tool entry pointing at nothing, so the toolset simply never ` +
          `calls it, with no error anywhere. Pass the \`tool()\` handle (\`tools: [saveNote]\`) so ` +
          `the reference resolves to its guid.`,
      });
    }
    const label = typeof t.tool === "string" ? t.tool : (t.tool?.name ?? String(t.id ?? "?"));
    const type = t.type ?? "tool";
    // A resource with no URI is addressable by nothing: the server advertises it
    // and every read misses. The engine drops an empty `resource_uri` rather
    // than refusing, so the only place this can be caught is here.
    if (type === "resource" && !t.resourceUri) {
      throw new Error(
        `${owner} \`tools[${index}]\` (${label}) is \`type: "resource"\` with no \`resourceUri\`. ` +
          `A resource is addressed BY its URI, so one without it is published and unreachable. ` +
          `Give it a URI, or drop \`type\` to publish the target as a callable tool.`,
      );
    }
    // The two payload fields are per-type, and the engine drops the one that
    // does not match. Silently dropping an author's value is how a `type` flip
    // loses configuration, so say it instead.
    const stale = type === "resource" ? (t.toolMeta ? "toolMeta" : "") : (t.resourceUri ? "resourceUri" : "");
    if (stale !== "") {
      throw new Error(
        `${owner} \`tools[${index}]\` (${label}) is \`type: "${type}"\` and sets \`${stale}\`, which ` +
          `belongs to the other type — the engine stores it against neither. Remove it, or ` +
          `change \`type\`.`,
      );
    }
    return {
      id,
      enabled: t.enabled ?? true,
      auth: resolveAuthRef("toolset tool", label, t.auth),
      // `"tool"` is the engine's default and is omitted at it, so an ordinary
      // entry keeps the exact bytes a pulled one has.
      ...(type === "resource" ? { type } : {}),
      ...(type === "resource" && t.resourceUri ? { resource_uri: t.resourceUri } : {}),
      ...(type === "tool" && t.toolMeta ? { tool_meta: t.toolMeta } : {}),
    };
  });
}

/**
 * Fields shared by every toolset-family primitive (MCP server + agent). The
 * type-specific encoders add `type` and, for agents, `agent_settings`.
 * `instructions` is a stored column for both but only authorable on MCP servers
 * (Xano's `Agent` transform has no `instructions` field), so `AgentDef` simply
 * omits it and it stays `""`.
 */
export interface ToolsetBaseDef {
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  instructions?: string;
  docs?: string;
  enabled?: boolean;
  canonical?: string;
  spec?: string;
  tags?: string[];
  /**
   * Toolset-level request-history default — the container tier its tools inherit
   * from (stored `tool_enabled`/`tool_limit`), and on an MCP server its prompts
   * and resources too. Omit to inherit from the workspace. A scalar: `false` off, `true` on at default depth, a number =
   * capture depth, `"all"` unlimited. See {@link HistoryInput}.
   */
  history?: HistoryInput;
  /**
   * The tools this toolset exposes. Each entry is a bare `tool()` handle (or its
   * name), or a `{ tool, enabled?, auth? }` wrapper when a tool needs per-tool
   * auth or to be disabled. See {@link ToolsetToolEntry}.
   */
  tools?: ToolsetToolEntry[];
  /** Accepted export warnings for this def ({@link DiagnosticsFor}). Never emitted. */
  diagnostics?: DiagnosticsFor<"mcp_server">;
}

/** The shared toolset envelope — everything except the type discriminator and agent-only `agent_settings`. */
export interface ToolsetBaseXdo {
  name: string;
  description: string;
  instructions: string;
  docs: string;
  enabled: boolean;
  canonical: string;
  spec: string;
  middleware: MiddlewareBlock;
  history: ContainerHistoryBlock<"tool">;
  tag: Array<{ tag: string }>;
  tool: ToolsetToolXdo[];
}

/**
 * Resolve a toolset's `canonical` URL token — the public token an MCP server's
 * endpoint URL (or an agent's addressable identity) is built from. Mirrors
 * `query`'s `resolveCanonical` exactly, in priority order:
 *   1. an explicit `{ canonical }` override;
 *   2. the def's non-empty in-code `canonical`;
 *   3. the canonical minted-and-frozen in `xano.lock` under `toolset:<name>`
 *      (toolsets carry a mintable canonical, like api groups — see
 *      `CANONICAL_PAYLOAD_KEYS` in `lock/lock.ts`), read via the seeded override
 *      store (populated by `seedLockOverrides`).
 *
 * We deliberately do NOT mint here: a canonical is unique per Xano *instance
 * across all workspaces*, so the only safe place to generate one is
 * an ordinary `xanosdk export` (random, collision-checked, then frozen so every later export
 * and every client agrees). When nothing resolves we throw with the fix.
 */
export function resolveToolsetCanonical(
  def: { name: string; canonical?: string },
  override?: string,
): string {
  return resolveCanonicalToken("toolset", "toolset", "getPath", def, override);
}

/**
 * Build the shared toolset envelope. Assumes `def.name` is set — each kind's
 * encoder validates `name` first so it can throw a kind-specific message.
 * `middleware` is the inert empty skeleton (toolset-level middleware is not an
 * engine feature — see the module header); `spec` is a stored column the
 * XanoScript transform ignores, kept for DBO shape parity.
 */
/**
 * `label` names the kind the author actually wrote. Agents and MCP servers are
 * one stored object discriminated by `type`, so they share this encoder — but
 * "toolset" is not a word either author typed, and an error naming it points at
 * a factory that does not exist in their file.
 */
export function encodeToolsetBase(def: ToolsetBaseDef, label = "toolset"): ToolsetBaseXdo {
  assertCanonical(`${label} "${def.name}"`, def.canonical);
  return {
    name: def.name,
    description: def.description ?? "",
    instructions: def.instructions ?? "",
    docs: def.docs ?? "",
    enabled: def.enabled ?? true,
    canonical: def.canonical ?? "",
    spec: def.spec ?? "",
    middleware: emptyMiddleware(),
    history: encodeContainerHistory("tool", def.history),
    tag: encodeTags(def.tags),
    tool: encodeToolRefs(def.tools, `${label} "${def.name}"`),
  };
}

// ---------- MCP server prompt / resource references ----------

/**
 * The wrapper form of an MCP server's prompt or resource entry. `prompt` /
 * `resource` names the target (a def handle or its name, resolved to its guid
 * at export); `id` is the raw numeric escape hatch. `auth` works exactly as on a
 * tool entry: it names the auth table whose token a client must send, and it is
 * what gives the stack a caller.
 */
export type McpPrimitiveRef<K extends "prompt" | "resource"> = { [P in K]?: ObjectRef } & {
  /** Raw numeric engine id — escape hatch; prefer the handle. */
  id?: number;
  /** `false` keeps the entry but stops exposing it. */
  enabled?: boolean;
  auth?: AuthRef;
};

/**
 * One entry of an MCP server's `prompts` / `resources`: a bare `prompt()` /
 * `resource()` handle (or its name), or a {@link McpPrimitiveRef} wrapper when
 * the entry needs `auth` or to be disabled.
 */
export type McpPrimitiveEntry<K extends "prompt" | "resource"> = McpPrimitiveRef<K> | { name: string; guid?: string } | string;

/** Stored prompt/resource reference — `id` carries the resolved guid. */
export interface McpPrimitiveXdo {
  id: number | string;
  enabled: boolean;
  auth: false | number | string;
}

/** Resolve an MCP server's `prompts` or `resources` to their stored entries. */
export function encodePrimitiveRefs<K extends "prompt" | "resource">(
  kind: K,
  entries: readonly McpPrimitiveEntry<K>[] | undefined,
  owner: string,
): McpPrimitiveXdo[] {
  if (entries === undefined) return [];
  const field = `${kind}s`;
  if (!Array.isArray(entries)) throw new Error(`${owner} \`${field}\`: expected a list of \`${kind}()\` handles.`);
  const keys = [kind, "id", "enabled", "auth"];
  const seen = new Map<string | number, number>();
  return entries.map((entry, index) => {
    const at = `${owner} \`${field}[${index}]\``;
    let ref: McpPrimitiveRef<K>;
    if (typeof entry === "string") {
      ref = { [kind]: entry } as McpPrimitiveRef<K>;
    } else if (entry === null || typeof entry !== "object") {
      throw new Error(`${at}: expected a \`${kind}()\` handle, a name, or a { ${kind}, enabled?, auth? } wrapper.`);
    } else {
      const record = entry as Record<string, unknown>;
      if (record[kind] !== undefined || record.id !== undefined) {
        refuseUnknown(at, record, keys);
        ref = entry as McpPrimitiveRef<K>;
      } else if (typeof record.name === "string" && record.name !== "") {
        // A def handle: only the reference is taken, as for a tool.
        ref = { [kind]: entry } as McpPrimitiveRef<K>;
      } else {
        refuseUnknown(at, record, keys);
        throw new Error(`${at}: names no ${kind}. Pass the \`${kind}()\` handle, its name, or { ${kind}: handle, auth? }.`);
      }
    }
    const target = (ref as Record<string, unknown>)[kind] as ObjectRef | undefined;
    if (target !== undefined && ref.id !== undefined) throw new Error(`${at}: set either \`${kind}\` or \`id\`, not both.`);
    const id = target !== undefined ? resolveRef(kind, target, at) : (ref.id ?? 0);
    if (id === 0) throw new Error(`${at}: \`id: 0\` references no ${kind} — engine ids start at 1. Pass the \`${kind}()\` handle.`);
    // The engine keys an entry by its target, so a second one for the same
    // target would silently shadow the first's `enabled`/`auth`.
    const first = seen.get(id);
    if (first !== undefined) throw new Error(`${at}: lists the same ${kind} as \`${field}[${first}]\`. List each ${kind} once.`);
    seen.set(id, index);
    const label = typeof target === "string" ? target : (target?.name ?? String(ref.id));
    return { id, enabled: ref.enabled ?? true, auth: resolveAuthRef(`mcpServer ${kind}`, label, ref.auth) };
  });
}
