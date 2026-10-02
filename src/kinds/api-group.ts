/**
 * API group kind → payload key `app` (stored as `mvp_app`). A metadata
 * container: queries bind to it via `app.id`. Carries CORS + group middleware.
 * Validated against the Xano engine's persisted shape.
 */
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";
import type { MiddlewareBlock } from "./common.js";
import { buildMiddlewareBlock } from "./middleware-attach.js";
import type { MiddlewareAttach } from "./middleware-attach.js";
import { encodeContainerHistory, type ContainerHistoryBlock, type HistoryInput } from "./history.js";
import { assertCanonical } from "./stored-name.js";
import { assertOneOf } from "./closed-set.js";
import type { DiagnosticsFor } from "../workspace/diagnostics.js";

/** The three CORS modes the engine stores. */
export const CORS_MODES = ["default", "custom", "disabled"] as const;

export type CorsMode = (typeof CORS_MODES)[number];

/**
 * Group-level CORS policy.
 *
 * ⚠ Every field except `mode` applies ONLY under `mode: "custom"`. Under
 * `"default"` the engine serves a fixed permissive policy (any origin,
 * `allow-headers: *`, `allow-credentials: true`, `max-age: 86400`) and IGNORES
 * the rest of this block, so setting `maxAge`/`allowCredentials`/`allowHeaders`
 * without switching to `"custom"` changes nothing.
 */
export interface CorsConfig {
  /**
   * `"default"` (the default) — fixed permissive policy, rest of the block
   * ignored. `"custom"` — this block is applied. `"disabled"` — no CORS headers
   * at all, so browsers reject every cross-origin call.
   */
  mode?: CorsMode;
  /**
   * Allowed origins, matched EXACTLY (scheme + host + port, no wildcard or
   * subdomain expansion) against the request's `Origin` under `mode: "custom"`.
   * A request whose origin is not listed gets NO CORS headers at all — the
   * browser then reports a missing `Access-Control-Allow-Origin`. `"*"` is not
   * special here: it is compared as a literal origin and matches nothing. To
   * allow any origin, use `mode: "default"`. An http(s) entry that is not a bare
   * origin — a trailing slash, a path, no scheme, an uppercase host, a `*.`
   * subdomain — can never match and is refused.
   */
  allowOrigins?: string[];
  /** Allowed request headers under `mode: "custom"`. Empty falls back to `*`. */
  allowHeaders?: string[];
  /** Send `access-control-allow-credentials` under `mode: "custom"`. */
  allowCredentials?: boolean;
  /** Preflight cache seconds under `mode: "custom"`. `0` omits the header. */
  maxAge?: number;
  /**
   * Methods allowed under `mode: "custom"`. This also GATES the real response:
   * a request whose method is not enabled here gets no CORS headers back, even
   * though its preflight passes. Enable every verb the group's queries use.
   * Leaving all of them off sends no `access-control-allow-methods` header.
   */
  allowMethods?: {
    delete?: boolean;
    get?: boolean;
    head?: boolean;
    patch?: boolean;
    post?: boolean;
    put?: boolean;
  };
}

/**
 * An API group's documentation gate, as an author writes it.
 *
 * Fully modeled, unlike the workspace's: the engine stores exactly these two
 * members, so there is nothing to carry verbatim.
 */
export interface ApiGroupDocumentationDef {
  /**
   * `true` gates this group's hosted docs behind a token, and IS the declaration
   * that a token exists — the value lives in `xano/.secrets.json`, keyed by this
   * group's guid, and is substituted when a bundle is built.
   */
  require_token?: boolean;
  /**
   * REFUSED. A token is a secret and this is committed source, so spelling one
   * here fails the export. Set `require_token: true` and let `xanosdk pull` store
   * the value, or supply it with `--doc-token "<group name>=<value>"`.
   *
   * Present on the type only so the refusal can name what it found; a literal
   * token in a pulled tree has already been disclosed and should be rotated.
   */
  token?: string;
}

export interface ApiGroupDef {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "api_group";
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  canonical?: string;
  description?: string;
  docs?: string;
  swagger?: boolean;
  apiGroupEnabled?: boolean;
  /**
   * The gate on this group's hosted API documentation.
   *
   * Unlike the workspace's block, this one is ALWAYS emitted — measured: an
   * absent `documentation` key on a group is written as the engine default on
   * import, so omitting it here clears the gate rather than leaving it alone.
   * Omit it only when you mean the group's docs to be ungated.
   *
   * The TOKEN IS A SECRET and cannot be spelled here — a literal `token` fails
   * the export. Declaring the gate is all the source does:
   *
   * ```ts
   * documentation: { require_token: true }
   * ```
   *
   * The value lives in `xano/.secrets.json`, keyed by this group's guid, written
   * by `xanosdk pull` and read back when a bundle is built. It is NOT a backend
   * env var: it never reaches the workspace's own `env`, and `env(...)` in a
   * stack does not read it. A declared gate with no value anywhere refuses a
   * `deploy`, and fails every bundle-producing command when this group publishes
   * docs — because those bytes would clear the gate on import.
   */
  documentation?: ApiGroupDocumentationDef;
  cors?: CorsConfig;
  /**
   * Group-level pre/post middleware. Queries in this group inherit this chain
   * when they don't set their own `middleware` (the API-Group tier of the
   * Query → API Group → Workspace fallback). Providing a phase sets its
   * `_customize` flag; `pre: middleware.clear()` overrides with nothing.
   */
  middleware?: MiddlewareAttach;
  /**
   * Group-level request-history default. This is the container tier queries in
   * the group inherit from (stored `query_enabled`/`query_limit`). Omit to
   * inherit from the workspace. A scalar: `false` off, `true` on at default
   * depth, a number = capture depth, `"all"` unlimited. See {@link HistoryInput}.
   */
  history?: HistoryInput;
  /** Workspace tags (stored `tag: [{tag}]`), e.g. `["xano:quick-start"]`. */
  tags?: string[];
  /** Accepted export warnings for this group — `{ allow: ["api-group.docs-public"] }` for docs meant to be public. Never emitted. */
  diagnostics?: DiagnosticsFor<"api_group">;
}

export interface ApiGroupXdo {
  name: string;
  description: string;
  canonical: string;
  swagger: boolean;
  api_group_enabled: boolean;
  docs: string;
  /**
   * Always present. An ungated group carries `token: ""` — the engine's own
   * default, and what an absent key becomes on import, so writing it is what
   * makes an ungated group round-trip.
   *
   * A DECLARED gate leaves here with no `token` key at all, which is how the
   * bundle build tells "still to be supplied" from "resolved to an empty token
   * on purpose". It fills the value from the sidecar or DROPS the whole block
   * (see `resolveDocumentationTokens`) rather than sending an empty token to a
   * gate somebody asked for.
   */
  documentation: { require_token: boolean; token?: string };
  middleware: MiddlewareBlock;
  history: ContainerHistoryBlock<"query">;
  tag: unknown[];
  cors: Required<CorsConfig> & {
    allowMethods: Required<NonNullable<CorsConfig["allowMethods"]>>;
  };
}

/**
 * Encode the group's CORS block, refusing a `mode` outside the three.
 *
 * This one fails harder than its neighbours. A `verb` or `response_type` the
 * engine cannot store lands as NULL and the object survives; a `cors.mode` it
 * cannot store takes the WHOLE API GROUP with it. Verified live on an ephemeral
 * (see `examples/sandbox/_probe-closed-set.ts`): two groups identical but for
 * `mode`, deployed together with no error or warning at export, import or
 * rollout — the `"custom"` one persisted intact and the `"Custom"` one was
 * simply absent from the deployed workspace, leaving every query bound to it
 * with no group to answer under.
 */
function encodeCors(context: string, cors?: CorsConfig, allow?: readonly string[]): ApiGroupXdo["cors"] {
  assertOneOf(
    context,
    "cors.mode",
    cors?.mode,
    CORS_MODES,
    "The engine does not reject an unrecognized mode and does not blank the field — it DROPS " +
      "THE ENTIRE API GROUP on import. The deploy reports success, the group is missing, and " +
      'every query in it 404s "Unable to locate request."',
  );
  const unmatchable = cors?.mode === "custom" ? unmatchableOrigins(cors.allowOrigins ?? []) : [];
  if (unmatchable.length > 0 && !(allow ?? []).includes(CORS_UNMATCHABLE)) {
    throw new Error(`${context}: ${describeUnmatchableOrigins(unmatchable)}`);
  }
  return {
    mode: cors?.mode ?? "default",
    allowOrigins: cors?.allowOrigins ?? [],
    allowHeaders: cors?.allowHeaders ?? [],
    allowCredentials: cors?.allowCredentials ?? false,
    maxAge: cors?.maxAge ?? 0,
    allowMethods: {
      delete: cors?.allowMethods?.delete ?? false,
      get: cors?.allowMethods?.get ?? false,
      head: cors?.allowMethods?.head ?? false,
      patch: cors?.allowMethods?.patch ?? false,
      post: cors?.allowMethods?.post ?? false,
      put: cors?.allowMethods?.put ?? false,
    },
  };
}

/** The diagnostic a pulled group carries for a stored origin the authoring rule refuses. */
export const CORS_UNMATCHABLE = "api-group.cors-origin-unmatchable";

/**
 * The `allowOrigins` entries no browser `Origin` can ever equal, each with the
 * origin it most likely meant. The engine compares the header exactly, and a
 * browser sends `scheme://host[:port]` — lowercase host, default port dropped,
 * no path or trailing slash. `"*"` (warned on its own), `"null"` and non-http
 * schemes (`chrome-extension://…`, which browsers do send) are not judged.
 */
export function unmatchableOrigins(origins: readonly unknown[]): { origin: string; fix?: string }[] {
  const out: { origin: string; fix?: string }[] = [];
  for (const origin of origins) {
    if (typeof origin !== "string" || origin === "*" || origin === "null") continue;
    if (origin.includes("*")) {
      out.push({ origin });
      continue;
    }
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(origin.trim())?.[1]?.toLowerCase();
    if (scheme !== undefined && scheme !== "http" && scheme !== "https") continue;
    const fix = httpOrigin(scheme === undefined ? `${LOCAL_HOST.test(origin.trim()) ? "http" : "https"}://${origin.trim()}` : origin);
    if (fix !== origin) out.push({ origin, ...(fix !== undefined ? { fix } : {}) });
  }
  return out;
}

/** A host a dev server answers on over plain http: loopback, a private address, `.local`/`.localhost`. */
const LOCAL_HOST =
  /^(localhost|[^/:]*\.(localhost|local)|127(\.\d+){3}|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|\[::1\]|0\.0\.0\.0)\.?(:\d*)?([/?#]|$)/i;

function httpOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** One sentence per refused origin, with the fix. */
export function describeUnmatchableOrigins(entries: readonly { origin: string; fix?: string }[]): string {
  const each = entries.map(({ origin, fix }) =>
    origin.includes("*")
      ? `${JSON.stringify(origin)} — there is no wildcard or subdomain matching; list each origin`
      : fix !== undefined
        ? `${JSON.stringify(origin)} — write ${JSON.stringify(fix)}`
        : `${JSON.stringify(origin)} — not an origin`,
  );
  return (
    `\`cors.allowOrigins\` ${entries.length === 1 ? "entry" : "entries"} ${each.join("; ")}. The engine compares the ` +
    `request's \`Origin\` exactly, and a browser sends \`scheme://host[:port]\` (lowercase host, no path or trailing ` +
    `slash), so ${entries.length === 1 ? "this entry never matches" : "these never match"} and those calls get no ` +
    `\`access-control-*\` headers.`
  );
}

/**
 * The stored `documentation` block for one group.
 *
 * ALWAYS emitted, present or not — measured: an absent key on a group is
 * written as the engine default on import, the opposite of the workspace rule.
 * Presence-only emission here would perform the wipe rather than prevent it, and
 * would do it silently, since the tree would look correct. The guard for an
 * ungated group is `checkApiGroupDocsExposure`, source-side, not this.
 */
function encodeApiGroupDocumentation(
  doc: ApiGroupDocumentationDef | undefined,
): ApiGroupXdo["documentation"] {
  // A block that names no token leaves here with NO `token` key, which is how
  // `resolveDocumentationTokens` tells "still to be supplied" from "resolved to
  // an empty token on purpose". It substitutes the sidecar's value before the
  // bundle is signed, or drops the whole block.
  //
  // Gated or not. A group may store a token with `require_token: false` — the
  // engine reads that as not gated but keeps the value — and emitting `token:
  // ""` for it shipped the bytes that CLEAR it. Only the gate decides what an
  // unsupplied value means, never whether one gets looked up.
  //
  // An ABSENT `documentation` def is the exception and still carries `token: ""`
  // — the engine's own default, and what an absent key becomes on import, so
  // writing it is what makes an ungated group round-trip. It is also the one
  // shape that must NOT pick a value out of the sidecar: an author who deleted
  // the block is saying this group has no token, and substituting the pulled
  // value back would restore what they removed.
  //
  // A literal token is carried through as authored and refused at export, where
  // every finding in a build lands in one bag.
  const authored = typeof doc?.token === "string" && doc.token !== "" ? doc.token : undefined;
  if (authored !== undefined) return { require_token: doc?.require_token ?? false, token: authored };
  if (doc === undefined) return { require_token: false, token: "" };
  return { require_token: doc.require_token ?? false };
}

export function encodeApiGroup(def: ApiGroupDef): ApiGroupXdo {
  if (!def.name) throw new Error("apiGroup: `name` is required.");
  assertCanonical(`apiGroup "${def.name}"`, def.canonical);
  return {
    name: def.name,
    description: def.description ?? "",
    canonical: def.canonical ?? "",
    swagger: def.swagger ?? false,
    api_group_enabled: def.apiGroupEnabled ?? true,
    docs: def.docs ?? "",
    documentation: encodeApiGroupDocumentation(def.documentation),
    middleware: buildMiddlewareBlock(def.middleware),
    history: encodeContainerHistory("query", def.history),
    tag: encodeTags(def.tags),
    cors: encodeCors(`apiGroup "${def.name}"`, def.cors, def.diagnostics?.allow),
  };
}

export const apiGroupKind: ObjectKind<ApiGroupDef, ApiGroupXdo> = {
  name: "api_group",
  payloadKey: "app",
  encode: encodeApiGroup,
};
registerKind(apiGroupKind);

/**
 * Author an API group (query container).
 *
 * Deliberately the identity, and so NOT kind-branded (see `def-brand.ts`): a
 * browser bundle that imports one query pulls in its group, and a bundler
 * inlines an identity call away — taking this module's encoders with it. A
 * brand would keep them, about 3 kB on the client floor. Handed to another
 * `register*` call, a group is refused at COMPILE time by its type-only
 * `__kind`, and at run time by the keys only a group carries (`cors`,
 * `swagger`) — see `structuralKind` in `workspace/xano.ts`.
 */
export function apiGroup(def: ApiGroupDef): ApiGroupDef {
  return def;
}
