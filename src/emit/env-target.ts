/**
 * The meta target type every resolved backend reduces to, and the one lookup
 * that says which ephemeral bare `ephemeral` names.
 *
 * Resolving a backend — any kind, liveness included — is `source-resolve.ts`'s
 * job. What stays here is shared vocabulary beneath it: {@link MetaTarget}, and
 * {@link resolveEphemeralName}, which the resolver and `init --from` both need
 * before they can address anything.
 *
 * ## `base` is appended to, never resolved against
 *
 * A tenant that has no dedicated domain is served under a `/tenant/<name>` path
 * prefix on the instance origin. `new URL("/api:meta/...", base)` would silently
 * drop that prefix and address the PARENT instance instead — the same trap
 * `exportWorkspaceBundle` documents. Callers must build routes as
 * `` `${base}/api:meta/...` ``.
 */
import type { ResolvedAuth } from "../auth/token.js";
import {
  environmentKey,
  getEnvironment,
  readEphemeralState,
  type EnvScope,
  type EphemeralState,
} from "../deploy/ephemeral-state.js";
import { DEFAULT_PROFILE } from "../auth/profile-select.js";
import { loginCommand, profileAddCommand, recordedCredentialPath, recordedProfileStored } from "../auth/store.js";
import { CliError, UsageError, type HelpTarget } from "./errors.js";
import { EXIT_SOURCE_UNRESOLVABLE } from "./source-selector.js";
import { andList } from "../util/and-list.js";
import { readEnvVar } from "../util/env.js";
import { findPointerFile, readPointerFile } from "../auth/profile-pointer.js";
import {
  contextFlags,
  credentialFileFlagFor,
  credentialFileOf,
  ENV_CREDENTIAL_VARS,
  recordedByEnvCredential,
} from "./context-flags.js";

/** The variables an environment credential is made of, in the order a remedy names them. */
const ENV_CREDENTIAL_NAMES = ["XANO_INSTANCE_URL", "XANO_WORKSPACE_ID", "XANO_META_TOKEN", "XANO_REFRESH_TOKEN", "XANO_CLIENT_ID"];

/** The profile this project's xano.profile.json pins, if it pins one (a malformed file pins none here). */
function projectPin(): string | undefined {
  try {
    const file = findPointerFile(process.cwd());
    return file === undefined ? undefined : readPointerFile(file);
  } catch {
    return undefined;
  }
}

/** Every environment reduces to this: where to send meta calls, and as whom. */
export interface MetaTarget {
  /**
   * Origin, possibly carrying a path prefix. APPEND routes to it — see the
   * module header for why `new URL(path, base)` is wrong here.
   */
  base: string;
  workspaceId: number;
  /** How the environment names itself in progress lines and errors. */
  label: string;
  /**
   * The ephemeral's or tenant's name, for the backends that have one. Carried explicitly rather than parsed back out of {@link label}: the
   * label is a human-facing string and a caller reconstructing a machine value
   * from it would break the day the wording changes.
   */
  env?: string;
  /**
   * A tenant's type (`ephemeral`, `sandbox`, `standard`, `run`), when the
   * destination is one and the row reported it.
   *
   * Carried, not acted on. Whether a given type may be read from or written to
   * is a POLICY, and the policies differ per command — `tenant deploy` lands on
   * a standard tenant quite deliberately, while `release create` must refuse to
   * cut from one. Resolving is shared; the policy belongs with the command that
   * holds it.
   */
  tenantType?: string;
  /** An ephemeral's or tenant's display name, when its record carries one. */
  display?: string;
}

/**
 * Which ephemeral `ephemeral` / `ephemeral:<name>` names: the given name, else
 * the one this project last deployed to.
 *
 * One lookup, read by the resolver for every command that takes the grammar: a
 * second copy would be a second place for bare `ephemeral` to come to mean
 * something slightly different.
 */
export async function resolveEphemeralName(
  auth: ResolvedAuth,
  name: string | undefined,
  cwd: string = process.cwd(),
): Promise<string> {
  const state = readEphemeralState(cwd);
  const tracked = getEnvironment(state, auth)?.name;
  const resolved = name ?? tracked;
  if (resolved === undefined || resolved === "") {
    // Tracked, but under another credential: `xanosdk deploy` from here would
    // create a SECOND ephemeral beside it. The remedy is the other credential.
    const other = otherCredentialRefusal(
      state,
      auth,
      `or name one with \`ephemeral:<name>\` (\`xanosdk ephemeral list${contextFlags()}\` shows them)`,
    );
    if (other !== undefined) throw await reachableFirst(other, auth);
    // A named thing that is not there: `SDK_ERROR`, exit 8 — what `generate
    // local-engine` and `tables` exit with when nothing is tracked either.
    throw new CliError(
      "SDK_ERROR",
      `No ephemeral environment to target. Name one with \`ephemeral:<name>\` ` +
        `(\`xanosdk ephemeral list${contextFlags()}\` shows the ones that exist), or run \`xanosdk deploy${contextFlags()}\` first — ` +
        `this project then remembers the env it deployed to, which is what bare ` +
        `\`ephemeral\` reads.`,
      { exitCode: EXIT_SOURCE_UNRESOLVABLE },
    );
  }
  return resolved;
}

/**
 * The refusal for a project whose ephemeral is tracked under ANOTHER
 * credential than `scope` — or `undefined` when nothing else is tracked.
 *
 * The ways to miss have different remedies, so each is named: another PROFILE
 * is reached with `--profile <that profile>` (named, when the record says
 * which), an environment credential has to be left out first (it outranks every
 * stored profile and refuses `--profile`), and only a record under THIS profile
 * for another workspace needs a different sign-in. `tail` is the caller's
 * "or name one …" alternative. Shared by the tracked default and an explicit
 * bare `ephemeral`, so the two cannot name different fixes.
 */
export function otherCredentialRefusal(
  state: EphemeralState,
  scope: EnvScope,
  tail: string,
  opts: { hintFor?: HelpTarget } = {},
): UsageError | undefined {
  const mine = environmentKey(scope);
  // The legacy bare-numeric key is this scope's own when present — getEnvironment
  // already adopted it — so it is never "another" record.
  const others = Object.keys(state.environments).filter((k) => k !== mine && k !== String(scope.workspaceId));
  if (others.length === 0) return undefined;
  // Keys are `"<profile>/<instance host>/<workspaceId>"`: the profile is the
  // first segment and the workspace the last. A legacy bare-numeric key names
  // no profile.
  const workspaceOf = (key: string): string => key.slice(key.lastIndexOf("/") + 1);
  const profileOf = (key: string): string | undefined => (key.includes("/") ? key.slice(0, key.indexOf("/")) : undefined);
  const quoted = (names: readonly string[]): string => names.map((n) => `"${n}"`).join(", ");
  const fromEnv = scope.profile === undefined;
  // An environment credential keys as `default` (see `EnvScope.profile`), so a
  // `default` record is its own namespace, not another profile's.
  const current = scope.profile?.name ?? DEFAULT_PROFILE;
  // A record under ANOTHER profile is reached with `--profile <it>`, whichever
  // workspace it is on. Only this credential's own record for another
  // workspace needs a different sign-in.
  // A record the environment credential made (it keys as `default`) is not
  // another PROFILE: `--profile default` names one that may not exist. Only a
  // profile run can miss it this way — an environment run's own key is it.
  const envMade = fromEnv ? [] : others.filter((k) => recordedByEnvCredential(state.environments[k]));
  const underOther = others.filter((k) => {
    const p = profileOf(k);
    return p !== undefined && p !== current && !envMade.includes(k);
  });
  const sameWorkspace = underOther.filter((k) => workspaceOf(k) === String(scope.workspaceId));
  const reachable = sameWorkspace.length > 0 ? sameWorkspace : underOther;
  const profiles = [...new Set(reachable.map((k) => profileOf(k)!))];
  // The profile lives in a credential FILE, and a remedy that names the
  // profile alone fails again when that is not the file this run read
  // (`status --config s.json` told to re-run with `--profile live`, which
  // lives in live.json). The record says which file deployed it; an older
  // record does not, and then the possibility is said instead.
  const files = [...new Set(reachable.map((k) => state.environments[k]?.credential_file))];
  const runFile = credentialFileOf();
  const known = files.length === 1 ? files[0] : undefined;
  const fileFlag = known !== undefined && known !== runFile ? credentialFileFlagFor(known) : "";
  const fileNote =
    known === undefined && runFile !== undefined && runFile !== "shared"
      ? ` (${profiles.length === 1 ? "it" : "they"} may live in another credential file than this run read — add that file's \`--config <path>\` if so)`
      : known === "shared" && runFile !== undefined && runFile !== "shared"
        ? ` (without \`--config\`/\`--local\`: ${profiles.length === 1 ? "it lives" : "they live"} in this machine's shared credential file)`
        : "";
  const profileFlag = `${profiles.length === 1 ? `--profile ${profiles[0]}` : "--profile <name>"}${fileFlag}`;
  // A profile deleted since the deploy recorded it: `--profile <it>` exits 8
  // naming a profile that does not exist, so the fix is the sign-in that
  // creates it where the record says — the command status's Environment row
  // prints for the same record.
  // Only for a record that names its file: an older one's profile may live in
  // a file this run cannot see, which `fileNote` already says.
  // A deleted TOKEN profile is not signed in again with OAuth, and the record
  // cannot say which kind it was — so both, filled from the one record.
  const goneKey = reachable.length === 1 ? reachable[0]! : undefined;
  const goneTarget = {
    path: known !== undefined ? (recordedCredentialPath(known) ?? undefined) : undefined,
    instance:
      goneKey === undefined
        ? undefined
        : (state.environments[goneKey]?.instance ?? `https://${goneKey.split("/").slice(1, -1).join("/")}`),
    workspaceId: goneKey === undefined ? undefined : workspaceOf(goneKey),
  };
  const gone =
    profiles.length === 1 && known !== undefined && !recordedProfileStored(profiles[0]!, known)
      ? `\`${loginCommand(profiles[0]!, goneTarget)}\` (OAuth), or \`${profileAddCommand(profiles[0]!, goneTarget)}\` (meta API token)`
      : undefined;
  // The variables actually set, not every one that could be: a remedy to unset
  // XANO_REFRESH_TOKEN in a shell that never set it is noise to act on.
  const setVars = ENV_CREDENTIAL_NAMES.filter((v) => readEnvVar(v) !== undefined);
  // A profile the project's xano.profile.json already pins is what a run
  // without the environment credential acts as — `--profile` would re-say it.
  const pinned = profiles.length === 1 && fileFlag === "" && projectPin() === profiles[0];
  const remedy = fromEnv
    ? `This run acts as the credential in the environment, which outranks every stored profile — ` +
      `run without it (unset ${andList(setVars.length > 0 ? setVars : ENV_CREDENTIAL_NAMES.slice(0, 3))}) ` +
      (gone !== undefined
        ? `and add that profile again with ${gone} — it is no longer stored`
        : pinned
          ? `to act as that profile, which this project's xano.profile.json already pins`
          : `and with \`${profileFlag}\` to act as ${profiles.length === 1 ? "that profile" : "one of them"}${fileNote}`)
    : gone !== undefined
      ? `That profile is no longer stored — add it again with ${gone}`
      : `Re-run with \`${profileFlag}\` for that profile${fileNote}`;

  if (sameWorkspace.length > 0) {
    return new UsageError(
      `This project tracks its ephemeral under a different credential profile (${quoted(profiles)}), not the one ` +
        `this command is acting as. ${remedy}, ${tail}.`,
      opts,
    );
  }
  if (underOther.length > 0) {
    const workspaces = [...new Set(underOther.map(workspaceOf))].join(", ");
    return sendsElsewhere(new UsageError(
      `This project tracks its ephemeral under a different credential profile (${quoted(profiles)}) and workspace ` +
        `(${workspaces}) than the ones this command is acting as (workspace ${scope.workspaceId}). ${remedy}, ${tail}.`,
      opts,
    ));
  }
  if (envMade.length > 0) {
    const workspaces = [...new Set(envMade.map(workspaceOf))].join(", ");
    return sendsElsewhere(new UsageError(
      `This project tracks its ephemeral under the environment credential (workspace ${workspaces}), not the ` +
        `profile this command is acting as. Set ${ENV_CREDENTIAL_VARS} for that workspace to act as it, ${tail}.`,
      opts,
    ));
  }
  // This credential's own profile, so the record differs in instance or
  // workspace. Workspace ids are per instance — workspace 1 on another host is
  // another workspace entirely — so the instance is compared first, and a
  // record for another host is not "another workspace to sign in to": nothing
  // is tracked on this one, and deploying here makes one. A legacy
  // bare-numeric key names no host, so it reads as this one.
  const here = hostOf(scope.instance);
  const hostOfKey = (key: string): string | undefined => {
    const parts = key.split("/");
    return parts.length >= 3 ? parts.slice(1, -1).join("/") : undefined;
  };
  const sameHost = others.filter((k) => (hostOfKey(k) ?? here) === here);
  if (sameHost.length === 0) {
    const hosts = [...new Set(others.map((k) => hostOfKey(k)!))].join(", ");
    return new UsageError(
      `No ephemeral is tracked on ${here} — run \`xanosdk deploy${contextFlags()}\` to create one there, ${tail}. ` +
        `(This project's record is for ${hosts}.)`,
      opts,
    );
  }
  const workspaces = [...new Set(sameHost.map(workspaceOf))].join(", ");
  const login = `${current !== DEFAULT_PROFILE ? `xanosdk login -p ${current}` : "xanosdk login"}${credentialFileFlagFor(credentialFileOf() ?? "shared")}`;
  const signIn = fromEnv
    ? `Point the environment credential at the workspace it belongs to, or run without it and sign in to that workspace`
    : `Sign in to the workspace it belongs to (\`${login}\`)`;
  return sendsElsewhere(new UsageError(
    `This project tracks its ephemeral under a different workspace than the one you are signed in to on ${here} ` +
      `(workspace ${scope.workspaceId}) — its record is for workspace ${workspaces}. ${signIn}, ${tail}.`,
    opts,
  ));
}

/** The refusals that send the reader to another workspace — see {@link reachableFirst}. */
const SENDS_ELSEWHERE = new WeakSet<Error>();

/**
 * `refusal`, unless the workspace this credential is pinned to is one it
 * cannot reach — then that refusal instead, naming the setting to fix and the
 * ids that work. A refusal sending the reader to another workspace, or to
 * `--to` a backend here, is only followable from a workspace that exists
 * (E2E pass 46: `XANO_WORKSPACE_ID=99999 xanosdk env set` was told to name a
 * backend with `--to`, which then failed "Workspace 99999 does not exist").
 * Any other error passes through.
 */
export async function reachableFirst(refusal: unknown, auth: ResolvedAuth | EnvScope | undefined): Promise<unknown> {
  if (!(refusal instanceof Error) || !SENDS_ELSEWHERE.has(refusal)) return refusal;
  if (auth === undefined || !("access_token" in auth)) return refusal;
  const { refuseUnreachableWorkspace } = await import("./workspace-binding.js");
  try {
    await refuseUnreachableWorkspace(auth);
  } catch (unreachable) {
    return unreachable;
  }
  return refusal;
}

function sendsElsewhere(refusal: UsageError): UsageError {
  SENDS_ELSEWHERE.add(refusal);
  return refusal;
}

/** An instance's host, as the state keys carry it. */
function hostOf(instance: string): string {
  try {
    return new URL(instance).host;
  } catch {
    return instance.replace(/\//g, "_");
  }
}
