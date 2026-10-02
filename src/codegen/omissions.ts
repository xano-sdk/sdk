import { DEFAULT_DOCUMENTATION, LEGACY_REALTIME } from "../kinds/workspace-config.js";

/**
 * What codegen deliberately does **not** carry into the generated tree — and why.
 *
 * Decode has two very different reasons for an object not appearing in the
 * output, and collapsing them is what made a real-workspace pull unreadable:
 *
 * - **Loss.** A statement, field, or def key that *should* round-trip and does
 *   not. This is a hard failure and always has been.
 * - **Policy.** A section or key this SDK has decided not to represent, because
 *   it is an instance's private key material or server-assigned identity. A
 *   generated TypeScript tree is source you commit and redeploy — putting an
 *   instance's crypto secret or its DNS prefix in it is a bug, not fidelity.
 *
 * Verification used to report both as "does not match the source bundle", which
 * is neither actionable nor honest: it told a user their workspace failed to
 * round-trip when in fact the SDK had chosen, correctly, to leave four keys
 * behind. This module is the written-down policy the plan asked for, and it is
 * the **single** source both `decodeBundle` and `verifyBundles` read, so the
 * list that suppresses a mismatch is the same list that reports the omission.
 *
 * Codegen is not a backup tool. Anything listed here is recoverable only from
 * the live workspace.
 */

/** Why a section or key is left out of the generated tree. */
export type OmissionReason =
  /** Private key material or an integration credential. Must never be emitted. */
  | "secret"
  /** Assigned and owned by the instance; carrying it to another tenant is wrong. */
  | "server-managed"
  /** Carried elsewhere in the bundle, where the import actually reads it. */
  | "relocated"
  /**
   * Instance history or provenance rather than workspace source — an install
   * run, a marketplace record. There is nothing to model: it describes what was
   * done TO the workspace, not what the workspace IS.
   *
   * Split out of `unmodeled` because the two answer different questions. This
   * one says "correctly absent"; `unmodeled` says "a real object type is missing
   * from your tree". Only the second is worth a warning.
   */
  | "instance-owned"
  /**
   * A file in the workspace's file library. Its bytes are content, not source:
   * a project ships a file it means to keep through `hostedFile()`.
   */
  | "stored-file"
  /** A first-class Xano object type this SDK models no kind for. */
  | "unmodeled";

/**
 * How loudly a section's omission should be reported.
 *
 * Derived from the reason rather than listed a second time, so a policy and its
 * severity cannot drift apart. Only `unmodeled` warns: a Xano object type this
 * SDK has no kind for really is missing from the generated tree, and a reader
 * should know their pull is incomplete. Everything else is a deliberate,
 * correct absence — a secret that must never be committed, an instance-assigned
 * identity, history that is not source — where there is nothing to decide.
 */
export function omissionSeverity(reason: OmissionReason): "warning" | "notice" {
  return reason === "unmodeled" ? "warning" : "notice";
}

/** A deliberately-omitted payload section or workspace key. */
export interface OmissionPolicy {
  readonly reason: OmissionReason;
  /**
   * What the omitted thing is called in the report, in words a reader of the
   * SDK recognises. The stored key is an engine field name and is never shown.
   */
  readonly label: string;
  /** One line, written for a user reading the report. */
  readonly detail: string;
  /**
   * True when the generated tree writes the key **empty** rather than dropping
   * it. Only `env` does this today: the import reads workspace env vars from
   * top-level `payload.env`, so the encoder hoists them there and leaves
   * `workspace.env` empty rather than duplicating secrets inside the bundle.
   *
   * Without this, that deliberate emptying reads as a round-trip failure on
   * every real workspace that has env vars. The values are still verified — as
   * the top-level `payload.env` section, where they actually live.
   */
  readonly emptied?: true;
  /**
   * True when the generated tree writes the key with a value it **derives** rather
   * than carries. Only `guid` does this today: the workspace config declares no
   * guid field, so the export path mints one from the workspace name, and that
   * will never equal the instance-assigned guid it replaced.
   *
   * Without this, the deliberate re-derivation reads as a round-trip failure on
   * every real workspace — 158 of 158 in the sweep that surfaced it — which is
   * enough noise to bury every genuine per-object mismatch underneath it. The
   * value is *meant* to differ, so any value is accepted here; what matters is
   * that the key is never carried across tenants.
   */
  readonly derived?: true;
}

/**
 * Payload sections this SDK models no kind for.
 *
 * A non-empty one cannot be represented in the generated tree, so it is reported
 * rather than dropped silently — but it is reported as a *known* gap, not
 * as a round-trip failure, because no amount of re-running codegen will fix it.
 */
export const UNSUPPORTED_SECTIONS: Readonly<Record<string, OmissionPolicy>> = {
  vault: {
    label: "stored files",
    reason: "stored-file",
    detail:
      "a file's bytes are not carried into the generated tree; to ship one from the project, put it in the repo and " +
      "point the field at `hostedFile(\"./<file>\", import.meta.url)`",
  },
  // These three were tagged `unmodeled`, which their own detail lines contradict:
  // none of them is an object type the SDK failed to model. They are records of
  // what was done to the workspace, owned by the instance that did it.
  market_item: { label: "marketplace records", reason: "instance-owned", detail: "marketplace provenance is owned by the instance" },
  run_install: { label: "install runs", reason: "instance-owned", detail: "install runs are instance history, not workspace source" },
  action_package_install: {
    label: "action-package installs",
    reason: "instance-owned",
    detail: "action-package installs are owned by the instance",
  },
  service: { label: "services", reason: "unmodeled", detail: "services are not modeled by this SDK" },
  branch: { label: "branches", reason: "server-managed", detail: "branches are instance state, not workspace source" },
};

/**
 * Keys of the singleton `payload.workspace` object that are deliberately dropped.
 *
 * Classified against the engine's own persisted workspace schema rather than
 * guessed. The two categories matter for different reasons:
 *
 * - `secret` — emitting these into a committed source tree leaks an instance's
 *   private key material or a third-party integration credential.
 * - `server-managed` — the instance assigns these and derives behavior from
 *   them. `domain_prefix`, for example, is auto-generated from random bytes when
 *   empty and is used to build the workspace's hostnames; carrying it into a
 *   tree that is redeployed to a *different* tenant would have that tenant claim
 *   another workspace's routing prefix.
 *
 * A workspace key that is neither modeled nor listed here is a genuine gap, and
 * verification reports it by name so it can be triaged rather than absorbed.
 */
export const WORKSPACE_OMITTED_KEYS: Readonly<Record<string, OmissionPolicy>> = {
  // --- private key material ---
  iv: { label: "encryption material", reason: "secret", detail: "instance crypto material" },
  salt: { label: "encryption salt", reason: "secret", detail: "instance crypto material" },
  secret: { label: "encryption secret", reason: "secret", detail: "instance crypto material" },
  crypto: { label: "encryption keys", reason: "secret", detail: "instance crypto material" },
  mesh0: { label: "integration API keys", reason: "secret", detail: "integration API keys" },
  git: { label: "git integration keys", reason: "secret", detail: "integration deploy keys" },

  // --- assigned and owned by the instance ---
  id: { label: "workspace id", reason: "server-managed", detail: "instance-assigned workspace id" },
  guid: {
    label: "workspace guid",
    reason: "server-managed",
    derived: true,
    detail:
      "instance-assigned workspace guid; the generated tree re-derives its own from the workspace name rather than carrying it",
  },
  checksum: { label: "checksum", reason: "server-managed", detail: "derived by the engine on save" },
  created_at: { label: "created time", reason: "server-managed", detail: "engine timestamp" },
  updated_at: { label: "updated time", reason: "server-managed", detail: "engine timestamp" },
  deleted_at: { label: "deleted time", reason: "server-managed", detail: "engine timestamp" },
  domain_prefix: {
    label: "routing prefix",
    reason: "server-managed",
    detail: "instance-assigned routing prefix; redeploying it to another tenant would claim its hostnames",
  },
  branch: { label: "current branch", reason: "server-managed", detail: "current-branch pointer, instance state" },
  release: { label: "current release", reason: "server-managed", detail: "release pointer, instance state" },
  user: { label: "owning user", reason: "server-managed", detail: "owning-user record" },
  usage: { label: "usage counters", reason: "server-managed", detail: "usage counters, instance state" },
  features: { label: "feature flags", reason: "server-managed", detail: "instance feature flags" },
  installed_services: { label: "installed services", reason: "server-managed", detail: "per-branch installed service ids" },
  provision: { label: "provisioning state", reason: "server-managed", detail: "provisioning progress, instance state" },
  well_known: { label: "well-known records", reason: "server-managed", detail: "well-known hosting records, instance state" },
  tailor_experience: { label: "onboarding answers", reason: "server-managed", detail: "onboarding survey answers" },
  require_setup: { label: "setup state", reason: "server-managed", detail: "onboarding state" },
  disabled: { label: "disable flag", reason: "server-managed", detail: "instance-level workspace disable flag" },
  jumpstart: { label: "starter state", reason: "server-managed", detail: "onboarding state" },
  sql_schema_name: { label: "database schema name", reason: "server-managed", detail: "physical schema name, instance-assigned" },
  connect: { label: "connection state", reason: "server-managed", detail: "third-party connection state" },

  // --- carried elsewhere in the bundle ---
  env: {
    label: "env vars",
    reason: "relocated",
    emptied: true,
    detail:
      "workspace env vars are carried in the bundle's own env set, where the import reads them; they are verified there",
  },
};

/**
 * Workspace keys the engine writes at a fixed default, and how to recognise that
 * default.
 *
 * These are the `?=`-optional blocks {@link WorkspaceConfigXdo} emits BY PRESENCE
 * — the encoder writes them only when the author asks for them, so that omitting
 * `datasources` leaves a tenant's datasources alone rather than clearing them.
 * The engine, meanwhile, materializes all of them on save: every one of the 177
 * workspaces in the sweep stores `defaults: {db_primary_key: "int"}` and
 * `datasource_live: {color: "#008000", show_banner: false}`, and 176 store
 * `use_custom_names: false`.
 *
 * Carried into a generated tree verbatim, that is ten lines of workspace.ts per
 * pull that say nothing and that an author would never write. Recognising the
 * default lets codegen leave the key out — and this table is what tells
 * verification that the absence is not a round-trip failure, so the drop is
 * silent rather than ten notices deep.
 *
 * A PREDICATE rather than a value, because "the default" is not always one
 * spelling: an empty list is `[]`, and the history block is a dozen keys of which
 * only the departures matter.
 */
export const WORKSPACE_DEFAULTED_KEYS: Readonly<Record<string, (value: unknown) => boolean>> = {
  use_custom_names: (v) => v === false,
  // The two blocks the wipe was expressible through. Omitting either emits
  // no key, so both need recognising here for the same reason the four below do:
  // the engine materializes them on save, so a stored default is ten lines
  // nobody wrote — and verification reads this table, so a tree that leaves the
  // default behind compares equal rather than reporting a loss.
  documentation: isDefaultDocumentation,
  realtime: isDefaultLegacyRealtime,
  defaults: (v) => isRecord(v) && Object.keys(v).length === 1 && v.db_primary_key === "int",
  datasources: (v) => Array.isArray(v) && v.length === 0,
  datasource_live: (v) =>
    isRecord(v) && Object.keys(v).length === 2 && v.color === "#008000" && v.show_banner === false,
  middleware: (v) => isRecord(v) && Object.values(v).every((list) => Array.isArray(list) && list.length === 0),
  history: isDefaultWorkspaceHistory,
};

/**
 * The documentation block at the engine's default — docs open, no token, no
 * whitelist.
 *
 * `whitelist` is accepted as an empty MAP or an empty LIST: the engine stores it
 * as a map and returns the empty form as a list, so a real export carries either
 * spelling and only one of them is `{}`. Anything else — a token, a
 * `require_token`, a populated whitelist, or a member this SDK has not seen — is
 * a departure and is carried.
 */
function isDefaultDocumentation(value: unknown): boolean {
  return matchesDefault(value, DEFAULT_DOCUMENTATION, { whitelist: isEmptyWhitelist });
}

function isEmptyWhitelist(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

/**
 * The legacy workspace-level realtime block at the engine's default.
 *
 * A non-empty `hash` counts as a departure even though the engine ASSIGNS it on
 * import rather than reading the archive's: it is the marker of a workspace that
 * has used the block, and dropping it would make a used block and an unused one
 * decode identically.
 */
function isDefaultLegacyRealtime(value: unknown): boolean {
  return matchesDefault(value, LEGACY_REALTIME, {
    channels: (v) => Array.isArray(v) && v.length === 0,
  });
}

/**
 * Is every member of `value` the one the engine defaults it to?
 *
 * Read off the SAME constants the encoder recognises rather than re-spelled
 * here, so a change to either default propagates to the codegen side instead of
 * silently leaving this predicate matching a shape nothing writes any more.
 *
 * Missing keys are allowed: an older save omits members the engine has since
 * added, and a block is still "at the default" when it simply does not mention
 * one. An EXTRA key is a departure — a member this SDK has not seen is exactly
 * the thing a generated tree must carry rather than drop.
 *
 * `loose` names the members whose default has more than one spelling. The
 * documentation `whitelist` is the case: the engine stores a map and returns the
 * empty form as a list, so a real export carries either and only one is `{}`.
 */
function matchesDefault(
  value: unknown,
  defaults: Readonly<Record<string, unknown>>,
  loose: Readonly<Record<string, (member: unknown) => boolean>> = {},
): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, member]) => {
    if (!Object.hasOwn(defaults, key)) return false;
    const predicate = Object.hasOwn(loose, key) ? loose[key] : undefined;
    return predicate ? predicate(member) : deepEqualDefault(member, defaults[key]);
  });
}

/** Structural equality, enough for the scalar and empty-list defaults here. */
function deepEqualDefault(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqualDefault(item, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => deepEqualDefault(a[k], b[k]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * `value` with every member equal to its counterpart in `fallback` removed, or
 * `undefined` when nothing is left. Plain objects recurse; anything else is kept
 * whole or dropped whole, mirroring the merge's replace-don't-blend rule.
 *
 * The one reading of "the project did not author this": codegen uses it to leave
 * defaults out of generated source, and the live comparison to leave them out
 * of what a workspace must match.
 */
export function subtractDefaults(value: unknown, fallback: unknown): unknown {
  if (deepEqualDefault(value, fallback)) return undefined;
  if (!isRecord(value) || !isRecord(fallback)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    const kept = Object.hasOwn(fallback, key) ? subtractDefaults(member, fallback[key]) : member;
    if (kept !== undefined) out[key] = kept;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Object types whose workspace-tier request history defaults to OFF. The rest
 * (query, task, tool) default to ON, and every limit defaults to 100.
 */
const HISTORY_DEFAULT_OFF = new Set(["function", "middleware", "trigger", "message"]);

/**
 * The stored workspace history map at its per-type defaults.
 *
 * Compared key by key rather than against one literal map, because the stored
 * map's SHAPE drifts — an older save omits a type's `limit`, and Xano has added
 * types over time. What matters is that no type departs from its default.
 */
function isDefaultWorkspaceHistory(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, member]) => {
    const enabled = key.endsWith("_enabled");
    if (!enabled && !key.endsWith("_limit")) return false;
    const type = key.slice(0, key.lastIndexOf("_"));
    return enabled ? member === !HISTORY_DEFAULT_OFF.has(type) : member === 100;
  });
}

/** Whether a `payload.workspace` key holds exactly the value the engine defaults it to. */
export function isWorkspaceKeyAtDefault(key: string, value: unknown): boolean {
  const predicate = Object.hasOwn(WORKSPACE_DEFAULTED_KEYS, key)
    ? WORKSPACE_DEFAULTED_KEYS[key]
    : undefined;
  return predicate !== undefined && predicate(value);
}

/** The policy for a payload section, or `undefined` if it is not deliberately omitted. */
export function sectionOmission(key: string): OmissionPolicy | undefined {
  return Object.hasOwn(UNSUPPORTED_SECTIONS, key) ? UNSUPPORTED_SECTIONS[key] : undefined;
}

/** The policy for a `payload.workspace` key, or `undefined` if it is not deliberately omitted. */
export function workspaceKeyOmission(key: string): OmissionPolicy | undefined {
  return Object.hasOwn(WORKSPACE_OMITTED_KEYS, key) ? WORKSPACE_OMITTED_KEYS[key] : undefined;
}
