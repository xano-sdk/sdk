/**
 * Per-kind decoders — stored object envelope → an authoring def literal.
 *
 * Each kind is declared as a table of `{ def, stored, fallback }` entries that
 * mirrors its encoder one key at a time, plus the handful of shared blocks that
 * need real inversion (tags, history, middleware, inputs, response, stack). A key
 * whose stored value equals what the encoder writes by default is **elided**,
 * which is most of what makes generated defs readable. Elision is safe
 * by construction here: it is derived from the encoder's own default, not from a
 * per-field judgement call, and the whole-workspace round trip proves it.
 *
 * Each kind names the `factory` its def literal is wrapped in — `table(…)`,
 * `defineFunction(…)`, and so on. This is not cosmetic. The def *types* carry
 * their parameters as phantom optional props, so a bare `{…} satisfies TableDef`
 * binds `TableDef<string, unknown>` and every downstream inference degrades with
 * it: `ColsOf` collapses to `string` (no column checking on `fieldName`/`output`/
 * `sortBy`), `InferInput` loses a query's branded payload, and an agent's output
 * schema stops typing `s.ai.agent.run`. The factories declare `const` parameters
 * that recover all of it, and `examples/sandbox` already authors this way — so a
 * factory call is both better-typed and the shape the docs teach.
 *
 * A kind with no `factory` falls back to `… satisfies <defType>`. That is the
 * escape hatch for kinds whose factory takes a *different* shape than the def it
 * returns and cannot be inverted faithfully.
 *
 * The choice is not always the same for every object of a kind. A trigger's
 * factory depends on its `obj_type` (and, for `toolset`, on what the bound guid
 * points at), and some stored shapes have no faithful factory form at all. Such a
 * kind returns a {@link DecodedDef} from `decode` — its entries plus the factory
 * THAT object is wrapped in — and `undefined` there means the object takes the
 * `satisfies` fallback while its siblings still get their factory.
 *
 * That per-object refusal is the second reason a kind declines its factory, and
 * the more important one: it is not a decoder gap but the safety property. A
 * factory whose arguments cannot express what an object stores would emit a call
 * that compiles and deploys something DIFFERENT. Preferring the better-typed form
 * only where it is provably equivalent — and reporting every refusal — is what
 * makes preferring it safe at all. See {@link triggerFactoryArgs}.
 */
import type { DecodeContext } from "../context.js";
import { CODEGEN_MODULE, SDK_MODULE } from "../context.js";
import { arr, arrow, call, id, lit, obj, type Expr } from "../print.js";
import type { GeneratedFile } from "../index.js";
import { isOsMetadataRow, type KnowledgeType } from "../../kinds/knowledge.js";
import {
  knowledgeBodyPath,
  knowledgeRefsDir,
} from "../../kinds/knowledge-paths.js";
import type { RefIndex, ResolveOptions } from "../ref-index.js";
import { resolveReference } from "../ref-index.js";
import { decodeFieldMap, decodeResponse, decodeTableSchema, deepEqual } from "../field.js";
import { decodeStack } from "../statement.js";
import { decodeCondition } from "../expression.js";
import {
  isDefaultEnvelopeMember,
  isEmptyOutput,
  isBlankAgentSettings,
  normalize,
} from "../../validate/normalize.js";
import { WORKSPACE_HISTORY_TYPES, type ContainerPrefix } from "../../kinds/history.js";
import {
  encodeTrigger,
  errorTrigger,
  mcpServerTrigger,
  agentTrigger,
  realtimeTrigger,
  realtimeChannelTrigger,
  realtimeServerTrigger,
  tableTrigger,
  workspaceTrigger,
} from "../../kinds/trigger.js";
import { SYSTEM_COLUMN_NAMES, elideSystemIndexes } from "../../kinds/table.js";
import type { IndexDef } from "../../kinds/table.js";
import type { DatabaseActions, TriggerDef } from "../../kinds/trigger.js";
import type { ToolsetType, TriggerInputObjType } from "../../kinds/trigger-inputs.js";
import type { Condition } from "../../statements/expression.js";
import { rewriteTriggerInputRefs } from "./trigger-handle-refs.js";
import { parsePathParams, unboundPathParams } from "../../kinds/path-params.js";
import { ENGINE_HISTORY_LIMIT } from "../../validate/normalize.js";
import { DEFAULT_DOCUMENTATION, DEFAULT_PREFERENCES, DEFAULT_SETTINGS } from "../../kinds/workspace-config.js";
import { isWorkspaceKeyAtDefault, subtractDefaults } from "../omissions.js";
import {
  apiGroupScope,
  documentationScopeLabel,
  type DocumentationScope,
} from "../../workspace/documentation-token.js";
import { acceptedOnDecode } from "../accept-on-decode.js";
import { TOOL_ANNOTATION_WIRE } from "../../kinds/mcp-metadata.js";
import { MCP_OAUTH_ENV_REF } from "../../kinds/mcp-oauth.js";
import { decodeExample, decodeTests } from "../test.js";
import { HOSTED_FILE_SCHEME } from "../../fields/hosted-file.js";

/** One `key: value` pair of a generated def literal. */
export type DefEntry = readonly [string, Expr];

/** A stored object as read from a bundle payload array. */
export type StoredObject = Record<string, unknown>;

/** Everything a kind decoder needs beyond the object itself. */
export interface KindDecodeArgs {
  readonly ctx: DecodeContext;
  readonly refs: RefIndex;
  readonly stored: StoredObject;
  readonly resolve: ResolveOptions;
  /**
   * The whole bundle payload, for a kind whose decode needs a SIBLING section —
   * `knowledge` selects its reference-file rows out of `knowledge_file` by
   * parent guid. Most decoders never touch it.
   */
  readonly payload: Record<string, unknown>;
}

/**
 * A decoded def when the kind picks its factory per object rather than per kind.
 *
 * Returned from `decode` instead of a bare entry list. `factory: undefined` is
 * the deliberate fallback signal, not a missing value — the emitter wraps the
 * entries in `satisfies <defType>` and the object still round-trips.
 */
export interface DecodedDef {
  readonly entries: readonly DefEntry[];
  /** The factory THIS object is wrapped in; `undefined` → `satisfies`. */
  readonly factory?: string;
}

/** A registered kind decoder. */
export interface KindDecoder {
  /** Kind name, matching the encode-side registry. */
  readonly name: string;
  /** Payload array the kind lands in. */
  readonly payloadKey: string;
  /**
   * Directory the generated file goes in — the DEFAULT, which placement may
   * nest further: a query lands under its api group, a trigger under what it
   * fires on, and every table collapses into one file. See `place()`.
   */
  readonly dir: string;
  /** The `Xano.register*` method the barrel calls. */
  readonly register: string;
  /** The exported def type, imported `type`-only when there is no {@link factory}. */
  readonly defType: string;
  /**
   * The exported factory EVERY object of this kind is wrapped in, imported as a
   * value. Omitted both by kinds that always fall back to `satisfies` and by
   * kinds that choose per object — those return the name from `decode` instead
   * (see the module header).
   */
  readonly factory?: string;
  /**
   * Build the def literal's entries. Returning a bare list takes the kind-wide
   * {@link KindDecoder.factory}; returning a {@link DecodedDef} chooses per object.
   */
  decode(args: KindDecodeArgs): DefEntry[] | DecodedDef;
  /**
   * Extra NON-TypeScript files this object contributes to the tree, if any.
   *
   * `knowledge` is the first kind whose payload is prose rather than
   * configuration: its def points at a markdown file by path, so a pulled tree
   * has to carry that file or the def it sits beside re-exports empty. Paths are
   * relative to the kind's {@link KindDecoder.dir}.
   */
  companions?(args: { stored: StoredObject; payload: Record<string, unknown> }): GeneratedFile[];
}

/**
 * The `knowledge_file` rows belonging to one item.
 *
 * Reference files ride the bundle as their own top-level section, each row
 * naming its parent by guid — they are NOT nested on the item — so selecting
 * them needs the whole payload rather than just the stored object.
 */
function knowledgeFileRows(
  payload: Record<string, unknown>,
  parentGuid: unknown,
): Array<{ path: string; content: string }> {
  const rows = Array.isArray(payload.knowledge_file) ? payload.knowledge_file : [];
  const out: Array<{ path: string; content: string }> = [];
  for (const raw of rows) {
    const row = raw as { knowledge?: { id?: unknown }; path?: unknown; content?: unknown };
    if (row.knowledge?.id !== parentGuid) continue;
    const stored = typeof row.path === "string" ? row.path : "";
    if (stored === "") continue;
    // Not written, as an export would not ship it — the decode reports it.
    if (isOsMetadataRow(raw)) continue;
    // The platform prefixes stored paths with `knowledge-refs/<item>/`. That is
    // its storage detail, not something an author wrote, so it comes back off.
    const rel = stored.replace(/^knowledge-refs\/[^/]+\//, "");
    out.push({ path: rel, content: String(row.content ?? "") });
  }
  return out;
}

// --- shared inverses ---------------------------------------------------------

/** Emit `key: <stored>` unless the stored value is the encoder's default. */
function plain(stored: StoredObject, storedKey: string, fallback: unknown, defKey = storedKey) {
  const value = stored[storedKey];
  if (value === undefined || deepEqual(value, fallback)) return null;
  return [defKey, lit(value)] as DefEntry;
}

/**
 * Emit `key: <stored>` whenever it is present, unless it holds the value the
 * engine writes for an untouched workspace ({@link isWorkspaceKeyAtDefault}).
 *
 * The inverse of a presence-preserving encoder, which is what the `?=`-optional
 * workspace blocks have: "the stored value equals the default" and "the key is
 * absent" really are different bytes there, so a plain default comparison
 * ({@link plain}) would let only one of the two spellings round-trip.
 *
 * Presence ALONE was the rule, and it emitted every one of those keys on every
 * pull, because the engine materializes them all on save — all 177 workspaces in
 * the sweep carry `defaults: {db_primary_key: "int"}` and `datasource_live:
 * {color: "#008000", show_banner: false}`. Neither is a byte an author would type
 * or a reader can act on, and dropping them is only safe because verification
 * reads the same table (see `WORKSPACE_DEFAULTED_KEYS`) and treats the absence as
 * equal rather than as a missing key.
 */
function atDefault(stored: StoredObject, storedKey: string, defKey = storedKey): DefEntry | null {
  const value = stored[storedKey];
  if (value === undefined || isWorkspaceKeyAtDefault(storedKey, value)) return null;
  return [defKey, lit(value)];
}

/**
 * The `documentation` block, with the GATE declared and the token left out.
 *
 * A pull writes source people commit, so the one member that must never land
 * there is the token. What stays is `require_token: true`, which is both the
 * engine's own field and the declaration that a value exists; the value rides
 * out on `GeneratedProject.documentationTokens` and the CLI writes it to
 * `xano/.secrets.json`, keyed by this scope's identity.
 *
 * No variable name is emitted, and none is derived. That whole layer existed to
 * give an object-scoped secret a place in a flat namespace, and keying the
 * sidecar by the scope itself removed the need for it — along with the case it
 * could not handle, a group whose name sanitized to nothing representable.
 *
 * A REPORT LINE every time, on the same channel the microservice registry
 * credential uses. A secret moving out of the tree and into an ignored file is
 * worth saying out loud on every pull — the whole class of defect this closes is
 * the kind that happens quietly.
 *
 * `defaulted` decides what counts as "nothing to write". The two scopes differ:
 * a workspace block at the engine default is dropped entirely (omission leaves
 * the target's alone), where an API group's is dropped only because
 * `encodeApiGroup` writes the identical default back — an absent key on a group
 * is written as the engine default on import, so the bytes are the same either
 * way.
 */
function documentationEntry(
  a: KindDecodeArgs,
  scope: DocumentationScope,
  defaulted: (value: unknown) => boolean,
): DefEntry | null {
  const stored = a.stored.documentation;
  if (stored === undefined || stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return null;
  }
  if (defaulted(stored)) return null;
  const block = stored as Record<string, unknown>;
  const token = typeof block.token === "string" ? block.token : "";
  const cells: Array<[string, Expr]> = [];
  for (const [key, member] of Object.entries(block)) {
    if (key === "token") continue;
    cells.push([key, lit(member)]);
  }
  if (token !== "") {
    // `require_token` is emitted EXACTLY AS STORED, and the token's presence
    // never argues with it. The two are independent fields: the engine reads a
    // token with `require_token: false` as not gated — its own warning says a
    // token without `require_token` is not a gate — so a workspace can hold a
    // value with the gate switched off, and that is a state to reproduce rather
    // than to correct.
    //
    // Forcing `require_token: true` whenever a token is present would cost
    // twice. The round trip could never verify for such a workspace, because
    // the re-export would say `true` where the source said `false`; and a tree
    // deployed past that check would GATE a doc site the target had
    // deliberately left open. What makes the forcing unnecessary is that
    // resolution keys off a block naming no token (see
    // `resolveDocumentationBlock`), not off the gate being declared, so the
    // sidecar value is substituted back either way.
    //
    // The wording follows `require_token` too. A fresh workspace stores a token
    // with the gate OFF, and a deploy counts only gated scopes as needing a
    // value — saying "deploy refuses" for one of those is a claim no deploy makes.
    const gated = block.require_token === true;
    // One wording whatever `--no-secrets` says. This text lands in the decoded
    // README, and a README that changed with the flag made a pull of an
    // unchanged backend rewrite it (xano-sdk/sdk-dev#10). What THIS run wrote
    // is the CLI's warning to say, not the tree's.
    const sidecar = `\`${a.ctx.secretsFile}\``;
    a.ctx.problem(
      "expected-omission",
      gated
        ? `${documentationScopeLabel(scope)} gates its documentation with a token, which is a SECRET ` +
            `and is not carried into the generated tree. The source declares the gate. A decode writes the ` +
            `value to ${sidecar} (gitignored), and every command that builds a bundle reads it back, so a ` +
            `deploy restores the gate with no further step. A decode run with \`--no-secrets\` does not ` +
            `write it: supply it at deploy time with \`--doc-token\` or \`--secrets-file\`. Until the ` +
            `value is supplied, \`deploy\` refuses rather than clearing the live token.`
        : `${documentationScopeLabel(scope)} stores a documentation token with \`require_token: false\` — ` +
            `the documentation is not gated. The token is a SECRET and is not carried into the generated tree. ` +
            `A decode writes it to ${sidecar} (gitignored) so a deploy carries it across; a decode run ` +
            `with \`--no-secrets\` does not. A deploy does not need it.`,
    );
  }
  return cells.length === 0 ? null : ["documentation", obj(cells)];
}

/**
 * The workspace's block: dropped only when it is the engine's MATERIALIZED
 * default — every member present (`token`, `whitelist`, `require_token`) and at
 * its default, the block every untouched pulled workspace carries.
 *
 * An authored block is written as authored (`{ require_token: false }` stores
 * just that key), so a block present with fewer members is the author's
 * explicit "docs open" and is kept. Dropping it changed what a deploy does:
 * omitted leaves the target's gate alone, an authored `false` turns it off.
 */
function documentation(a: KindDecodeArgs): DefEntry | null {
  return documentationEntry(
    a,
    { kind: "workspace" },
    (v) =>
      isWorkspaceKeyAtDefault("documentation", v) &&
      Object.keys(DEFAULT_DOCUMENTATION).every((key) => Object.hasOwn(v as object, key)),
  );
}

/** An API group's block: dropped only when `encodeApiGroup` writes it back. */
function apiGroupDocumentation(a: KindDecodeArgs): DefEntry | null {
  return documentationEntry(a, apiGroupScope(a.stored), (v) =>
    deepEqual(v, { require_token: false, token: "" }),
  );
}

/** `tag: [{tag}]` → `tags: ["…"]`, elided when empty. */
function tags(stored: StoredObject): DefEntry | null {
  const value = stored.tag;
  if (!Array.isArray(value) || value.length === 0) return null;
  return ["tags", lit(value.map((t) => (t as { tag: string }).tag))];
}

/** Object types whose request-history default is OFF (mirrors `common.ts`). */
const HISTORY_DEFAULT_OFF = new Set(["function", "middleware", "trigger", "message"]);


/**
 * `{inherit, enabled, limit}` → the scalar authoring surface, elided when it is
 * the kind's inherit default. Returns `undefined` for a stored block no scalar
 * produces (e.g. disabled with a custom limit), so the caller can report it.
 */
function historyScalar(block: unknown): boolean | number | "all" | null | undefined {
  const value = block as { inherit?: boolean; enabled?: boolean; limit?: number } | undefined;
  if (value === undefined) return null;
  // An INHERITING block takes its setting from the parent tier, which makes its
  // own `enabled`/`limit` inert — so there is nothing to spell, whatever they
  // hold. `normalize` already drops any inheriting block for that same reason,
  // so requiring them at the tier default here reported 27 real objects as
  // unauthorable that the byte comparison had already ruled equal. The stored
  // members drift two ways in the wild: an older save omits `limit` entirely,
  // and a block toggled back to inherit keeps whatever it last held.
  if (value.inherit === true) return null;
  if (value.inherit !== false) return undefined;
  // An ABSENT limit IS the engine default: every limit read in the engine's
  // history resolver is `?? 100`, at every tier, and the corpus holds the two
  // spellings side by side on the same key. `normalize` fills it in from the
  // same constant, so the scalar this recovers and the bytes the comparison
  // accepts cannot disagree.
  const limit = value.limit ?? ENGINE_HISTORY_LIMIT;
  if (value.enabled === false) return limit === ENGINE_HISTORY_LIMIT ? false : undefined;
  if (limit === -1) return "all";
  if (limit === ENGINE_HISTORY_LIMIT) return true;
  return typeof limit === "number" && limit >= 0 ? limit : undefined;
}

/** `history:` for an object-tier kind. */
function history(args: KindDecodeArgs): DefEntry | null {
  // An ARRAY here is not a settings block at all — it is the engine's own record
  // of past runs (`on`, `duration`, `debugger`), which no authoring surface
  // produces and none should. Declining to copy run telemetry into a committed
  // source tree is correct, so it is reported as a deliberate omission rather
  // than as a block the scalar surface failed to spell.
  if (Array.isArray(args.stored.history)) {
    args.ctx.problem(
      "expected-omission",
      "history holds engine-recorded run telemetry, which is not authored data (server-managed)",
    );
    return null;
  }
  const scalar = historyScalar(args.stored.history);
  if (scalar === null) return null;
  if (scalar === undefined) {
    args.ctx.problem(
      "verify-mismatch",
      `history block ${JSON.stringify(args.stored.history)} has no scalar authoring form`,
    );
    return null;
  }
  return ["history", lit(scalar)];
}

/**
 * `history:` for a container-tier kind — `app` uses `query_*`, toolsets `tool_*`,
 * and a realtime server / channel `message_*`.
 */
function containerHistory(args: KindDecodeArgs, prefix: ContainerPrefix): DefEntry | null {
  const block = args.stored.history as Record<string, unknown> | undefined;
  if (block === undefined) return null;
  const normalized = {
    inherit: block.inherit,
    enabled: block[`${prefix}_enabled`],
    limit: block[`${prefix}_limit`],
  };
  const scalar = historyScalar(normalized);
  if (scalar === null) return null;
  if (scalar === undefined) {
    args.ctx.problem(
      "verify-mismatch",
      `${prefix} history block ${JSON.stringify(block)} has no scalar authoring form`,
    );
    return null;
  }
  return ["history", lit(scalar)];
}

/** One stored `mvp:middleware` attachment → its authoring entry. */
function middlewareEntry(args: KindDecodeArgs, entry: unknown): Expr {
  const guid = (entry as { context?: { middleware?: { id?: unknown } } })?.context?.middleware?.id;
  const disabled = (entry as { disabled?: boolean }).disabled === true;

  // A BLANK binding — a middleware slot never bound, or whose target was
  // deleted. There is no reference to render, so the authoring forms cannot
  // spell it: emitting `{name: "", guid: ""}` produced a tree the exporter then
  // refused, leaving no way to re-export a pulled workspace short of hand-editing
  // every affected file — which `xano/` being regenerable then discards.
  //
  // Carried verbatim instead. The bytes round-trip, and the defect is reported
  // as what it is: something wrong in the WORKSPACE, not a decoder that failed.
  if (guid === "" || guid === undefined || guid === null) {
    args.ctx.problem(
      "blank-binding",
      "a middleware attachment is bound to nothing — the slot was never bound, or its target was " +
        "deleted. It cannot run as stored; bind it in the editor or remove it. Carried verbatim so " +
        "the workspace re-exports as it was pulled",
    );
    args.ctx.use(CODEGEN_MODULE, "raw");
    return call("raw", lit(entry));
  }

  const ref =
    typeof guid === "string"
      ? resolveReference(args.ctx, args.refs, guid, {
          ...args.resolve,
          unresolved: "object-ref",
        })
      : lit(guid);
  // `active: false` is the only non-ObjectRef authoring form, so a plain
  // attachment stays a bare reference.
  return disabled
    ? obj([
        ["middleware", ref],
        ["active", lit(false)],
      ])
    : ref;
}

/** `middleware: {pre, post}`, elided when the block is the empty default. */
function middleware(args: KindDecodeArgs): DefEntry | null {
  const block = args.stored.middleware as
    | { pre_customize?: boolean; post_customize?: boolean; pre?: unknown[]; post?: unknown[] }
    | undefined;
  if (block === undefined) return null;
  const entries: DefEntry[] = [];
  // `pre_customize` is what distinguishes "authored an empty list" from "did not
  // author this phase at all", so it drives emission rather than list length.
  if (block.pre_customize) {
    entries.push(["pre", arr((block.pre ?? []).map((e) => middlewareEntry(args, e)))]);
  }
  if (block.post_customize) {
    entries.push(["post", arr((block.post ?? []).map((e) => middlewareEntry(args, e)))]);
  }
  return entries.length > 0 ? ["middleware", obj(entries)] : null;
}

/** `input: {…}`, elided when the object declares none. */
function inputs(args: KindDecodeArgs): DefEntry | null {
  const stored = args.stored.input;
  if (!Array.isArray(stored) || stored.length === 0) return null;
  args.ctx.use(SDK_MODULE, "input");
  return ["input", decodeFieldMap(args.ctx, args.refs, stored as never, "input", args.resolve)];
}

/**
 * `input: {…}` for the two kinds whose `name` is a PATH (query, channel), with
 * one deliberate infidelity: a `{param}` segment that binds to nothing upstream
 * gets an `input.text()` synthesized for it.
 *
 * Xano allows an unbound `{param}` — it is inert route text until an input of
 * that name exists — but Xano SDK refuses to author one, so emitting the source
 * faithfully would produce a tree that throws the moment it is imported. Adding
 * the input is the only outcome that both builds and round-trips, and it is
 * reported every time because re-deploying the generated tree BINDS a segment
 * that was previously inert.
 *
 * A name whose markers are malformed by Xano SDK's grammar (`post-{slug}`) can't
 * be repaired this way — there is no param to bind. That decodes faithfully and
 * is reported, so the reader learns why the generated file will not import.
 */
function pathAwareInputs(args: KindDecodeArgs): DefEntry | null {
  const stored = (Array.isArray(args.stored.input) ? args.stored.input : []) as Array<{
    name?: unknown;
  }>;
  const name = typeof args.stored.name === "string" ? args.stored.name : "";
  try {
    parsePathParams("path", name);
  } catch (error) {
    args.ctx.problem(
      "path-param-bound",
      `the path "${name}" has a {param} marker Xano SDK cannot parse (${
        error instanceof Error ? error.message.replace(/^path: /, "") : String(error)
      }). Emitted as-is — the generated file will not import until the object is renamed upstream.`,
    );
    return inputs(args);
  }
  // Which params are synthesized comes from the shared rule, so the verifier
  // forgives exactly the inputs this adds and no others.
  const missing = unboundPathParams(name, stored);
  if (missing.length === 0) return inputs(args);

  args.ctx.problem(
    "path-param-bound",
    `${missing.map((p) => `{${p}}`).join(", ")} in "${name}" ${
      missing.length === 1 ? "binds" : "bind"
    } to nothing upstream — declared as input.text() so the tree builds. ` +
      `Re-deploying this def BINDS the segment, which the source endpoint did not do.`,
  );
  args.ctx.use(SDK_MODULE, "input");
  const decoded =
    stored.length > 0
      ? decodeFieldMap(args.ctx, args.refs, stored as never, "input", args.resolve)
      : obj([]);
  const existing = decoded.kind === "object" ? decoded.entries : [];
  return ["input", obj([...existing, ...missing.map((p) => [p, call("input.text")] as const)])];
}

/** `response:`, elided when the object declares none. */
function response(args: KindDecodeArgs): DefEntry | null {
  const stored = args.stored.result;
  if (!Array.isArray(stored) || stored.length === 0) return null;
  const expr = decodeResponse(args.ctx, stored as never);
  return expr ? ["response", expr] : null;
}

/**
 * `stack: […]`, elided when empty.
 *
 * Only kinds that carry a statement stack call this, so "no `run`" here means an
 * object that should have had a body and did not. That is *not* an error — a
 * workspace can legitimately hold an endpoint someone created and never filled
 * in, and this decode is faithful. But the generated file is then a bare
 * `{name, guid, verb, apiGroup}`, which looks exactly like a decoder that gave
 * up, and the round trip is clean either way. Reporting it is the only thing
 * that tells the two apart without going and reading the workspace.
 */
function stack(args: KindDecodeArgs): DefEntry | null {
  const run = args.stored.run;
  if (!Array.isArray(run) || run.length === 0) {
    args.ctx.problem("empty-source", "no statements in the source object — emitted without a `stack`");
    return null;
  }
  // Statement mocks are stored keyed by test id and authored keyed by test
  // name, so the id→name map has to be in force while the stack decodes —
  // including for a mock on a statement nested deep inside a container.
  const names = new Map<string, string>();
  for (const t of Array.isArray(args.stored.test) ? args.stored.test : []) {
    if (t !== null && typeof t === "object") {
      const { id, name } = t as { id?: unknown; name?: unknown };
      if (typeof id === "string" && typeof name === "string") names.set(id, name);
    }
  }
  return [
    "stack",
    args.ctx.withTests(names, () => decodeStack(args.ctx, args.refs, run, args.resolve)),
  ];
}

/** `name` and `guid` lead every def; the guid is preserved verbatim. */
function identity(args: KindDecodeArgs): DefEntry[] {
  const entries: DefEntry[] = [["name", lit(args.stored.name)]];
  // Emitted even when it happens to equal md5(type:name): a pulled object's guid
  // is the engine's, and re-deriving it would be a silent identity rewrite.
  if (typeof args.stored.guid === "string" && args.stored.guid !== "") {
    entries.push(["guid", lit(args.stored.guid)]);
  }
  return entries;
}


// --- microservice sub-structures ---------------------------------------------

/** An argv list back to plain strings — the engine stores `[{name}]`. */
function argvStrings(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.map((e) => String((e as { name?: unknown })?.name ?? ""))
    : [];
}

/** Drop members equal to their default, so a generated container stays readable. */
function prune(entries: Array<[string, unknown]>, defaults: Record<string, unknown>): Expr {
  const kept = entries.filter(([k, v]) => {
    if (v === undefined) return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return !deepEqual(v, defaults[k]);
  });
  return obj(kept.map(([k, v]) => [k, lit(v)] as [string, Expr]));
}

/** A microservice's `deployment`, containers and all. */
function deployment(a: KindDecodeArgs): DefEntry | null {
  const block = a.stored["deployment"] as Record<string, unknown> | undefined;
  if (block === undefined) return null;
  const containers = Array.isArray(block["containers"]) ? block["containers"] : [];
  const entries: Array<[string, Expr]> = [];
  if (block["replicas"] !== undefined && block["replicas"] !== 1) {
    entries.push(["replicas", lit(block["replicas"])]);
  }
  if (block["strategy"] !== undefined && block["strategy"] !== "Recreate") {
    entries.push(["strategy", lit(block["strategy"])]);
  }
  if (block["docker"]) entries.push(["docker", lit(block["docker"])]);
  if (containers.length > 0) {
    entries.push([
      "containers",
      arr(
        containers.map((raw) => {
          const c = raw as Record<string, unknown>;
          const resources = (c["resources"] ?? {}) as Record<string, unknown>;
          return prune(
            [
              ["name", c["name"]],
              ["image", c["image"]],
              ["type", c["type"]],
              ["pullSecret", c["pull_secret"]],
              ["ports", c["ports"]],
              ["resources", resources["cpu"] || resources["ram"] ? resources : undefined],
              ["command", argvStrings(c["command"])],
              ["args", argvStrings(c["args"])],
              ["env", containerEnvs(c["envs"])],
              ["volumes", c["volumes"]],
            ],
            { type: "standard", image: "" },
          );
        }),
      ),
    ]);
  }
  if (entries.length === 0) return null;
  return ["deployment", obj(entries)];
}

/**
 * Container env entries, stored → authored. The stored shape carries all three
 * keys (`name`, `value`, `from_env`); the authoring surface spells the reference
 * `fromEnv` and treats it as exclusive with `value`.
 *
 * Passing the stored entries through verbatim wrote `from_env` — not an
 * authoring key — into the tree, which does not type-check and is dropped by the
 * encoder on the next deploy, silently turning a deploy-time secret reference
 * into a blank environment variable. The resolved `value` the engine writes back
 * beside a reference is dropped for the same reason it exists: carrying it would
 * inline the secret the reference keeps out of the tree.
 */
function containerEnvs(stored: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(stored)) return undefined;
  return stored.map((raw) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const ref = typeof e["from_env"] === "string" ? e["from_env"] : "";
    if (ref !== "") return { name: e["name"], fromEnv: ref };
    return { name: e["name"], value: e["value"] };
  });
}

/** A block emitted only when it holds something — `chart`, `registry_auth`. */
function populatedBlock(
  a: KindDecodeArgs,
  storedKey: string,
  defKey: string,
  rename: Record<string, string> = {},
): DefEntry | null {
  const block = a.stored[storedKey] as Record<string, unknown> | undefined;
  if (block === undefined) return null;
  const entries = Object.entries(block)
    .filter(([, v]) => v !== "" && v !== null && v !== undefined)
    .map(([k, v]) => [rename[k] ?? k, lit(v)] as [string, Expr]);
  return entries.length === 0 ? null : [defKey, obj(entries)];
}

/** A list block emitted only when non-empty. */
function listBlock(a: KindDecodeArgs, storedKey: string, defKey = storedKey): DefEntry | null {
  const list = a.stored[storedKey];
  if (!Array.isArray(list) || list.length === 0) return null;
  return [defKey, lit(list)];
}

/** Drop the nulls a table of optional entries produces. */
function compact(entries: Array<DefEntry | null>): DefEntry[] {
  return entries.filter((e): e is DefEntry => e !== null);
}

// --- table sub-structures ----------------------------------------------------

/** Stored index → `IndexDef[]`, dropping the keys `encodeIndex` fills back in. */
function storedIndexDefs(stored: unknown): IndexDef[] {
  if (!Array.isArray(stored)) return [];
  return stored.map((entry) => {
    const index = entry as { name?: string; lang?: string; type: string; fields?: unknown[] };
    return {
      type: index.type,
      fields: (index.fields ?? []).map((field) => {
        const { name, op } = field as { name: string; op?: string };
        return { name, ...(op ? { op: op as IndexDef["fields"][number]["op"] } : {}) };
      }),
      ...(index.name ? { name: index.name } : {}),
      ...(index.lang ? { lang: index.lang as IndexDef["lang"] } : {}),
    };
  });
}

/** `IndexDef[]` → the `index:` argument, or nothing when the list is empty. */
function indexes(list: readonly IndexDef[]): DefEntry | null {
  if (list.length === 0) return null;
  return [
    "index",
    arr(
      list.map((index) =>
        obj(
          compact([
            ["type", lit(index.type)] as DefEntry,
            [
              "fields",
              arr(
                index.fields.map(({ name, op }) =>
                  obj(compact([["name", lit(name)] as DefEntry, op ? (["op", lit(op)] as DefEntry) : null])),
                ),
              ),
            ] as DefEntry,
            index.name ? (["name", lit(index.name)] as DefEntry) : null,
            index.lang ? (["lang", lit(index.lang)] as DefEntry) : null,
          ]),
        ),
      ),
    ),
  ];
}

/**
 * The `system` and `index` arguments together, because the choice between them
 * is one decision.
 *
 * A decoded table carries a COMPLETE schema and index list, so the encoder's
 * auto-injection has to be kept out of the way. `system: false` does that
 * bluntly and costs every generated table the three standard index literals
 * nobody authored. When the schema already declares the system columns (making
 * the column injection a no-op) and the standard indexes can be dropped and put
 * back identically, the quiet form says the same thing: no `system` key, and only
 * the indexes the user actually created.
 */
function tableSystemAndIndexes(a: KindDecodeArgs): DefEntry[] {
  const declared = storedIndexDefs(a.stored.index);
  const schema = Array.isArray(a.stored.schema) ? a.stored.schema : [];
  const columns = new Set(schema.map((col) => String((col as { name?: unknown }).name ?? "")));
  const elided = SYSTEM_COLUMN_NAMES.every((name) => columns.has(name))
    ? elideSystemIndexes(declared, tableUsesXdo(a.stored))
    : null;
  return elided
    ? compact([indexes(elided)])
    : compact([["system", lit(false)] as DefEntry, indexes(declared)]);
}

/**
 * The table's storage mode, from the stored flag when it is there and from the
 * `gin(xdo)` index when it is not.
 *
 * `use_xdo` postdates a lot of what is in the field: real pulled workspaces carry
 * tables with the gin index and no flag at all, and reading that absence as
 * `false` writes a table that CLAIMS column storage while carrying the index only
 * JSON storage produces. The index is the observable half of the same fact — see
 * {@link TableDef.useXdo} — so it stands in when the flag is missing. An
 * explicitly stored `false` is believed over the inference, never overridden.
 */
function tableUsesXdo(stored: StoredObject): boolean {
  if (typeof stored.use_xdo === "boolean") return stored.use_xdo;
  return storedIndexDefs(stored.index).some(
    (index) => index.type === "gin" && index.fields.some((field) => field.name === "xdo"),
  );
}

/**
 * Stored view → `ViewDef`.
 *
 * A view's `expression` is the same `{expression: […]}` boolean tree every other
 * filter surface uses (`encodeView` builds it through `encodeComparison`), so it
 * inverts through the shared algebra rather than needing one of its own. A tree
 * that will not decode is reported instead of dropped — silently losing a view's
 * filter would widen what the view returns, which is a data-exposure change, not
 * a cosmetic one.
 */
function views(args: KindDecodeArgs): DefEntry | null {
  const stored = args.stored.views;
  if (!Array.isArray(stored) || stored.length === 0) return null;
  return [
    "views",
    arr(
      stored.map((entry) => {
        const view = entry as {
          name: string;
          id: string;
          alias?: string;
          hiddenCols?: string[];
          q?: string;
          expression?: unknown[];
          sort?: unknown[];
        };
        if (typeof view.id !== "string") {
          args.ctx.problem("verify-mismatch", `table view "${view.name}" has no id; it decodes as id: "" — give it the view's uuid`);
        }
        let where: DefEntry | null = null;
        if (Array.isArray(view.expression) && view.expression.length > 0) {
          const condition = args.ctx.speculate(() =>
            decodeCondition(args.ctx, { expression: view.expression }),
          );
          if (condition) {
            where = ["where", condition.expr];
          } else {
            args.ctx.use(CODEGEN_MODULE, "rawWhere");
            where = ["where", call("rawWhere", lit(view.expression))];
            if (hasBlankOperator(view.expression)) {
              args.ctx.problem(
                "workspace-defect",
                `table view "${view.name}" has a filter row with no operator — what the editor stores for a row ` +
                  `added and never configured — and the engine cannot apply it, so the view fails wherever it is ` +
                  `read. Carried verbatim via rawWhere(); give the row an operator or remove it upstream`,
                "blank view filter",
              );
            } else {
              args.ctx.problem(
                "value-fallback",
                `table view "${view.name}" has a filter expression no \`where\` condition can express; carried verbatim via rawWhere()`,
              );
            }
          }
        }
        return obj(
          compact([
            ["name", lit(view.name)] as DefEntry,
            ["id", lit(typeof view.id === "string" ? view.id : "")] as DefEntry,
            view.alias ? (["alias", lit(view.alias)] as DefEntry) : null,
            view.hiddenCols?.length ? (["hide", lit(view.hiddenCols)] as DefEntry) : null,
            view.q ? (["q", lit(view.q)] as DefEntry) : null,
            where,
            view.sort?.length ? (["sort", lit(view.sort)] as DefEntry) : null,
          ]),
        );
      }),
    ),
  ];
}

/**
 * Whether a stored expression list holds a live comparison with a blank `op`.
 * A group's own `statement` is its dead branch and is not read.
 */
function hasBlankOperator(nodes: unknown): boolean {
  if (!Array.isArray(nodes)) return false;
  return nodes.some((node) => {
    const n = node as { type?: unknown; group?: { expression?: unknown }; statement?: { op?: unknown } } | null;
    if (n === null || typeof n !== "object") return false;
    if (n.type === "group") return hasBlankOperator(n.group?.expression);
    return n.statement?.op === "";
  });
}

// --- the twelve kinds --------------------------------------------------------

const EMPTY_EXTERNAL = { source: "", id: "" };

/**
 * The `cache` default both a function and a query carry. Authorable on both —
 * the engine reads a function's block through the same runtime path, and the
 * encoder hard-coding it meant a pulled function silently lost real caching.
 */
const DEFAULT_CACHE = {
  active: false,
  ttl: 3600,
  input: true,
  auth: true,
  datasource: true,
  ip: false,
  headers: [],
  env: [],
};

export const KIND_DECODERS: readonly KindDecoder[] = [
  {
    name: "knowledge",
    payloadKey: "knowledge",
    dir: "knowledge",
    register: "registerKnowledge",
    defType: "KnowledgeDef",
    factory: "knowledge",
    decode: (a) => {
      const type = (a.stored.knowledge_type as KnowledgeType) ?? "skill";
      const name = String(a.stored.name ?? "");
      // The body is written as a sibling markdown file (see `companions`), so
      // the def points at it rather than inlining the prose as a string.
      a.ctx.imports.use(SDK_MODULE, "knowledgeFile");
      const refsDir = knowledgeRefsDir(type, name);
      const hasRefs = refsDir !== null && knowledgeFileRows(a.payload, a.stored.guid).length > 0;
      if (hasRefs) a.ctx.imports.use(SDK_MODULE, "knowledgeDir");
      return compact([
        ...identity(a),
        plain(a.stored, "description", ""),
        plain(a.stored, "knowledge_type", "skill", "type"),
        plain(a.stored, "mode", "auto"),
        plain(a.stored, "enabled", true),
        [
          "body",
          call("knowledgeFile", lit(`./${knowledgeBodyPath(type, name)}`), id("import.meta.url")),
        ],
        hasRefs
          ? ([
              "refs",
              call("knowledgeDir", lit(`./${refsDir}`), id("import.meta.url")),
            ] as DefEntry)
          : null,
        tags(a.stored),
      ]);
    },
    companions: ({ stored, payload }) => {
      const type = (stored.knowledge_type as KnowledgeType) ?? "skill";
      const name = String(stored.name ?? "");
      const refsDir = knowledgeRefsDir(type, name);
      return [
        { path: knowledgeBodyPath(type, name), contents: String(stored.content ?? "") },
        ...(refsDir === null
          ? []
          : knowledgeFileRows(payload, stored.guid).map((f) => ({
              path: `${refsDir}/${f.path}`,
              contents: f.content,
            }))),
      ];
    },
  },
  {
    name: "table",
    payloadKey: "dbo",
    dir: "table",
    register: "registerTables",
    defType: "TableDef",
    factory: "table",
    decode: (a) =>
      compact([
        ...identity(a),
        plain(a.stored, "description", ""),
        plain(a.stored, "docs", ""),
        plain(a.stored, "auth", false),
        plain(a.stored, "install", false),
        [
          "schema",
          decodeTableSchema(a.ctx, a.refs, (a.stored.schema ?? []) as never, a.resolve),
        ],
        ...tableSystemAndIndexes(a),
        views(a),
        Array.isArray(a.stored.autocomplete) && a.stored.autocomplete.length > 0
          ? ["autocomplete", lit(a.stored.autocomplete.map((e) => (e as { name: string }).name))]
          : null,
        plain(a.stored, "external", EMPTY_EXTERNAL),
        tableUsesXdo(a.stored) ? (["useXdo", lit(true)] as DefEntry) : null,
        tags(a.stored),
      ]),
  },
  {
    name: "function",
    payloadKey: "function",
    dir: "function",
    register: "registerFunctions",
    defType: "FunctionDef",
    factory: "defineFunction",
    decode: (a) =>
      compact([
        ...identity(a),
        plain(a.stored, "description", ""),
        plain(a.stored, "docs", ""),
        plain((a.stored.workspace ?? {}) as StoredObject, "id", 0, "workspace"),
        // Same block, same default, same engine read as a query's — without it
        // a function with caching switched on would re-export with it OFF.
        plain(a.stored, "cache", DEFAULT_CACHE),
        history(a),
        middleware(a),
        tags(a.stored),
        inputs(a),
        response(a),
        stack(a),
        decodeTests(a),
      ]),
  },
  {
    name: "query",
    payloadKey: "query",
    dir: "query",
    register: "registerQueries",
    defType: "QueryDef",
    factory: "query",
    decode: (a) =>
      compact([
        ...identity(a),
        ["verb", lit(a.stored.verb)],
        plain(a.stored, "description", ""),
        plain(a.stored, "docs", ""),
        plain(a.stored, "api_enabled", true, "apiEnabled"),
        authRef(a, a.stored.auth),
        plain(a.stored, "response_type", "standard", "responseType"),
        plain(a.stored, "disabled", false),
        apiGroupBinding(a),
        plain(a.stored, "cache", DEFAULT_CACHE),
        middleware(a),
        tags(a.stored),
        history(a),
        pathAwareInputs(a),
        response(a),
        stack(a),
        decodeExample(a),
        decodeTests(a),
      ]),
  },
  {
    name: "api_group",
    payloadKey: "app",
    // A group gets a folder of its own UNDER this one, holding its definition
    // and every query in it — so this is `query`, not `apiGroup`.
    dir: "query",
    register: "registerApiGroups",
    defType: "ApiGroupDef",
    factory: "apiGroup",
    decode: (a) =>
      compact([
        ...identity(a),
        plain(a.stored, "description", ""),
        plain(a.stored, "canonical", ""),
        plain(a.stored, "swagger", false),
        plain(a.stored, "api_group_enabled", true, "apiGroupEnabled"),
        plain(a.stored, "docs", ""),
        apiGroupDocumentation(a),
        middleware(a),
        containerHistory(a, "query"),
        tags(a.stored),
        cors(a),
      ]),
  },
  {
    name: "microservice",
    payloadKey: "microservice",
    dir: "microservice",
    register: "registerMicroservices",
    defType: "MicroserviceDef",
    factory: "microservice",
    decode: (a) => {
      // A credential in a generated tree is worth a line in the report every
      // time, not a footnote in the docs. Carried deliberately (dropping it
      // would mean a pulled microservice could not be redeployed), so the report
      // is what keeps it from happening quietly.
      const auth = a.stored["registry_auth"] as Record<string, unknown> | undefined;
      if (typeof auth?.["dockerconfigjson"] === "string" && auth["dockerconfigjson"] !== "") {
        a.ctx.problem(
          "expected-omission",
          `microservice "${String(a.stored.name)}" carries a private-registry credential ` +
            "(`registryAuth.dockerconfigjson`) into the generated tree — it is needed to redeploy, " +
            "so treat this tree as secret material (keep it out of git, or rotate the credential). " +
            "Clearing it here is safe only if the workload does not need a private pull: the field " +
            "is stored verbatim, so there is no environment indirection to move it to",
        );
      }
      const chartValues = (a.stored["chart"] as Record<string, unknown> | undefined)?.["values"];
      if (typeof chartValues === "string" && chartValues !== "") {
        a.ctx.problem(
          "expected-omission",
          `microservice "${String(a.stored.name)}" carries its Helm \`chart.values\` into the ` +
            "generated tree verbatim — they are needed to redeploy, and Helm values may hold " +
            "secrets, so read them before committing this tree",
        );
      }
      return compact([
        ...identity(a),
        plain(a.stored, "description", ""),
        plain(a.stored, "kind", "builtin"),
        plain(a.stored, "tenant_deploy", "auto", "tenantDeploy"),
        listBlock(a, "configs"),
        listBlock(a, "volumes"),
        listBlock(a, "ingresses"),
        deployment(a),
        populatedBlock(a, "chart", "chart"),
        populatedBlock(a, "registry_auth", "registryAuth", {
          dockerconfigjson: "dockerconfigjson",
        }),
      ]);
    },
  },
  {
    name: "realtime_server",
    payloadKey: "realtime_server",
    dir: "realtime_server",
    register: "registerRealtimeServers",
    defType: "RealtimeServerDef",
    factory: "realtimeServer",
    decode: (a) =>
      compact([
        ...identity(a),
        plain(a.stored, "description", ""),
        plain(a.stored, "canonical", ""),
        // A realtime server is OFF by default, so `enabled: true` is the
        // authored state worth carrying.
        plain(a.stored, "enabled", false),
        containerHistory(a, "message"),
        middleware(a),
        tags(a.stored),
      ]),
  },
  {
    name: "channel",
    payloadKey: "channel",
    dir: "realtime_channel",
    register: "registerRealtimeChannels",
    defType: "RealtimeChannelDef",
    factory: "realtimeChannel",
    decode: (a) =>
      compact([
        ...identity(a),
        realtimeHostBinding(a, "server", "server"),
        plain(a.stored, "description", ""),
        plain(a.stored, "active", true),
        pathAwareInputs(a),
        plain(a.stored, "anonymous_clients", false, "anonymousClients"),
        plain(a.stored, "presence", false),
        // Nested blocks elide as WHOLES — a per-member comparison would fill a
        // generated file with `publish: { direct: false }` noise for a channel
        // that only set `who`.
        nested(a, "publish", { who: "nobody", direct: false }),
        nested(a, "conversation", { enabled: false, limit: 0, ttl: 0 }),
        nested(a, "delivery", { guarantee: "at_most_once", per_recipient: false }, {
          per_recipient: "perRecipient",
        }),
        nested(a, "rate_limit", { messages_per_minute: 0 }, {
          messages_per_minute: "messagesPerMinute",
        }, "rateLimit"),
        containerHistory(a, "message"),
        middleware(a),
        tags(a.stored),
      ]),
  },
  {
    name: "message",
    payloadKey: "message",
    dir: "realtime_message",
    register: "registerRealtimeMessages",
    defType: "RealtimeMessageDef",
    factory: "realtimeMessage",
    decode: (a) =>
      compact([
        ...identity(a),
        // A channel handle carries its server, so the encoder can take both from
        // one reference — but a DECODED message has only two guids and no way to
        // know they agree, so both are emitted. `server` alongside a resolved
        // channel handle is accepted by the encoder as long as they match.
        realtimeHostBinding(a, "channel", "channel"),
        realtimeHostBinding(a, "server", "server"),
        plain(a.stored, "description", ""),
        plain(a.stored, "active", true),
        authRef(a, a.stored.auth),
        plain(a.stored, "deliver_to", "channel", "deliverTo"),
        plain(a.stored, "disabled", false),
        middleware(a),
        tags(a.stored),
        history(a),
        inputs(a),
        response(a),
        stack(a),
      ]),
  },
  {
    name: "trigger",
    payloadKey: "trigger",
    dir: "trigger",
    register: "registerTriggers",
    defType: "TriggerDef",
    decode: (a) => decodeTrigger(a),
  },
  {
    name: "task",
    payloadKey: "task",
    dir: "task",
    register: "registerTasks",
    defType: "TaskDef",
    factory: "task",
    decode: (a) =>
      compact([
        ...identity(a),
        plain(a.stored, "description", ""),
        plain(a.stored, "docs", ""),
        plain(a.stored, "datasource", ""),
        plain(a.stored, "active", true),
        middleware(a),
        tags(a.stored),
        history(a),
        schedule(a),
        stack(a),
      ]),
  },
  {
    name: "workflow_test",
    payloadKey: "workflow_test",
    dir: "workflow-test",
    register: "registerWorkflowTests",
    defType: "WorkflowTestDef",
    factory: "workflowTest",
    // Mirrors `encodeWorkflowTest` key for key. No middleware/history/inputs/
    // response: the kind has none. `lastRun` is deliberately unread — it is the
    // outcome of the last execution, instance state rather than workspace
    // source, so a stored object carrying one is normal and not a decoder gap.
    decode: (a) =>
      compact([
        ...identity(a),
        plain(a.stored, "description", ""),
        plain(a.stored, "docs", ""),
        plain(a.stored, "datasource", ""),
        plain(a.stored, "active", true),
        tags(a.stored),
        stack(a),
      ]),
  },
  {
    name: "middleware",
    payloadKey: "middleware",
    dir: "middleware",
    register: "registerMiddleware",
    defType: "MiddlewareDef",
    factory: "middleware",
    decode: (a) =>
      compact([
        ...identity(a),
        plain(a.stored, "description", ""),
        plain(a.stored, "docs", ""),
        plain(a.stored, "result_type", "merge", "resultStrategy"),
        plain(a.stored, "exception", "rethrow", "exceptionPolicy"),
        history(a),
        tags(a.stored),
        inputs(a),
        response(a),
        stack(a),
        decodeTests(a),
      ]),
  },
  {
    name: "addon",
    payloadKey: "addon",
    dir: "addon",
    register: "registerAddons",
    defType: "AddonDef",
    factory: "addon",
    decode: (a) => addonEntries(a),
  },
  {
    name: "tool",
    payloadKey: "tool",
    dir: "tool",
    register: "registerTools",
    defType: "ToolDef",
    factory: "tool",
    decode: (a) =>
      compact([
        ...identity(a),
        plain(a.stored, "description", ""),
        plain(a.stored, "instructions", ""),
        plain(a.stored, "docs", ""),
        plain(a.stored, "enabled", true),
        middleware(a),
        tags(a.stored),
        history(a),
        plain((a.stored.toolset ?? {}) as StoredObject, "id", 0, "toolsetId"),
        plain(a.stored, "title", ""),
        toolAnnotations(a),
        mcpIcons(a),
        inputs(a),
        toolOutputSchema(a),
        response(a),
        stack(a),
      ]),
  },
  {
    name: "prompt",
    payloadKey: "prompt",
    dir: "prompt",
    register: "registerPrompts",
    defType: "PromptDef",
    factory: "prompt",
    decode: (a) =>
      compact([
        ...identity(a),
        plain(a.stored, "description", ""),
        plain(a.stored, "docs", ""),
        plain(a.stored, "title", ""),
        mcpIcons(a),
        middleware(a),
        tags(a.stored),
        history(a),
        inputs(a),
        response(a),
        stack(a),
      ]),
  },
  {
    name: "resource",
    payloadKey: "resource",
    dir: "resource",
    register: "registerResources",
    defType: "ResourceDef",
    factory: "resource",
    decode: (a) =>
      compact([
        ...identity(a),
        ["uri", lit(a.stored.uri ?? "")] as DefEntry,
        plain(a.stored, "description", ""),
        plain(a.stored, "docs", ""),
        plain(a.stored, "mime_type", "", "mimeType"),
        plain(a.stored, "title", ""),
        mcpIcons(a),
        resourceAnnotations(a),
        middleware(a),
        tags(a.stored),
        history(a),
        inputs(a),
        response(a),
        stack(a),
      ]),
  },
  {
    name: "mcp_server",
    payloadKey: "toolset",
    dir: "mcp_server",
    register: "registerMcpServers",
    defType: "McpServerDef",
    factory: "mcpServer",
    // An MCP server and an agent are one stored row, so an MCP server can carry
    // the same settings block — read it when it holds anything, and stay silent
    // when it does not, so the common MCP server emits exactly what it always did.
    decode: (a) => [
      ...toolsetBaseEntries(a),
      ...compact([primitiveRefs(a, "prompt"), primitiveRefs(a, "resource"), mcpOauth(a)]),
      ...(hasAgentSettings(a) ? agentSettingsEntries(a) : []),
    ],
  },
  {
    name: "agent",
    payloadKey: "toolset",
    dir: "agent",
    register: "registerAgents",
    defType: "AgentDef",
    factory: "agent",
    decode: (a) => [...toolsetBaseEntries(a), ...agentSettingsEntries(a)],
  },
  {
    name: "workspace",
    payloadKey: "workspace",
    dir: ".",
    register: "registerWorkspace",
    defType: "WorkspaceConfigDef",
    factory: "workspaceConfig",
    decode: (a) =>
      compact([
        // Workspace-config is a singleton whose guid the export path derives from
        // the workspace name, and `WorkspaceConfigDef` declares no `guid` field —
        // the one def that does not carry its guid.
        ["name", lit(a.stored.name)],
        plain(a.stored, "description", ""),
        plain(a.stored, "canonical", ""),
        plain(a.stored, "use_xdo", false),
        minusDefaults(a.stored, "preferences", DEFAULT_PREFERENCES),
        // The legacy realtime block and the documentation block, carried
        // verbatim — this SDK models neither's members. PRESENCE-ONLY on the
        // encode side, so `atDefault` rather than `plain`: the two spellings
        // "stored at the default" and "key absent" are different bytes here, and
        // only `atDefault` lets both round-trip. `WORKSPACE_DEFAULTED_KEYS`
        // names the defaults and verification reads the same table, so the drop
        // compares equal rather than reading as a loss.
        atDefault(a.stored, "realtime"),
        documentation(a),
        plain(a.stored, "swagger", false),
        workspaceMiddleware(a),
        workspaceHistory(a),
        workspaceEnv(a),
        minusDefaults(a.stored, "settings", DEFAULT_SETTINGS),
        // `?=`-optional in the engine schema and emitted BY PRESENCE, so the
        // encoder cannot round-trip a default it never wrote. The engine
        // materializes all four on save anyway, so a stored default is noise a
        // reader would never have typed — `WORKSPACE_DEFAULTED_KEYS` names the
        // defaults, and verification reads the same table so the drop is silent.
        atDefault(a.stored, "use_custom_names"),
        atDefault(a.stored, "defaults"),
        atDefault(a.stored, "datasources"),
        atDefault(a.stored, "datasource_live"),
      ]),
  },
];

/**
 * An auth-table reference (`query.auth`, `tool[].auth`).
 *
 * The stored form in a bundle is the auth table's **guid**, and this is the one
 * place where emitting it verbatim is actively dangerous rather than merely
 * unreadable: `resolveAuthRef` reads a bare string as a table *name* and derives
 * `md5("dbo:<that string>")` from it — silently repointing the endpoint at a
 * table that does not exist, with no error at export and no error at import.
 * Resolving through {@link resolveReference} with `unresolved: "object-ref"`
 * keeps the guid a guid.
 *
 * `false` (no auth) and the numeric `dbo.id` escape hatch pass through as-is.
 */
function authRef(a: KindDecodeArgs, stored: unknown): DefEntry | null {
  if (stored === undefined || stored === false) return null;
  if (typeof stored === "number") return ["auth", lit(stored)];
  if (typeof stored !== "string" || stored === "") return null;
  return [
    "auth",
    resolveReference(a.ctx, a.refs, stored, { ...a.resolve, unresolved: "object-ref" }),
  ];
}

/**
 * A realtime parent binding (`server.id` / `channel.id`): a guid reference back
 * to the parent's handle, or the numeric escape hatch.
 *
 * Unlike a query's api group these are **required**, so an absent / `0` / blank
 * id cannot be emitted — `0` would silently bind to nothing and a blank is not a
 * reference at all. It is dropped, and {@link missingRealtimeRef} records why, so
 * the gap arrives as a report line instead of as a def that mysteriously fails
 * its own encoder check.
 *
 * The blank case is not hypothetical. The engine's export-side reference remap
 * degrades to `""` when the target sits outside the export's scope (a
 * schema-scoped export carries triggers but not the realtime objects they point
 * at) rather than aborting the whole export. Xano SDK's own reads always include
 * realtime objects, so its own bundles never hit this — but nothing stops a user
 * pulling from an archive produced by a narrower export, and silently dropping a
 * required binding there produces a def whose cause is upstream and invisible.
 */
function realtimeHostBinding(
  a: KindDecodeArgs,
  storedKey: string,
  defKey: string,
): DefEntry | null {
  const id = (a.stored[storedKey] as { id?: unknown } | undefined)?.id;
  if (id === undefined || id === 0 || id === "") {
    missingRealtimeRef(a, defKey, id);
    return null;
  }
  if (typeof id === "number") return [defKey, lit(id)];
  return [
    defKey,
    resolveReference(a.ctx, a.refs, String(id), { ...a.resolve, unresolved: "object-ref" }),
  ];
}

// --- triggers ----------------------------------------------------------------

/**
 * `obj_type` → the root factory that builds it, for the types whose arguments
 * invert faithfully without a handle argument.
 *
 * `realtimeTrigger` (the LEGACY `workspace_realtime_channel` type) takes no
 * handle at all, only the numeric `objId` that indexes the workspace's realtime
 * channel list. Being deprecated is a reason to withhold it from the docs
 * catalog, not a reason to make the one workspace that still holds one read
 * worse. The handle-bound types are {@link REALTIME_HANDLE_TRIGGERS} and
 * {@link TOOLSET_TRIGGERS}.
 */
const TRIGGER_FACTORIES: Readonly<Record<string, string>> = {
  database: "tableTrigger",
  workspace: "workspaceTrigger",
  error: "errorTrigger",
  workspace_realtime_channel: "realtimeTrigger",
};

/**
 * The realtime lifecycle types, whose factory binds a def handle: the channel
 * (a `RealtimeChannelDef`, which carries its server) or the server. The stored
 * `obj_id` is that object's guid, so it inverts to a reference to the decoded
 * def — a channel only when the channel is in this bundle, since a
 * `{ name, guid }` stand-in is not a `RealtimeChannelDef`.
 */
const REALTIME_HANDLE_TRIGGERS: Readonly<Record<string, { factory: string; arg: string; kind: string; needsDef: boolean }>> = {
  channel: { factory: "realtimeChannelTrigger", arg: "channel", kind: "channel", needsDef: true },
  realtime_server: { factory: "realtimeServerTrigger", arg: "realtimeServer", kind: "realtime_server", needsDef: false },
};

/**
 * The trigger types whose factory takes a `response` callback. Every other type
 * is config-only, so a stored `result[]` on one of those has nowhere to go and
 * forces the `satisfies` form.
 */
const RESPONSE_BEARING_TRIGGERS: ReadonlySet<string> = new Set([
  "toolset",
  "workspace_realtime_channel",
  "channel",
  "realtime_server",
]);

/**
 * The defaults a factory injects when its `stack`/`response` arguments are
 * omitted, as a probe built by the factory itself rather than restated here.
 *
 * Only these two types inject anything: `toolsetTrigger` reproduces Xano's own
 * pass-through stack and echoing response (one var per input, so an MCP
 * server's differs from an agent's), and `realtimeTrigger` echoes the `payload`
 * input back. A stored body equal to the probe's is elided, so the generated call
 * relies on the same default the engine does.
 */
const TRIGGER_DEFAULTS: Readonly<Record<string, (toolsetType?: ToolsetType, authoredStack?: boolean) => TriggerDef>> = {
  // With an authored stack a toolset trigger's default response reads the
  // inputs, since only the default stack sets the vars it otherwise echoes.
  toolset: (toolsetType, authoredStack) => {
    const args = { name: "probe", ...(authoredStack ? { stack: [] } : {}) };
    return toolsetType === "agent" ? agentTrigger(args) : mcpServerTrigger(args);
  },
  workspace_realtime_channel: (_toolsetType, authoredStack) =>
    realtimeTrigger({ name: "probe", ...(authoredStack ? { stack: [] } : {}) }),
};

/**
 * The two kinds that persist under `toolset`, and the trigger factory, argument
 * name and {@link ToolsetType} each one's trigger uses.
 *
 * The two factories differ in the inputs they imply — an MCP server's trigger
 * also receives `prompts` and `resources` — so the choice decides what deploys,
 * and the bound object's own kind is the only truthful source for it.
 */
const TOOLSET_TRIGGERS: Readonly<Record<string, { factory: string; arg: string; toolsetType: ToolsetType }>> = {
  mcp_server: { factory: "mcpServerTrigger", arg: "mcpServer", toolsetType: "mcp" },
  agent: { factory: "agentTrigger", arg: "agent", toolsetType: "agent" },
};

/**
 * The action flags each factory takes, in the order they are emitted.
 *
 * Read from the stored `meta.<group>.action` block and emitted as `actions`. Only
 * TRUE members appear — every factory defaults each flag to `false` — and an
 * all-false trigger emits no `actions` key at all.
 */
const TRIGGER_ACTIONS: Readonly<Record<string, { group: string; keys: readonly string[] }>> = {
  database: { group: "database", keys: ["delete", "insert", "truncate", "update"] },
  workspace: { group: "workspace", keys: ["branch_live", "branch_merge", "branch_new"] },
  workspace_realtime_channel: {
    group: "workspace_realtime_channel",
    keys: ["join", "message"],
  },
  channel: { group: "channel", keys: ["join", "leave", "deliver"] },
  realtime_server: { group: "realtime_server", keys: ["connect", "disconnect"] },
};

/**
 * Decode a trigger, in factory form where that round-trips and `satisfies`
 * otherwise.
 *
 * The fallback is not a decoder gap to be tidied away later — it is the safety
 * property. A trigger carries state no factory argument reaches (see
 * {@link triggerFactoryArgs}), and emitting a factory call that silently drops it
 * would produce a file that compiles, imports, and deploys a DIFFERENT trigger.
 * The `satisfies` form is byte-faithful for every shape; the factory form is
 * better-typed for the shapes it can express. Preferring the second only when it
 * is provably equivalent is the whole design.
 */
function decodeTrigger(a: KindDecodeArgs): DecodedDef {
  const objType = a.stored.obj_type;
  if (typeof objType === "string") {
    const chosen: { factory: string; arg: string | undefined; toolsetType?: ToolsetType } | undefined =
      objType === "toolset"
        ? toolsetTriggerFactory(a)
        : Object.hasOwn(REALTIME_HANDLE_TRIGGERS, objType)
          ? realtimeTriggerFactory(a, REALTIME_HANDLE_TRIGGERS[objType]!)
          : (Object.hasOwn(TRIGGER_FACTORIES, objType) ? TRIGGER_FACTORIES[objType] : undefined)
          ? { factory: (Object.hasOwn(TRIGGER_FACTORIES, objType) ? TRIGGER_FACTORIES[objType] : undefined)!, arg: undefined }
          : undefined;
    if (chosen) {
      const entries = triggerFactoryArgs(a, objType as TriggerInputObjType, chosen.arg, chosen.toolsetType);
      if (entries) return { entries, factory: chosen.factory };
    }
  }
  return { entries: triggerDefEntries(a) };
}

/**
 * The realtime lifecycle factory for a stored trigger, when its `obj_id` names
 * an object this bundle can hand the factory as its handle argument.
 */
function realtimeTriggerFactory(
  a: KindDecodeArgs,
  spec: { factory: string; arg: string; kind: string; needsDef: boolean },
): { factory: string; arg: string } | undefined {
  const objId = a.stored.obj_id;
  if (typeof objId !== "string" || objId === "") return undefined;
  const target = a.refs.lookup(objId);
  if (target?.kind === spec.kind || (!spec.needsDef && target === undefined)) return spec;
  triggerFallback(a, `binds a ${spec.kind === "channel" ? "realtime channel" : "realtime server"} (${objId}) this bundle does not contain, so there is no def to pass as \`${spec.arg}\``);
  return undefined;
}

/**
 * Which toolset trigger factory a stored object reads as, from the KIND of the
 * object its `obj_id` names.
 *
 * A numeric or unresolvable `obj_id` yields nothing: a guess would write a file
 * that claims an agent trigger is an MCP-server trigger (or the reverse), and
 * gives it the other's inputs. The `satisfies` form says neither.
 */
function toolsetTriggerFactory(
  a: KindDecodeArgs,
): { factory: string; arg: string; toolsetType: ToolsetType } | undefined {
  const objId = a.stored.obj_id;
  if (typeof objId !== "string" || objId === "") {
    triggerFallback(a, "binds its toolset by numeric id, which does not say whether it is an MCP server or an agent");
    return undefined;
  }
  const target = a.refs.lookup(objId);
  const chosen = target ? TOOLSET_TRIGGERS[target.kind] : undefined;
  if (!chosen) {
    triggerFallback(a, `binds a toolset (${objId}) this bundle does not contain, so it cannot say whether it is an MCP server or an agent`);
  }
  return chosen;
}

/**
 * `toolsetType: "agent"` for a `satisfies`-form trigger bound to an agent in
 * this bundle. Omitted otherwise: an unset type reads as an MCP server, as the
 * engine reads a toolset it cannot resolve.
 */
function toolsetTypeEntry(a: KindDecodeArgs): DefEntry | null {
  const objId = a.stored.obj_id;
  if (a.stored.obj_type !== "toolset" || typeof objId !== "string" || objId === "") return null;
  const kind = a.refs.lookup(objId)?.kind;
  const toolsetType = kind !== undefined && Object.hasOwn(TOOLSET_TRIGGERS, kind) ? TOOLSET_TRIGGERS[kind]!.toolsetType : undefined;
  return toolsetType === "agent" ? ["toolsetType", lit(toolsetType)] : null;
}

/** The verbatim `satisfies TriggerDef` form — faithful for every trigger type. */
function triggerDefEntries(a: KindDecodeArgs): DefEntry[] {
  return compact([
    ...identity(a),
    ["objType", lit(a.stored.obj_type)],
    toolsetTypeEntry(a),
    plain(a.stored, "active", true),
    plain(a.stored, "description", ""),
    triggerObjId(a),
    history(a),
    ["meta", lit(a.stored.meta)],
    tags(a.stored),
    // `input` is implied by trigger type and re-injected by the encoder, so
    // it is deliberately not carried. `hasResult` is required on `TriggerDef`
    // (it selects the result envelope), so it is always stated.
    ["hasResult", lit(Array.isArray(a.stored.result) && a.stored.result.length > 0)],
    response(a),
    stack(a),
  ]);
}

/**
 * Factory arguments for one trigger, or `null` when the factory cannot reproduce
 * the stored object.
 *
 * The `meta` check is made against the ENCODER rather than against a
 * hand-maintained list of known-bad shapes:
 *
 * - **`meta` the factory does not synthesize.** Rather than enumerate the shapes
 *   a factory cannot express, {@link triggerMetaMatches} builds the meta the
 *   factory WOULD produce from the derived arguments and compares.
 *
 *   So when a factory gains an argument — `tableTrigger`'s `search`, for the
 *   trigger condition (`meta.database.search.expression`) — the decoder widens
 *   on its own: no second place to update, and the fallback narrows without
 *   anyone editing it.
 */
function triggerFactoryArgs(
  a: KindDecodeArgs,
  objType: TriggerInputObjType,
  bindingArg: string | undefined,
  toolsetType?: ToolsetType,
): DefEntry[] | null {
  // A config-only factory has no `response` parameter, so a stored `result[]` on
  // one of those types has nowhere to go. `hasResult` is false for every type
  // outside {@link RESPONSE_BEARING_TRIGGERS}, so this should not occur — but a
  // trigger that stored one anyway would otherwise
  // emit a `response:` argument the factory does not accept, and the generated
  // file would fail to compile rather than merely losing the response.
  if (
    !RESPONSE_BEARING_TRIGGERS.has(objType) &&
    Array.isArray(a.stored.result) &&
    a.stored.result.length > 0
  ) {
    triggerFallback(a, "stores a `result[]` on a config-only trigger type, which takes no `response`");
    return null;
  }

  // A guid binding needs a handle argument to carry it: `CommonArgs.objId` is
  // `number` alone, so emitting a guid there would not even compile. The types
  // with no handle argument bind by numeric id (or not at all), so this is a
  // stored shape that should not exist rather than a common one — but a factory
  // call that fails to parse is worse than a verbose `satisfies`.
  const objId = a.stored.obj_id;
  if (objType !== "database" && bindingArg === undefined && typeof objId === "string" && objId !== "") {
    triggerFallback(a, "binds its target by guid on a type whose factory takes only a numeric `objId`");
    return null;
  }

  const actions = triggerActions(a.stored, objType);
  const datasources = triggerDatasources(a.stored, objType);

  // A trigger condition, inverted through the shared condition decoder. Declining
  // is a real outcome — an expression this decoder cannot invert would otherwise
  // become a trigger with NO filter, which fires for every row instead of the few
  // the source intended. That is a widening, so it falls back rather than degrades.
  const search = triggerSearch(a, objType);
  if (search === "undecodable") {
    triggerFallback(
      a,
      "stores a trigger condition (`meta.database.search.expression`) this decoder " +
        "cannot invert; a factory call would drop it and fire for every row",
    );
    return null;
  }

  if (!triggerMetaMatches(a.stored, objType, actions, datasources, search?.runtime)) {
    triggerFallback(a, "stores `meta` the factory does not synthesize");
    return null;
  }

  return compact([
    ...identity(a),
    plain(a.stored, "active", true),
    plain(a.stored, "description", ""),
    triggerBinding(a, objType, bindingArg),
    actions ? (["actions", lit(actions)] as DefEntry) : null,
    datasources.length > 0 ? (["datasources", lit(datasources)] as DefEntry) : null,
    search ? (["search", search.expr] as DefEntry) : null,
    tags(a.stored),
    history(a),
    ...triggerBody(a, objType, toolsetType),
  ]);
}

/**
 * The bound object, as the named handle argument its factory takes.
 *
 * A guid becomes `table: <handle>` / `mcpServer: <handle>` / `agent: <handle>`,
 * resolved through the ref index exactly like a query's api-group binding — and
 * degrading to `{name, guid}` when the target is outside this bundle, which
 * `resolveRef` reads by guid and so stays faithful.
 *
 * A NUMERIC id keeps `objId`. That is the factories' documented escape hatch and
 * the only form `CommonArgs.objId` accepts — `TriggerDef.objId` is
 * `number | string`, but the factory argument is `number` alone, which is why a
 * guid has to become a handle here rather than passing through.
 */
function triggerBinding(
  a: KindDecodeArgs,
  objType: string,
  bindingArg: string | undefined,
): DefEntry | null {
  const objId = a.stored.obj_id;
  const arg = objType === "database" ? "table" : bindingArg;
  if (arg !== undefined && typeof objId === "string" && objId !== "") {
    return [arg, resolveReference(a.ctx, a.refs, objId, { ...a.resolve, unresolved: "object-ref" })];
  }
  return plain(a.stored, "obj_id", 0, "objId");
}

/**
 * `stack` and `response`, each elided when it equals what the factory injects.
 *
 * See {@link TRIGGER_DEFAULTS} for which types inject anything. Determined by
 * encoding the factory's OWN no-argument output rather than by restating those
 * defaults here, so they cannot drift.
 */
function triggerBody(a: KindDecodeArgs, objType: TriggerInputObjType, toolsetType?: ToolsetType): DefEntry[] {
  const probe = (Object.hasOwn(TRIGGER_DEFAULTS, objType) ? TRIGGER_DEFAULTS[objType] : undefined);
  const injected = probe ? encodeTrigger(probe(toolsetType)) : null;
  const out: DefEntry[] = [];

  const empty = (v: unknown): boolean => v === undefined || v === null || (Array.isArray(v) && v.length === 0);
  // Where the factory injects a default, an EMPTY stored stack or response is
  // written out as `[]`/`{}` — omitting it would re-export the default instead.
  let stackWritten = false;
  if (injected && empty(a.stored.run) && !empty(injected.run)) {
    out.push(["stack", lit([])]);
    stackWritten = true;
  } else if (!injected || !deepEqual(normalize(a.stored.run), normalize(injected.run))) {
    const entry = triggerStack(a, objType, toolsetType);
    if (entry) out.push(entry);
    stackWritten = entry !== null;
  }
  // The response the factory injects beside the stack the call will carry.
  const injectedResult = probe && stackWritten ? encodeTrigger(probe(toolsetType, true)).result : injected?.result;
  if (injected && empty(a.stored.result) && !empty(injectedResult)) {
    out.push(["response", lit({})]);
  } else if (
    Array.isArray(a.stored.result) &&
    a.stored.result.length > 0 &&
    !(injected && deepEqual(normalize(a.stored.result), normalize(injectedResult)))
  ) {
    const decoded = decodeResponse(a.ctx, a.stored.result as never);
    if (decoded) out.push(["response", arrow(["t"], rewriteTriggerInputRefs(decoded, objType, toolsetType))]);
  }
  return out;
}

/** Record why an object took the `satisfies` form instead of its factory. */
function triggerFallback(a: KindDecodeArgs, reason: string): void {
  // `unsupported-section` rather than an error: the emitted def is byte-faithful
  // and deploys correctly. What is lost is the factory's typing, not the object.
  a.ctx.problem(
    "unsupported-section",
    `emitted as \`satisfies TriggerDef\` rather than a factory call — it ${reason}`,
  );
}

/** Stored `meta.<group>.action` → the `actions` argument, true members only. */
function triggerActions(
  stored: StoredObject,
  objType: string,
): Record<string, boolean> | null {
  const spec = (Object.hasOwn(TRIGGER_ACTIONS, objType) ? TRIGGER_ACTIONS[objType] : undefined);
  if (!spec) return null;
  const group = (stored.meta as Record<string, unknown> | undefined)?.[spec.group];
  const flags = (group as { action?: Record<string, unknown> } | undefined)?.action ?? {};
  const out: Record<string, boolean> = {};
  for (const key of spec.keys) if (flags[key] === true) out[key] = true;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Stored `meta.database.search` → the `search` argument.
 *
 * Returns `null` when there is no condition, the decoded pair when there is one,
 * and the sentinel `"undecodable"` when a condition is present but this decoder
 * cannot invert it — three outcomes the caller has to tell apart, because the
 * middle and the last differ by whether the generated trigger fires for the right
 * rows. Speculated so a decline records the reason rather than throwing.
 */
function triggerSearch(
  a: KindDecodeArgs,
  objType: string,
): { expr: Expr; runtime: unknown } | null | "undecodable" {
  if (objType !== "database") return null;
  const meta = a.stored.meta as { database?: { search?: unknown } } | undefined;
  const block = meta?.database?.search as { expression?: unknown } | undefined;
  if (!Array.isArray(block?.expression) || block.expression.length === 0) return null;
  const decoded = a.ctx.speculate(() => decodeCondition(a.ctx, block));
  return decoded ?? "undecodable";
}

/** Stored `meta.database.datasource` (`[{tag}]`) → the `datasources` argument. */
function triggerDatasources(stored: StoredObject, objType: string): string[] {
  if (objType !== "database") return [];
  const meta = stored.meta as { database?: { datasource?: unknown } } | undefined;
  const raw = meta?.database?.datasource;
  return Array.isArray(raw) ? raw.map((e) => String((e as { tag?: unknown })?.tag ?? "")) : [];
}

/**
 * Does the factory synthesize exactly the stored `meta`?
 *
 * Built by CALLING the factory with the derived arguments and encoding the
 * result, so the comparison is against the encoder's real output rather than a
 * restatement of it. Only `meta` is compared: it is the whole of what these three
 * factories synthesize from arguments (`obj_type` and `hasResult` are fixed by
 * which factory ran, and `input` is re-injected identically either way), while
 * the stack passes through the factory untouched and is already covered by the
 * whole-object round trip.
 *
 * Compared under `normalize`, not raw. A stored trigger carries only the meta
 * groups its vintage knew about while the factory always writes all six, and the
 * engine reads those two spellings identically — normalize is where that
 * equivalence lives, so this asks it rather than restating it here.
 */
function triggerMetaMatches(
  stored: StoredObject,
  objType: string,
  actions: Record<string, boolean> | null,
  datasources: readonly string[],
  search: unknown,
): boolean {
  const probe =
    objType === "database"
      ? tableTrigger({
          name: "probe",
          actions: (actions ?? {}) as DatabaseActions,
          datasources: [...datasources],
          // The decoded condition's RUNTIME form, so the probe encodes the real
          // argument rather than a stand-in — this is what makes the comparison
          // cover the condition too instead of quietly excluding it.
          ...(search === undefined || search === null ? {} : { search: search as Condition }),
        })
      : objType === "workspace"
        ? workspaceTrigger({ name: "probe", actions: actions ?? {} })
        : objType === "toolset"
          ? mcpServerTrigger({ name: "probe" })
          : objType === "workspace_realtime_channel"
            ? realtimeTrigger({ name: "probe", actions: actions ?? {} })
            : objType === "channel"
              ? realtimeChannelTrigger({ name: "probe", actions: actions ?? {} })
              : objType === "realtime_server"
                ? realtimeServerTrigger({ name: "probe", actions: actions ?? {} })
                : errorTrigger({ name: "probe" });
  // Wrapped in `{meta}` rather than normalized bare: the inert-group rule is keyed
  // on the `meta` KEY, so it only fires while walking the object that carries it.
  return deepEqual(
    normalize({ meta: encodeTrigger(probe).meta }),
    normalize({ meta: stored.meta ?? {} }),
  );
}

/** `stack: (t) => […]` — the callback form every trigger factory takes. */
function triggerStack(a: KindDecodeArgs, objType: TriggerInputObjType, toolsetType?: ToolsetType): DefEntry | null {
  const run = a.stored.run;
  if (!Array.isArray(run) || run.length === 0) {
    a.ctx.problem("empty-source", "no statements in the source object — emitted without a `stack`");
    return null;
  }
  const decoded = decodeStack(a.ctx, a.refs, run, a.resolve);
  return ["stack", arrow(["t"], rewriteTriggerInputRefs(decoded, objType, toolsetType))];
}

/**
 * The two trigger `obj_type`s whose `obj_id` the engine remaps through the
 * realtime guid helpers — and therefore the two that can arrive blank when the
 * source export's scope did not include the object they point at.
 */
const REALTIME_TRIGGER_OBJ_TYPES = new Set(["channel", "realtime_server"]);

/**
 * A trigger's `obj_id` — the target it fires for.
 *
 * Identical to `plain(a.stored, "obj_id", 0, "objId")` for every trigger type but
 * the two realtime lifecycle ones, where a blank has to be caught. `plain` would
 * emit `objId: ""` verbatim: it compiles (a raw `objId` is the escape hatch, typed
 * `number | string`) and then binds the trigger to nothing, which is the worst of
 * the three possible outcomes — no compile error, no report line, no working
 * trigger. Dropping it instead leaves `objId` absent, which the trigger factories
 * already reject when no handle was passed either.
 *
 * Scoped to the realtime pair deliberately. The engine applies the same
 * degrade-to-blank contract to its table and toolset reference remaps, so those
 * obj_types can carry a blank `obj_id` for the same reason — but that predates
 * this change and is left alone here rather than folded in silently.
 */
function triggerObjId(a: KindDecodeArgs): DefEntry | null {
  const objType = a.stored.obj_type;
  const objId = a.stored.obj_id;
  if (typeof objType === "string" && REALTIME_TRIGGER_OBJ_TYPES.has(objType) && objId === "") {
    missingRealtimeRef(a, "objId", objId);
    return null;
  }
  return plain(a.stored, "obj_id", 0, "objId");
}

/**
 * Record a required realtime reference that arrived with nothing usable in it.
 *
 * Filed as `unresolved-ref` (error severity) because the outcome is the same as a
 * guid missing from the bundle: the generated tree does not reproduce its source.
 * The detail distinguishes the two shapes it comes in, since they have different
 * causes and different fixes — a blank points upstream at the export's scope, a
 * `0`/absent one points at the object itself.
 *
 * Deliberately not a throw. The engine degrades rather than aborting an export
 * for exactly this case, and throwing here would make such an archive
 * un-pullable — strictly worse than a pull that completes with the loss named.
 */
function missingRealtimeRef(a: KindDecodeArgs, defKey: string, id: unknown): void {
  const cause =
    id === ""
      ? "blanked by the source export — its scope did not include the referenced object"
      : "absent or 0 in the source object";
  a.ctx.problem(
    "unresolved-ref",
    `required realtime reference \`${defKey}\` is ${cause}; the generated def omits it and will not encode until it is supplied`,
  );
}

/**
 * A nested config block that elides as a WHOLE when every member is at its
 * engine default, and otherwise emits only its non-default members.
 *
 * Whole-block elision is what keeps generated channels readable: comparing
 * member-by-member would emit `publish: { direct: false }` for a channel that
 * only ever set `who`. `rename` maps stored snake_case members to their
 * authoring names; `defKey` renames the block itself.
 */
function nested(
  a: KindDecodeArgs,
  storedKey: string,
  defaults: Record<string, unknown>,
  rename: Record<string, string> = {},
  defKey = storedKey,
): DefEntry | null {
  const block = a.stored[storedKey] as Record<string, unknown> | undefined;
  if (block === undefined || deepEqual(block, defaults)) return null;
  const entries: DefEntry[] = [];
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = block[key];
    if (value === undefined || deepEqual(value, fallback)) continue;
    entries.push([rename[key] ?? key, lit(value)]);
  }
  return entries.length > 0 ? [defKey, obj(entries)] : null;
}

/** A query's api-group binding: a guid reference, or the numeric escape hatch. */
function apiGroupBinding(a: KindDecodeArgs): DefEntry | null {
  const id = (a.stored.app as { id?: unknown } | undefined)?.id;
  if (id === undefined || id === 0) return null;
  if (typeof id === "number") return ["apiGroupId", lit(id)];
  return [
    "apiGroup",
    resolveReference(a.ctx, a.refs, String(id), { ...a.resolve, unresolved: "object-ref" }),
  ];
}

/**
 * An api group's CORS block, elided when it configures nothing.
 *
 * "Configures nothing" is `normalize`'s call, not a literal comparison against
 * one spelling. A block applies only at `mode: "custom"`, and there are two inert
 * spellings in the wild: the current `mode: "default"` (184 groups in the sweep)
 * and an older one predating `mode` that carries `enabled: false` (4). Comparing
 * against the first alone let the second through — and `CorsConfig` declares no
 * `enabled`, so the emitted literal failed excess-property checking and took the
 * whole generated tree down with it.
 *
 * Asking `normalize` is what makes the elision safe rather than merely plausible:
 * it is the same oracle the round trip is judged against, so a block it calls
 * inert cannot become a mismatch by being dropped. Normalized as a one-key
 * OBJECT because the rule is keyed off the member name.
 */
function cors(a: KindDecodeArgs): DefEntry | null {
  const stored = a.stored.cors;
  if (stored === undefined) return null;
  return deepEqual(normalize({ cors: stored }), {}) ? null : ["cors", lit(stored)];
}

/** A task's schedule list, inverting `encodeSchedule`. */
function schedule(a: KindDecodeArgs): DefEntry | null {
  const stored = a.stored.schedule;
  if (!Array.isArray(stored) || stored.length === 0) return null;
  return [
    "schedule",
    arr(
      stored.map((entry) => {
        const s = entry as {
          starts_on: unknown;
          repeat?: { enabled?: boolean; freq?: number; ends?: { enabled?: boolean; on?: unknown } };
        };
        const repeat = s.repeat ?? {};
        return obj(
          compact([
            ["startsOn", lit(s.starts_on)] as DefEntry,
            // `freq` is never elided: `repeatEnabled` derives from `freq != null`,
            // so dropping it at its default would silently flip `repeat.enabled`.
            repeat.freq !== undefined ? (["freq", lit(repeat.freq)] as DefEntry) : null,
            // Carried whenever it is not the encoder's own filler. An unset end
            // date stores as `on: <starts_on>` with the gate off, which the
            // derivation reproduces exactly — but a REMEMBERED date behind a
            // disabled gate is real stored state, and dropping it did not leave
            // the date missing, it left it silently replaced by `starts_on`.
            repeat.ends !== undefined &&
            (repeat.ends.enabled === true || repeat.ends.on !== s.starts_on)
              ? (["endsOn", lit(repeat.ends.on)] as DefEntry)
              : null,
            // Stated only when the stored gate disagrees with `endsOn != null`,
            // exactly as `repeatEnabled` is below.
            repeat.ends !== undefined &&
            repeat.ends.enabled !== true &&
            repeat.ends.on !== s.starts_on
              ? (["endsEnabled", lit(false)] as DefEntry)
              : null,
            // Stated only when the stored flag disagrees with that derivation.
            repeat.enabled !== (repeat.freq !== undefined)
              ? (["repeatEnabled", lit(repeat.enabled ?? false)] as DefEntry)
              : null,
          ]),
        );
      }),
    ),
  ];
}

/**
 * The workspace tier's flat history map → the author's per-type scalars.
 *
 * `buildWorkspaceHistory` writes every type wholesale, filling absent ones with
 * their engine default, so a type sitting at its default is safely omitted here.
 * An ALL-default map is kept as `history: {}` rather than dropped: the block is
 * written by presence, and an absent one leaves a deploy target's history alone
 * where the stored one RESETS it to the defaults — dropping it changed what the
 * pulled tree does to an environment whose history was since customized, and
 * the re-export no longer carried the source's bytes.
 */
function workspaceHistory(a: KindDecodeArgs): DefEntry | null {
  const block = a.stored.history as Record<string, unknown> | undefined;
  if (block === undefined) return null;
  const entries: DefEntry[] = [];
  for (const type of WORKSPACE_HISTORY_TYPES) {
    const enabled = block[`${type}_enabled`];
    const limit = block[`${type}_limit`];
    if (enabled === undefined && limit === undefined) continue;
    if (enabled === !HISTORY_DEFAULT_OFF.has(type) && limit === 100) continue;
    // No `inherit` at this tier — it is the terminal fallback — so the scalar
    // inverse is fed a synthetic `inherit: false`.
    const scalar = historyScalar({ inherit: false, enabled, limit });
    if (scalar === undefined) {
      a.ctx.problem(
        "verify-mismatch",
        `workspace ${type} history {enabled: ${String(enabled)}, limit: ${String(limit)}} has no scalar authoring form`,
      );
      continue;
    }
    if (scalar !== null) entries.push([type, lit(scalar)]);
  }
  return ["history", obj(entries)];
}

/** Per-host middleware phases the workspace tier stores as a flat 8-key map. */
const WORKSPACE_MIDDLEWARE_HOSTS = ["function", "query", "task", "tool"] as const;

/**
 * The workspace tier's flat `{host}_{phase}` middleware map → the author's
 * nested per-host shape. Like history, an all-empty map is dropped rather than
 * emitted as `middleware: {}` — every workspace in the sweep stores one.
 */
function workspaceMiddleware(a: KindDecodeArgs): DefEntry | null {
  const block = a.stored.middleware as Record<string, unknown> | undefined;
  if (block === undefined) return null;
  const hosts: DefEntry[] = [];
  for (const host of WORKSPACE_MIDDLEWARE_HOSTS) {
    const phases: DefEntry[] = [];
    for (const phase of ["pre", "post"] as const) {
      const list = block[`${host}_${phase}`];
      if (!Array.isArray(list) || list.length === 0) continue;
      phases.push([phase, arr(list.map((e) => middlewareEntry(a, e)))]);
    }
    if (phases.length > 0) hosts.push([host, obj(phases)]);
  }
  return hosts.length === 0 ? null : ["middleware", obj(hosts)];
}

/**
 * A stored block minus the engine's default scaffold — the inverse of
 * {@link mergeOverDefaults}, which the encoder applies on the way back out.
 *
 * Every saved workspace stores `settings` WHOLE, so carrying it verbatim put
 * twenty-odd lines of empty provider config in every pulled tree, in service of
 * (at most) one flag. Subtracting leaves `settings: {ai_enabled: true}`, and
 * drops the key entirely for the 170 of 177 workspaces that never touched AI.
 * `preferences` is the same story at a smaller scale: three lines, 174 of 177 of
 * them at the default.
 *
 * A member the stored block OMITS cannot be expressed by subtraction — the merge
 * would put the default back. No workspace in the corpus is shaped that way, and
 * one that is fails the round trip loudly rather than deploying a member it never
 * had.
 */
function minusDefaults(stored: StoredObject, key: string, defaults: object): DefEntry | null {
  const value = stored[key];
  if (value === undefined) return null;
  const departure = subtractDefaults(value, defaults);
  return departure === undefined ? null : [key, lit(departure)];
}

/**
 * Workspace env vars: stored `env[]` → the declared NAMES, with empty
 * placeholders where the values were.
 *
 * These are hoisted to the bundle's **top-level** `payload.env` on export, not
 * kept on the workspace object, so `decodeBundle` folds them back in before
 * calling this.
 *
 * The VALUES are deliberately dropped. A pulled tree is committed — it is the
 * review surface for the whole backend — and inlining a workspace's secrets into
 * `xano/index.ts` put every one of them in git. They ride out on
 * `GeneratedProject.env` instead, where the CLI uses them in memory for the
 * round-trip check and writes them nowhere; the user supplies them again through
 * `xano/.env`.
 *
 * Declaring the names still matters, and is why this emits an entry at all
 * rather than nothing: `checkEnvNames` returns early on a config that declares
 * zero names, so the placeholders are what keep the `stack.env-undeclared` guard
 * alive against a typo'd `env("NAEM")`. They also make a value from `xano/.env`
 * an OVERRIDE rather than an ADDITION, which keeps that warning meaningful.
 */
function workspaceEnv(a: KindDecodeArgs): DefEntry | null {
  const stored = a.stored.env;
  // A source that declares none still writes `env: {}` — the documented
  // "declared none, on purpose" spelling. Dropping it made the decoded tree read
  // as a config that never named env, so every `env()` read in it was reported
  // as unattached the moment the tree was checked. The encoder writes `env: []`
  // either way, so the bytes are the same.
  const entries = Array.isArray(stored) ? stored : [];
  return ["env", obj(entries.map((e) => [(e as { name: string }).name, lit("")]))];
}

/** Cardinalities `buildContext` can rebuild from `cardinality:` alone. */
const LIFTABLE_CARDINALITY = new Set(["single", "count", "exists"]);

/**
 * `context.return` → `cardinality:`, plus whether the block is fully expressed.
 *
 * `"list"` is the engine default and `buildContext` omits it, so it is never
 * emitted. `"aggregate"` is deliberately excluded: its graft type is derived from
 * `group`/`eval`, which this inverse does not recover, so lifting it would type
 * one shape while the passthrough encodes another.
 */
function addonCardinality(block: unknown): { value: string; whole: boolean } | null {
  if (block === null || typeof block !== "object") return null;
  const type = (block as { type?: unknown }).type;
  if (typeof type !== "string" || !LIFTABLE_CARDINALITY.has(type)) return null;
  // A bare `{type}` is exactly what `buildContext` writes. The engine writes the
  // full four-branch envelope instead, but `normalize` reduces it to the live
  // branch and drops that branch when it holds only editor defaults — so the two
  // spellings are the same bytes far more often than the raw key count suggests.
  // Asking `normalize` is what makes the drop safe rather than merely plausible:
  // it is the same oracle that judges the round trip, so a block it calls equal
  // to `{type}` cannot change the verdict when `cardinality` rebuilds it.
  //
  // A block carrying real configuration (a live sort, a group-by, paging on)
  // survives normalization and rides through `context` as before, with
  // `cardinality` stated alongside it — still correct, since an explicit `return`
  // wins on encode and `buildContext` only rejects a *conflicting* type.
  const reduced = normalize({ return: block }) as { return?: Record<string, unknown> };
  return { value: type, whole: Object.keys(reduced.return ?? {}).length === 1 };
}

/**
 * A `return` block that is exactly what `buildContext` writes for a sorted addon
 * — `{type:"list"|"single", <type>:{sort:[…]}}` — lifted to `sort:` plus, for a
 * single row, `cardinality:`. Null for anything else, which falls back to
 * {@link addonCardinality}.
 *
 * Judged on the `normalize`d block, the same oracle that judges the round trip:
 * the engine writes all four branches with editor defaults beside the live one,
 * and `normalize` reduces that envelope to exactly this shape, so a block it
 * calls equal cannot change the verdict when `sort` rebuilds it.
 */
function addonSortedReturn(
  block: unknown,
): { sort: Expr; cardinality: { value: string; whole: boolean } | null } | null {
  if (block === null || typeof block !== "object") return null;
  const reduced = (normalize({ return: block }) as { return?: Record<string, unknown> }).return;
  const type = reduced?.type;
  if (type !== "list" && type !== "single") return null;
  if (Object.keys(reduced!).some((key) => key !== "type" && key !== type)) return null;
  const branch = reduced![type] as Record<string, unknown> | undefined;
  if (!branch || Object.keys(branch).some((key) => key !== "sort")) return null;
  if (!Array.isArray(branch.sort) || branch.sort.length === 0) return null;
  const sort = addonSort(branch.sort);
  if (!sort) return null;
  return { sort, cardinality: type === "single" ? { value: "single", whole: true } : null };
}

/** `[{sortBy, orderBy}]` → the authoring `[{sortBy, dir?}]` form (mirrors `db.query`'s). */
function addonSort(list: unknown): Expr | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const rows: Expr[] = [];
  for (const raw of list) {
    const sortBy = (raw as { sortBy?: unknown }).sortBy;
    const orderBy = (raw as { orderBy?: unknown }).orderBy;
    if (typeof sortBy !== "string") return null;
    const cells: Array<[string, Expr]> = [["sortBy", lit(sortBy)]];
    // `asc` is the encoder's default, so stating it would be noise.
    if (typeof orderBy === "string" && orderBy !== "asc") cells.push(["dir", lit(orderBy)]);
    rows.push(obj(cells));
  }
  return arr(rows);
}

/** `{customize:true, items:[{name}]}` → the `["id","name"]` column list. */
function addonOutput(stored: unknown): Expr | null {
  if (stored === null || typeof stored !== "object") return null;
  const block = stored as { customize?: unknown; items?: unknown };
  if (block.customize !== true || !Array.isArray(block.items)) return null;
  const names: string[] = [];
  for (const item of block.items) {
    const name = (item as { name?: unknown; children?: unknown }).name;
    // A nested selection has no column-list form; `children: []` is the engine's
    // filler and `normalize` drops it, so only a populated one disqualifies.
    const children = (item as { children?: unknown }).children;
    if (typeof name !== "string") return null;
    if (Array.isArray(children) && children.length > 0) return null;
    names.push(name);
  }
  return lit(names);
}

/**
 * An addon's def entries — the inverse of `buildContext`.
 *
 * An addon persists as one `context` blob, and passing it through verbatim was
 * exact but unreadable: a pulled addon arrived as sixty lines of engine defaults
 * with the table binding buried as a guid. Each authoring surface it can rebuild
 * (`table`, `where`, `sort`, `cardinality`, `output`) is lifted back out, and
 * whatever is left still rides through `context` so nothing is lost. A lifted key
 * is removed from that passthrough — `buildContext` lets an explicit `context`
 * win, so leaving both would silently ignore the readable one.
 */
function addonEntries(a: KindDecodeArgs): DefEntry[] {
  const context = (a.stored.context ?? {}) as Record<string, unknown>;
  const dbo = context.dbo as Record<string, unknown> | undefined;
  const dboId = typeof dbo?.id === "string" ? dbo.id : "";
  const consumed = new Set<string>();

  // A binding is exactly `{id}` plus an optional alias, and both halves now have
  // an authoring form (`table` / `tableAlias`) — so any binding naming a table
  // lifts, whatever its alias. Requiring an EMPTY alias here (which matched what
  // `buildContext` used to write) meant no engine-authored addon ever lifted:
  // Xano's editor writes the alias on every addon it creates, so across a
  // 177-workspace sweep all 187 bound addons carried one, and all 187 leaked the
  // raw `dbo` blob instead of a `table:`.
  //
  // An empty `{as:"", id:""}` still binds nothing at all (`resolveRef` rejects a
  // target with neither name nor guid, so emitting `table:` would be a hard
  // failure rather than a readability loss) — `dboId !== ""` keeps it out.
  const onlyBindingKeys =
    dbo !== undefined && Object.keys(dbo).every((key) => key === "id" || key === "as");
  const bindsTable = dboId !== "" && onlyBindingKeys;
  // A binding naming no table is the engine's *unbound* state — what an addon
  // stores before a table is chosen, and what it falls back to when the table it
  // referenced is deleted. `table: null` says exactly that, and re-encodes to the
  // same empty id; the alternative was leaking the raw `context.dbo` blob, which
  // documents nothing.
  //
  // The alias is NOT part of what makes it unbound: deleting a table clears the
  // id and leaves the alias standing, so `{as:"ledger", id:""}` is just as unbound
  // as `{as:"", id:""}` and is the commoner spelling of the two (11 of 15 in the
  // sweep). Keying this on an empty alias sent all 11 to the passthrough — an
  // equally broken addon, shipped with none of the diagnostic below.
  const unbound = !bindsTable && onlyBindingKeys && dboId === "";
  if (bindsTable || unbound) consumed.add("dbo");
  // The alias is never derived from the table it binds: the engine sanitizes
  // non-identifier characters into it (a `quick-update` table aliased
  // `quick_update`) and leaves it stale after a rename — or after the table is
  // gone entirely — so it round-trips verbatim. Empty is the absent form, which
  // `tableAlias` omits.
  const tableAlias =
    (bindsTable || unbound) && typeof dbo!.as === "string" && dbo!.as !== "" ? dbo!.as : null;
  if (unbound) {
    // A broken object, not a stylistic one — an unbound addon returns nothing
    // wherever it is attached. Reported so it is visible in the pull rather than
    // shipping as a quiet `table: null` nobody reads.
    a.ctx.problem(
      "empty-source",
      "addon is bound to no table (the engine's empty `dbo` binding) — it returns " +
        "nothing wherever it is attached; bind a table in the source workspace",
    );
  }

  const where = decodeCondition(a.ctx, context.search);
  if (where) consumed.add("search");

  // A sorted addon carries its sort inside `return` (see `addonSortedReturn`);
  // any other `return` lifts to `cardinality` alone. A top-level `context.sort`
  // is never read by the engine, so it is not lifted — it rides through
  // `context` as the inert bytes it is.
  const sorted = addonSortedReturn(context.return);
  const sort = sorted?.sort ?? null;
  const cardinality = sorted ? sorted.cardinality : addonCardinality(context.return);
  if (sorted || cardinality?.whole) consumed.add("return");

  const output = addonOutput(a.stored.output);

  // Whatever no authoring surface claimed. `buildContext` spreads `def.context`
  // first and only auto-fills what it does not already carry, so a rich engine
  // context (bind/eval/lock/future) survives untouched — whereas hoisting those
  // keys would silently drop every one the authoring surface cannot declare.
  //
  // Members sitting at their engine default are dropped, which is what makes an
  // unbound addon readable at all: the engine writes the whole
  // bind/eval/lock/return/external/simpleExternal envelope even when nothing is
  // customized. Safe by construction, and deliberately keyed on `normalize`'s own
  // oracle rather than a second list — it already elides these on BOTH sides of
  // the round-trip comparison, so a dropped member cannot change the verdict.
  const passthrough = Object.fromEntries(
    Object.entries(context).filter(
      ([key, value]) => !consumed.has(key) && !isDefaultEnvelopeMember(key, value),
    ),
  );

  return compact([
    ...identity(a),
    plain(a.stored, "description", ""),
    bindsTable
      ? ([
          "table",
          resolveReference(a.ctx, a.refs, dboId, { ...a.resolve, unresolved: "object-ref" }),
        ] as DefEntry)
      : unbound
        ? (["table", lit(null)] as DefEntry)
        : null,
    tableAlias ? (["tableAlias", lit(tableAlias)] as DefEntry) : null,
    inputs(a),
    where ? (["where", where.expr] as DefEntry) : null,
    sort ? (["sort", sort] as DefEntry) : null,
    output
      ? (["output", output] as DefEntry)
      : // `{items:[],customize:false}` is "no selection", which `buildOutput`
        // rebuilds from an absent `output` — and `normalize` already elides on
        // both sides, so dropping it cannot change the round trip.
        a.stored.output === undefined || isEmptyOutput(a.stored.output)
        ? null
        : (["output", lit(a.stored.output)] as DefEntry),
    cardinality ? (["cardinality", lit(cardinality.value)] as DefEntry) : null,
    Object.keys(passthrough).length > 0 ? (["context", lit(passthrough)] as DefEntry) : null,
    tags(a.stored),
  ]);
}

// --- MCP metadata (tool / prompt / resource) ----------------------------------

/**
 * The file name an icon `src` ends in when it names a file-library entry — a
 * backend's own `/vault/…` path or a bundle's `xanosdk-file://` placeholder —
 * else `undefined`.
 */
function libraryFileName(src: unknown): string | undefined {
  if (typeof src !== "string" || !(src.startsWith("/vault/") || src.startsWith(HOSTED_FILE_SCHEME))) return undefined;
  const last = src.split("/").pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Stored icons → `McpIcon[]`, dropping each member at its unset spelling. */
function mcpIcons(a: KindDecodeArgs): DefEntry | null {
  const stored = a.stored.icons;
  if (!Array.isArray(stored) || stored.length === 0) return null;
  return [
    "icons",
    arr(
      stored.map((raw, i) => {
        const icon = raw as { src?: unknown; mime_type?: unknown; sizes?: unknown; theme?: unknown };
        const file = libraryFileName(icon.src);
        // A bundle's placeholder names a file the bundle never carried, so the
        // literal can never ship from anywhere. The `hostedFile()` line is
        // written instead: the tree then fails to export or deploy with "no file
        // at <path>" until the image is saved there, rather than looping.
        const placeholder = file !== undefined && String(icon.src).startsWith(HOSTED_FILE_SCHEME);
        if (file !== undefined) {
          a.ctx.problem(
            "file-not-recovered",
            placeholder
              ? `\`icons[${i}]\` names ${JSON.stringify(file)}, a file the bundle did not carry. The tree reads it with ` +
                  `\`src: hostedFile("./${file}", import.meta.url)\` — save the image as ${file} beside the module that ` +
                  `declares it; until then \`export\` and \`deploy\` refuse with "no file at".`
              : `\`icons[${i}]\` names ${JSON.stringify(icon.src)}, a file the source serves but did not carry, so the icon ` +
                  `answers 404 on any other backend. Save the image in the repo and use ` +
                  `\`src: hostedFile("./${file}", import.meta.url)\`.`,
          );
        }
        if (placeholder) a.ctx.imports.use(SDK_MODULE, "hostedFile");
        return obj(
          compact([
            ["src", placeholder ? call("hostedFile", lit(`./${file}`), id("import.meta.url")) : lit(icon.src)],
            typeof icon.mime_type === "string" && icon.mime_type !== "" ? ["mimeType", lit(icon.mime_type)] : null,
            Array.isArray(icon.sizes) && icon.sizes.length > 0 ? ["sizes", lit(icon.sizes)] : null,
            typeof icon.theme === "string" && icon.theme !== "" ? ["theme", lit(icon.theme)] : null,
          ]),
        );
      }),
    ),
  ];
}

/** Stored tool hints (`read_only_hint: true`) → `annotations: { readOnlyHint: true }`; `null` is unset. */
function toolAnnotations(a: KindDecodeArgs): DefEntry | null {
  const stored = a.stored.annotations as Record<string, unknown> | undefined;
  if (stored === undefined || stored === null || typeof stored !== "object") return null;
  const entries = Object.entries(TOOL_ANNOTATION_WIRE).flatMap(([hint, key]) =>
    typeof stored[key] === "boolean" ? [[hint, lit(stored[key])] as DefEntry] : [],
  );
  return entries.length > 0 ? ["annotations", obj(entries)] : null;
}

/** Stored resource annotations → `{ audience?, priority?, lastModified? }`; empty/null members are unset. */
function resourceAnnotations(a: KindDecodeArgs): DefEntry | null {
  const stored = a.stored.annotations as Record<string, unknown> | undefined;
  if (stored === undefined || stored === null || typeof stored !== "object") return null;
  const entries = compact([
    Array.isArray(stored.audience) && stored.audience.length > 0 ? ["audience", lit(stored.audience)] : null,
    typeof stored.priority === "number" ? ["priority", lit(stored.priority)] : null,
    typeof stored.last_modified === "string" && stored.last_modified !== ""
      ? ["lastModified", lit(stored.last_modified)]
      : null,
  ]);
  return entries.length > 0 ? ["annotations", obj(entries)] : null;
}

/** A tool's `output_schema[]` → `output: {…}`, the same field grammar as `input`. */
function toolOutputSchema(a: KindDecodeArgs): DefEntry | null {
  const stored = a.stored.output_schema;
  if (!Array.isArray(stored) || stored.length === 0) return null;
  a.ctx.use(SDK_MODULE, "input");
  return ["output", decodeFieldMap(a.ctx, a.refs, stored as never, "input", a.resolve)];
}

/** The shared toolset envelope both mcp-server and agent carry. */
function toolsetBaseEntries(a: KindDecodeArgs): DefEntry[] {
  return compact([
    ...identity(a),
    plain(a.stored, "description", ""),
    plain(a.stored, "instructions", ""),
    plain(a.stored, "docs", ""),
    plain(a.stored, "enabled", true),
    plain(a.stored, "canonical", ""),
    plain(a.stored, "spec", ""),
    containerHistory(a, "tool"),
    tags(a.stored),
    toolRefs(a),
  ]);
}

/**
 * An MCP server's `prompt[]` / `resource[]` refs → `prompts` / `resources`,
 * inverting `encodePrimitiveRefs`. A plain enabled, unauthenticated entry is
 * the bare handle; anything else is the wrapper.
 */
function primitiveRefs(a: KindDecodeArgs, kind: "prompt" | "resource"): DefEntry | null {
  const stored = a.stored[kind];
  if (!Array.isArray(stored) || stored.length === 0) return null;
  return [
    `${kind}s`,
    arr(
      stored.map((entry) => {
        const t = entry as { id: unknown; enabled?: boolean; auth?: unknown };
        const target =
          typeof t.id === "string"
            ? resolveReference(a.ctx, a.refs, t.id, { ...a.resolve, unresolved: "object-ref" })
            : undefined;
        const extras = compact([t.enabled === false ? (["enabled", lit(false)] as DefEntry) : null, authRef(a, t.auth)]);
        if (target !== undefined && extras.length === 0) return target;
        return obj(compact([target !== undefined ? ([kind, target] as DefEntry) : (["id", lit(t.id)] as DefEntry), ...extras]));
      }),
    ),
  ];
}

/**
 * An MCP server's stored `oauth` block → the `oauth` authoring block,
 * inverting `encodeMcpOauth`. `mode` and `authTable` are written always, every
 * other key only when it differs from its default — the order and the elision
 * the platform's own XanoScript rendering uses. A value that is exactly one
 * `${env.NAME}` reference comes back as `env("NAME")`. Absent, null or empty:
 * no key, so a server without sign-in decodes exactly as before. A row stored
 * before the platform dropped `consent`, `branding` and `trusted_clients` may
 * still carry them; nothing reads them any more, so they are ignored.
 */
function mcpOauth(a: KindDecodeArgs): DefEntry | null {
  const stored = a.stored.oauth;
  if (stored === null || typeof stored !== "object" || Array.isArray(stored) || Object.keys(stored).length === 0) return null;
  const o = stored as Record<string, unknown>;
  const str = (k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");
  const list = (k: string): string[] => (Array.isArray(o[k]) ? (o[k] as unknown[]).filter((v): v is string => typeof v === "string") : []);
  const envOr = (v: string): Expr => {
    const m = MCP_OAUTH_ENV_REF.exec(v);
    return m ? call(a.ctx.use(SDK_MODULE, "env"), lit(m[1])) : lit(v);
  };
  const mode = str("mode");
  const hosted = mode === "hosted";
  const table = o.auth_table;
  let authTable: Expr;
  if (typeof table === "number" && table > 0) authTable = lit(table);
  else if (typeof table === "string" && table !== "") {
    authTable = resolveReference(a.ctx, a.refs, table, { ...a.resolve, unresolved: "object-ref" });
  } else {
    a.ctx.problem(
      "blank-binding",
      "`oauth.auth_table` names no table (the archive was cut with the table out of scope, or it was never set). " +
        "The platform refuses to save a sign-in with no auth table — set `authTable` to the auth table.",
    );
    authTable = lit(0);
  }
  const entries: Array<DefEntry | null> = [["mode", lit(mode)], ["authTable", authTable]];
  // The keys of the OTHER mode have no spelling on this mode's def. The
  // platform stores them anyway (at their defaults, unless a document set
  // them), so a non-default one is reported rather than silently dropped.
  const isSet = (k: string): boolean => str(k) !== "" || list(k).length > 0 || o[k] === true;
  const otherModeSet = hosted
    ? ["issuer", "audience", "audience_ack", "claim_ack", "column", "preset", "allowed_client_ids"]
      .filter(isSet)
      .concat(str("claim") !== "" && str("claim") !== "sub" ? ["claim"] : [])
    : ["login_url"].filter(isSet);
  if (otherModeSet.length > 0) {
    a.ctx.problem(
      "unsupported-section",
      `\`oauth\` is ${mode} mode but also stores ${otherModeSet.join(", ")}, which only the other mode reads. ` +
        `They are not written to the def, so a push clears them — the platform ignores them in this mode either way.`,
    );
  }
  if (hosted) {
    entries.push(["loginUrl", envOr(str("login_url"))]);
  } else {
    entries.push(["issuer", envOr(str("issuer"))]);
    if (list("audience").length > 0) entries.push(["audience", arr(list("audience").map(envOr))]);
    if (o.audience_ack === true) entries.push(["audienceAck", lit(true)]);
    if (str("claim") !== "" && str("claim") !== "sub") entries.push(["claim", lit(str("claim"))]);
    if (o.claim_ack === true) entries.push(["claimAck", lit(true)]);
    entries.push(["column", lit(str("column"))]);
    if (str("preset") !== "") entries.push(["preset", lit(str("preset"))]);
    if (list("allowed_client_ids").length > 0) entries.push(["allowedClientIds", lit(list("allowed_client_ids"))]);
  }
  return ["oauth", obj(compact(entries))];
}

/** A toolset's `tool[]` refs, inverting `encodeToolRefs`. */
function toolRefs(a: KindDecodeArgs): DefEntry | null {
  const stored = a.stored.tool;
  if (!Array.isArray(stored) || stored.length === 0) return null;
  return [
    "tools",
    arr(
      stored.map((entry) => {
        const t = entry as {
          id: unknown;
          enabled?: boolean;
          auth?: unknown;
          type?: unknown;
          resource_uri?: unknown;
          tool_meta?: unknown;
        };
        return obj(
          compact([
            typeof t.id === "string"
              ? ([
                  "tool",
                  resolveReference(a.ctx, a.refs, t.id, {
                    ...a.resolve,
                    unresolved: "object-ref",
                  }),
                ] as DefEntry)
              : (["id", lit(t.id)] as DefEntry),
            t.enabled === false ? (["enabled", lit(false)] as DefEntry) : null,
            // Same hazard as a query's `auth`: a bare guid string here is read
            // as a table NAME and re-derived into a different guid.
            authRef(a, t.auth),
            // The MCP connection fields. All three are presence-preserving on
            // both sides: absent from a stored entry, absent from the def. The
            // engine keeps `resource_uri` only on a resource and `tool_meta`
            // only on a tool, so a stale value on the wrong type cannot reach
            // here — and the encoder refuses to author one.
            t.type === "resource" ? (["type", lit("resource")] as DefEntry) : null,
            t.type === "resource" && typeof t.resource_uri === "string" && t.resource_uri !== ""
              ? (["resourceUri", lit(t.resource_uri)] as DefEntry)
              : null,
            t.type !== "resource" && typeof t.tool_meta === "string" && t.tool_meta !== ""
              ? (["toolMeta", lit(t.tool_meta)] as DefEntry)
              : null,
          ]),
        );
      }),
    ),
  ];
}


/**
 * The stored provider config's wire keys → the `llm` authoring keys.
 *
 * The two disagree in more than casing — `useSearchGrounding` is authored as
 * `searchGrounding`, `dynamicRetrievalConfig` as `dynamicRetrieval` — and the
 * thinking blocks are nested on the wire but flat in the authoring surface. A
 * blind spread produces a def that still re-encodes to the right bytes (the
 * renamed keys are simply ignored and their defaults re-emitted) while failing
 * to type-check, which is why the generated tree is type-checked and not only
 * round-tripped.
 */
const PROVIDER_CONFIG_KEYS: ReadonlyArray<readonly [string, string, unknown]> = [
  ["apiKey", "apiKey", ""],
  ["model", "model", ""],
  ["temperature", "temperature", 1],
  ["sendReasoning", "sendReasoning", true],
  ["reasoningEffort", "reasoningEffort", "medium"],
  ["organization", "organization", ""],
  ["project", "project", ""],
  ["compatibility", "compatibility", "strict"],
  ["useSearchGrounding", "searchGrounding", false],
  ["baseURL", "baseURL", ""],
  ["headers", "headers", ""],
  ["safetySettings", "safetySettings", ""],
  ["dynamicRetrievalConfig", "dynamicRetrieval", ""],
];

/**
 * The stored provider-config keys each provider's TYPED surface declares.
 *
 * Mirrors `buildProviderConfig` one provider at a time, and is pinned against it
 * by a drift test. The providers are not interchangeable: `xano-free` is a
 * wrapper that declares no `model`/`apiKey` of its own, even though the stored
 * config can carry both. Reading one onto the typed field emitted a generated
 * tree that does not type-check — the failure the flat key table could not see,
 * because it did not know which provider it was reading for.
 */
export const PROVIDER_TYPED_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  anthropic: new Set(["apiKey", "model", "temperature", "sendReasoning", "thinking", "baseURL", "headers"]),
  openai: new Set([
    "apiKey", "model", "temperature", "reasoningEffort", "baseURL", "headers",
    "organization", "project", "compatibility",
  ]),
  "google-genai": new Set([
    "apiKey", "model", "temperature", "useSearchGrounding", "thinkingConfig", "baseURL",
    "headers", "safetySettings", "dynamicRetrievalConfig",
  ]),
  "xano-free": new Set([
    "temperature", "useSearchGrounding", "thinkingConfig", "baseURL", "headers",
    "safetySettings", "dynamicRetrievalConfig",
  ]),
};

/** Flatten a stored provider config into `llm` authoring entries. */
function providerConfigEntries(provider: string, config: Record<string, unknown>): DefEntry[] {
  const entries: DefEntry[] = [];
  const typed = (Object.hasOwn(PROVIDER_TYPED_KEYS, provider) ? PROVIDER_TYPED_KEYS[provider] : undefined);
  for (const [storedKey, defKey, fallback] of PROVIDER_CONFIG_KEYS) {
    if (!Object.hasOwn(config, storedKey)) continue;
    if (typed !== undefined && !typed.has(storedKey)) continue;
    const value = config[storedKey];
    if (deepEqual(value, fallback)) continue;
    entries.push([defKey, lit(value)]);
  }

  // Anthropic nests its thinking budget behind an enabled/disabled discriminator;
  // the authoring surface is a single optional token count.
  const thinking = config.thinking as { type?: string; budgetTokens?: unknown } | undefined;
  if (thinking?.type === "enabled" && thinking.budgetTokens !== undefined) {
    entries.push(["thinkingTokens", lit(thinking.budgetTokens)]);
  }

  // Google-GenAI (and the xano-free wrapper) nest theirs in `thinkingConfig`.
  const thinkingConfig = config.thinkingConfig as
    | { includeThoughts?: unknown; thinkingBudget?: unknown }
    | undefined;
  if (thinkingConfig?.includeThoughts === true) entries.push(["includeThoughts", lit(true)]);
  if (thinkingConfig?.thinkingBudget !== undefined && thinkingConfig.thinkingBudget !== 0) {
    entries.push(["thinkingBudget", lit(thinkingConfig.thinkingBudget)]);
  }

  // Anything this provider's typed surface cannot spell rides `extraConfig`, the
  // forward-compat hatch `buildProviderConfig` already merges last — so it
  // re-encodes verbatim. Skipping these dropped real stored settings silently.
  if (typed !== undefined) {
    const extra = Object.entries(config).filter(([key]) => !typed.has(key));
    if (extra.length > 0) entries.push(["extraConfig", obj(extra.map(([k, v]) => [k, lit(v)]))]);
  }
  return entries;
}

/** Does this toolset store a settings block with anything in it? */
function hasAgentSettings(a: KindDecodeArgs): boolean {
  const settings = a.stored.agent_settings;
  if (typeof settings !== "object" || settings === null || Object.keys(settings).length === 0) {
    return false;
  }
  // Present but BLANK is the same as absent: an MCP toolset that configures no
  // model still gets the whole block written, and it is inert (see
  // {@link isBlankAgentSettings}). Reading it as authored produced an `llm` with
  // a blank provider type, which then re-encoded as the SDK's `prompt` default
  // and failed to round-trip — one live toolset, invisible to the offline corpus.
  return !isBlankAgentSettings(settings);
}

/** A toolset's `agent_settings` → the `llm` and `output` authoring blocks. */
function agentSettingsEntries(a: KindDecodeArgs): DefEntry[] {
  const settings = (a.stored.agent_settings ?? {}) as Record<string, unknown>;
  const type = String(settings.type ?? "");
  const configs = (settings.configs ?? {}) as Record<string, unknown>;
  const providerConfig = (configs[type] ?? {}) as Record<string, unknown>;

  const llm = compact([
    ["type", lit(type)] as DefEntry,
    settings.system_prompt ? (["systemPrompt", lit(settings.system_prompt)] as DefEntry) : null,
    settings.max_steps !== undefined && settings.max_steps !== 5
      ? (["maxSteps", lit(settings.max_steps)] as DefEntry)
      : null,
    settings.prompt_type === "messages"
      ? (["messages", lit(settings.prompt_messages)] as DefEntry)
      : settings.prompt
        ? (["prompt", lit(settings.prompt)] as DefEntry)
        : null,
    ...providerConfigEntries(type, providerConfig),
  ]);

  const entries: DefEntry[] = [["llm", obj(llm)]];

  const schema = settings.structuredOutputsSchema;
  if (Array.isArray(schema) && schema.length > 0) {
    a.ctx.use(SDK_MODULE, "input");
    entries.push([
      "output",
      obj(
        compact([
          settings.structuredOutputs === false ? (["enabled", lit(false)] as DefEntry) : null,
          ["schema", decodeFieldMap(a.ctx, a.refs, schema as never, "input", a.resolve)] as DefEntry,
        ]),
      ),
    ]);
  }
  return entries;
}

/** Kind decoders keyed by kind name. */
export const KIND_DECODERS_BY_NAME: ReadonlyMap<string, KindDecoder> = new Map(
  KIND_DECODERS.map((decoder) => [decoder.name, decoder]),
);

/**
 * Decode one stored object into its def literal expression and the factory that
 * literal is wrapped in.
 *
 * The factory is resolved HERE rather than by the caller because for a per-object
 * kind it is a by-product of decoding — the trigger decoder cannot know whether a
 * factory form round-trips until it has built the arguments and checked them.
 */
export function decodeObject(
  decoder: KindDecoder,
  args: KindDecodeArgs,
): { readonly expr: Expr; readonly factory?: string } {
  const decoded = decoder.decode(args);
  const entries: readonly DefEntry[] = Array.isArray(decoded) ? decoded : (decoded as DecodedDef).entries;
  // The live contract's advisories, accepted on the def (see accept-on-decode).
  const allow = acceptedOnDecode(decoder.name, args.stored, args.payload);
  const withAllow = allow.length === 0 ? entries : [...entries, ["diagnostics", obj([["allow", lit(allow)]])] as DefEntry];
  return { expr: obj(withAllow), factory: Array.isArray(decoded) ? decoder.factory : (decoded as DecodedDef).factory };
}

/** Re-exported for project assembly, which builds the barrel's register calls. */
export { id as symbolExpr };
