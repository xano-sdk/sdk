/**
 * Instance-capability requirements of a compiled bundle.
 *
 * The Xano editor greys out statements an instance cannot run: the redis family
 * without cache support, `lambda` and direct SQL behind a plan, microservice
 * calls, the zip family on a free instance, Datadog and Webflow behind a support
 * flag. The SDK authors against the whole catalog, so a workspace using
 * `s.redis.ratelimit` type-checks, exports and deploys clean onto an instance
 * that cannot run it — and fails on the first request.
 *
 * This is the static half of closing that: it cannot know what the TARGET
 * supports (nothing in a CLI token exposes the flag set), but it can say
 * exactly what the bundle NEEDS, which is enough to check a plan by hand before
 * a promote lands on an instance that differs from the ephemeral it was built
 * on. That is the case where this bites hardest — the failure is invisible until
 * production.
 *
 * The mapping is the editor's own gating predicate per statement, read once and
 * recorded here by the stored `mvp:*` name. It is deliberately CONSERVATIVE: a
 * statement no gate covers is absent, rather than assigned a plausible
 * capability. A false "you need X" is worse than a missing one — it sends
 * someone to buy a plan they already have, or to rewrite working code.
 *
 * Browser-safe: two plain tables and a walk; its one import is a name table.
 */
import { sdkKindName } from "../util/sdk-kind.js";

/** One instance capability a bundle can depend on. */
export interface Capability {
  /** What to look for on the instance, in the platform's own words. */
  readonly label: string;
  /** What stops working without it. */
  readonly effect: string;
  /**
   * Set when the local Xano Engine (the default `deploy` target) is KNOWN to
   * lack it: what to do instead. Absent means nothing is known either way.
   */
  readonly localEngine?: string;
  /**
   * What the local Xano Engine answers a statement needing it, quoted. Set with
   * {@link localEngine}: a deploy that KNOWS it is landing on the local engine
   * reports the capability as unavailable there, rather than as unchecked.
   */
  readonly localEngineRefusal?: string;
}

/**
 * The capabilities the editor gates on, keyed as this SDK reports them.
 *
 * `paidInstance` is the one that is not a flag: the zip family is gated on the
 * instance NOT being free, so it is stated positively here rather than as a
 * negated flag an author would have to invert while reading.
 */
export const CAPABILITIES = {
  cache: {
    label: "Redis / cache support",
    effect: "every `s.redis.*` statement, including `s.redis.ratelimit`",
  },
  lambda: {
    label: "Lambda (JavaScript/TypeScript) support",
    effect: "`s.lambda`, and the `fl.lambda`-family filters that run through it",
  },
  premiumInstance: {
    label: "a premium instance",
    effect: "`s.await` (awaiting an async function run), an `async-shared` run, and direct SQL",
  },
  asyncDedicated: {
    label: "dedicated async workers",
    effect: "an `async-dedicated` `s.function.run` or `s.ai.agent.run`",
  },
  directQuery: {
    label: "direct-query support",
    effect: "`s.db.direct_query` — raw SQL against this workspace's own tables",
  },
  microservice: {
    label: "microservice support",
    effect: "`s.microservice.request`",
  },
  realtimeV2: {
    label: "realtime (v2) support",
    effect: "`s.realtime.publish`",
  },
  rawFileAccess: {
    label: "raw file access",
    effect: "reading a file resource's bytes, and the CSV/JSONL streaming readers",
  },
  paidInstance: {
    label: "a paid (non-free) instance",
    effect: "the whole `s.zip.*` family",
  },
  fileUpload: {
    label: "file upload",
    effect: "creating and deleting stored file resources",
  },
  images: { label: "image storage", effect: "`s.storage.create_image`" },
  videos: { label: "video storage", effect: "`s.storage.create_video`" },
  audio: { label: "audio storage", effect: "`s.storage.create_audio`" },
  attachment: { label: "attachment storage", effect: "`s.storage.create_attachment`" },
  privateStorage: {
    label: "private file storage",
    effect: "`s.storage.sign_private_url`",
    // Measured: every call answers 403 "Not supported. Please upgrade your Xano
    // instance." on the local engine, 200 with a signed URL on an ephemeral.
    localEngine: "the local Xano Engine refuses it (403 `Not supported`) — exercise it on an ephemeral (`deploy --ephemeral`)",
    localEngineRefusal: '403 "Not supported. Please upgrade your Xano instance."',
  },
  webflow: { label: "the Webflow integration", effect: "`s.webflow.request`" },
  datadog: { label: "the Datadog integration", effect: "every `s.datadog.*` statement" },
} as const satisfies Record<string, Capability>;

/** A key of {@link CAPABILITIES}. */
export type CapabilityId = keyof typeof CAPABILITIES;

/**
 * Stored statement name → the capabilities its instance must have.
 *
 * `mvp:dbo_direct_query` carries two because the editor's predicate is a
 * conjunction: a premium instance AND direct-query support. Everything else is
 * one.
 */
export const STATEMENT_CAPABILITIES: Readonly<Record<string, readonly CapabilityId[]>> = {
  // Redis / cache.
  "mvp:redis_countlist": ["cache"],
  "mvp:redis_decr": ["cache"],
  "mvp:redis_del": ["cache"],
  "mvp:redis_get": ["cache"],
  "mvp:redis_has": ["cache"],
  "mvp:redis_incr": ["cache"],
  "mvp:redis_keys": ["cache"],
  "mvp:redis_poplist": ["cache"],
  "mvp:redis_pushlist": ["cache"],
  "mvp:redis_rangelist": ["cache"],
  "mvp:redis_ratelimit": ["cache"],
  "mvp:redis_remove_list": ["cache"],
  "mvp:redis_set": ["cache"],
  "mvp:redis_shiftlist": ["cache"],
  "mvp:redis_unshiftlist": ["cache"],
  // Compute and data.
  "mvp:lambda": ["lambda"],
  "mvp:async_function_await": ["premiumInstance"],
  "mvp:dbo_direct_query": ["premiumInstance", "directQuery"],
  "mvp:microservice_request": ["microservice"],
  "mvp:realtime_publish": ["realtimeV2"],
  "mvp:realtime_kick": ["realtimeV2"],
  // Files. The zip family is gated on the instance not being FREE; the readers
  // below are gated on raw file access, which is a separate flag.
  "mvp:zip_add_file_resource": ["paidInstance"],
  "mvp:zip_create_file_resource": ["paidInstance"],
  "mvp:zip_delete_file_resource": ["paidInstance"],
  "mvp:zip_extract_file_resource": ["paidInstance"],
  "mvp:zip_view_contents": ["paidInstance"],
  "mvp:create_var_from_file_resource": ["rawFileAccess"],
  "mvp:csv_stream": ["rawFileAccess"],
  "mvp:jsonl_stream": ["rawFileAccess"],
  "mvp:create_file_resource": ["fileUpload"],
  "mvp:delete_file": ["fileUpload"],
  "mvp:create_image": ["images"],
  "mvp:create_video": ["videos"],
  "mvp:create_audio": ["audio"],
  "mvp:create_attachment": ["attachment"],
  "mvp:vault_sign_url": ["privateStorage"],
  // Integrations. The external-cloud storage statements (S3/GCS/Azure) are
  // deliberately absent: the editor gates none of them, and claiming otherwise
  // would send someone checking a plan for something that is always available.
  "mvp:connect_webflow_api_request": ["webflow"],
  "mvp:datadog_log": ["datadog"],
  "mvp:datadog_log_bulk": ["datadog"],
  "mvp:datadog_metric": ["datadog"],
  "mvp:datadog_metric_bulk": ["datadog"],
};

/**
 * The async runs, gated by their `runtime.mode` rather than by name: each is
 * stored as a plain `mvp:function` / `mvp:call_agent` with a top-level
 * `runtime`, and the engine refuses the run ("Not supported. Please upgrade
 * your Xano instance.") when the instance lacks the mode. `async-shared` is
 * refused on the plans the editor's premium check excludes; `async-dedicated`
 * needs the instance's dedicated-worker setting.
 */
const ASYNC_RUN_STATEMENTS: ReadonlySet<string> = new Set(["mvp:function", "mvp:call_agent"]);
export const ASYNC_MODE_CAPABILITIES: Readonly<Record<string, CapabilityId>> = {
  "async-shared": "premiumInstance",
  "async-dedicated": "asyncDedicated",
};

/**
 * What a shared capability covers, per statement — so the line names only what
 * the bundle uses. A premium instance gates `s.await`, an `async-shared` run,
 * and direct SQL, and a bundle with only the SQL was told it needed one for
 * `s.await`. An async run is keyed `<statement>@<mode>`.
 */
const STATEMENT_EFFECTS: Readonly<Record<string, string>> = {
  "mvp:async_function_await": "`s.await` (awaiting an async function run)",
  "mvp:call_agent@async-shared": "an `async-shared` `s.ai.agent.run`",
  "mvp:dbo_direct_query": "direct SQL",
  "mvp:function@async-shared": "an `async-shared` `s.function.run`",
};

/** The effect line for `id`, narrowed to what is present where it is split per statement. */
function effectOf(id: CapabilityId, keys: ReadonlySet<string>): string {
  const parts = [...keys].sort().map((n) => (Object.hasOwn(STATEMENT_EFFECTS, n) ? STATEMENT_EFFECTS[n] : undefined));
  if (id !== "premiumInstance" || parts.length === 0 || !parts.every((p) => p !== undefined)) return CAPABILITIES[id].effect;
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The {@link Capability.localEngine} keys, present only when the capability carries them. */
function localEngineNote(cap: Capability): { localEngine?: string; localEngineRefusal?: string } {
  return {
    ...(cap.localEngine !== undefined ? { localEngine: cap.localEngine } : {}),
    ...(cap.localEngineRefusal !== undefined ? { localEngineRefusal: cap.localEngineRefusal } : {}),
  };
}

/** One capability a bundle needs, with what asked for it. */
export interface CapabilityRequirement {
  readonly id: CapabilityId;
  readonly label: string;
  readonly effect: string;
  /** The stored statement names in this bundle that need it, sorted. */
  readonly statements: readonly string[];
  /** The objects those statements sit in (nearest named ancestor), sorted. */
  readonly objects: readonly string[];
  /** {@link Capability.localEngine}, when the local engine is known to lack it. */
  readonly localEngine?: string;
  /** {@link Capability.localEngineRefusal}, when the local engine is known to lack it. */
  readonly localEngineRefusal?: string;
}

/**
 * Every instance capability a compiled bundle depends on.
 *
 * Walks the bundle for statement names rather than re-encoding the defs, so it
 * sees exactly what will be deployed — including anything a `raw()` escape hatch
 * put there, which a def-level walk would miss.
 */
export function bundleCapabilities(bundle: unknown): CapabilityRequirement[] {
  const statements = new Map<CapabilityId, Set<string>>();
  const objects = new Map<CapabilityId, Set<string>>();
  // What {@link effectOf} narrows by: the statement name, or `<name>@<mode>`.
  const effects = new Map<CapabilityId, Set<string>>();
  const need = (id: CapabilityId, name: string, effect: string, context: string): void => {
    (statements.get(id) ?? statements.set(id, new Set()).get(id)!).add(name);
    (effects.get(id) ?? effects.set(id, new Set()).get(id)!).add(effect);
    if (context !== "") (objects.get(id) ?? objects.set(id, new Set()).get(id)!).add(context);
  };

  // `key` is the property the node was reached through: under `payload`, the
  // section — so an object is named with its kind (`middleware "write_rl"`).
  const walk = (node: unknown, context: string, key?: string, section?: boolean): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, context, key, section);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const name = obj.name;
    // A `name` carrying a `:` is a statement marker; anything else names the
    // enclosing object and becomes the context for what is nested under it.
    // Same discipline as the filter-name walk, so the two report locations the
    // same way.
    // A query carries its verb: `GET listings` and `POST listings` are two objects.
    const own =
      typeof name === "string" && name !== "" && !name.includes(":")
        ? typeof obj.verb === "string" && obj.verb !== "" ? `${obj.verb} ${name}` : name
        : undefined;
    const nextContext =
      own === undefined ? context : section && key !== undefined ? `${sdkKindName(key, obj)} "${own}"` : own;

    if (typeof name === "string") {
      // An own-property lookup: a `name` is any object's name, and one spelled
      // like an `Object.prototype` key (`constructor`, `toString`) would
      // otherwise resolve to that inherited member and crash the walk.
      const ids = Object.hasOwn(STATEMENT_CAPABILITIES, name) ? STATEMENT_CAPABILITIES[name] : undefined;
      for (const id of ids ?? []) need(id, name, name, context);
      const mode = ASYNC_RUN_STATEMENTS.has(name) ? (obj.runtime as { mode?: unknown } | undefined)?.mode : undefined;
      if (typeof mode === "string" && Object.hasOwn(ASYNC_MODE_CAPABILITIES, mode)) {
        need(ASYNC_MODE_CAPABILITIES[mode]!, name, `${name}@${mode}`, context);
      }
    }
    for (const [k, value] of Object.entries(obj)) walk(value, nextContext, k, key === "payload");
  };
  walk(bundle, "");

  return [...statements.entries()]
    .map(([id, names]) => ({
      id,
      label: CAPABILITIES[id].label,
      effect: effectOf(id, effects.get(id) ?? new Set()),
      statements: [...names].sort(),
      objects: [...(objects.get(id) ?? [])].sort(),
      ...localEngineNote(CAPABILITIES[id]),
    }))
    // By LABEL, which is what a reader sees. Sorting by id puts "attachment
    // storage" above "Redis / cache support" for a reason nothing on screen
    // explains.
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** What a deploy prints about the capabilities a bundle needs. */
export interface CapabilityReport {
  /** Informational: the heading, one line per capability, and the closing note. Empty when nothing is needed. */
  readonly info: { readonly heading: string; readonly lines: readonly string[]; readonly footer: string } | undefined;
  /** Warnings: a capability the deploy's target is KNOWN to lack. Never a failure. */
  readonly unavailable: ReadonlyArray<{ readonly id: CapabilityId; readonly message: string }>;
}

/**
 * Render {@link bundleCapabilities}' result for a deploy.
 *
 * Nothing in a CLI token exposes a cloud instance's flag set, so a capability
 * is listed for a human to check. The local Xano Engine is the exception: when
 * it is the target, a capability it is known to lack (one carrying
 * {@link Capability.localEngineRefusal}) is reported as UNAVAILABLE there, with
 * what the engine answers and where to exercise it instead.
 */
export function capabilityReport(
  needs: readonly CapabilityRequirement[],
  opts: { readonly localEngine: boolean },
): CapabilityReport {
  if (needs.length === 0) return { info: undefined, unavailable: [] };
  const unavailable: Array<{ id: CapabilityId; message: string }> = [];
  const lines = needs.map((need) => {
    // Name one object per capability, not all of them: the point is to make the
    // requirement findable, and a workspace with forty redis calls would bury
    // the other lines.
    const where = need.objects.length
      ? ` (e.g. ${need.objects[0]}${need.objects.length > 1 ? ` +${need.objects.length - 1} more` : ""})`
      : "";
    if (opts.localEngine && need.localEngineRefusal !== undefined) {
      unavailable.push({
        id: need.id,
        message:
          `${need.label} is unavailable on the local Xano Engine: ${need.effect} returns ${need.localEngineRefusal} ` +
          `there${where}. Exercise it on an ephemeral (\`deploy --ephemeral\`).`,
      });
      return `${need.label} — ${need.effect}${where}; unavailable on the local Xano Engine`;
    }
    return `${need.label} — ${need.effect}${where}${need.localEngine !== undefined ? `; ⚠ ${need.localEngine}` : ""}`;
  });
  return {
    info: {
      heading: `This bundle needs ${needs.length} instance capabilit${needs.length === 1 ? "y" : "ies"}:`,
      lines,
      footer: "Check these against the plan of anything you promote to; the deploy cannot.",
    },
    unavailable,
  };
}
