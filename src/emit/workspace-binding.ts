/**
 * A credential pinned to a workspace it cannot see — a well-formed but wrong
 * `XANO_WORKSPACE_ID` or `workspace_id` — said one way wherever it is found:
 * what to fix, by the credential's own kind, and the ids that would work.
 */
import { readEnvVar } from "../util/env.js";
import { ENV_WORKSPACE, type ResolvedAuth } from "../auth/token.js";
import { CliError, UsageError } from "./errors.js";
import { credentialFileOf } from "./context-flags.js";
import {
  credentialFileFlag,
  globalAuthFilePath,
  loginCommand,
  readCredentialFile,
  readProfile,
  recordedCredentialPath,
  sameOriginAs,
  type CredentialFile,
  type CredentialRecord,
} from "../auth/store.js";
import { shellQuote } from "../util/shell-quote.js";

/** One workspace the credential can see. */
export interface ReachableWorkspace {
  readonly id: number;
  readonly name: string | undefined;
}

/** The workspace list as the meta API answers it, narrowed to rows with a numeric id. */
export function reachableWorkspaces(list: unknown): ReachableWorkspace[] {
  return (Array.isArray(list) ? (list as Array<Record<string, unknown>>) : []).flatMap((w) =>
    typeof w.id === "number" ? [{ id: w.id, name: typeof w.name === "string" && w.name !== "" ? w.name : undefined }] : [],
  );
}

/**
 * Where to fix the pinned id. Three arms, three remedies: a `"token"`
 * credential reaches here from a file OR the environment, and telling a CI
 * user to edit a credential file they never wrote sends them looking for
 * something that does not exist; `"oauth-refresh"` has no file and no session.
 */
export function workspaceIdFix(auth: Pick<ResolvedAuth, "credentialType">): string {
  return auth.credentialType === "oauth"
    ? "Run `xanosdk login` again to re-pin it"
    : auth.credentialType === "oauth-refresh"
      ? "Mint `XANO_REFRESH_TOKEN` for the workspace you mean"
      : readEnvVar(ENV_WORKSPACE) !== undefined
        ? `Fix \`${ENV_WORKSPACE}\` in the environment`
        : "Fix `workspace_id` in your credential file";
}

/** The ids that would work, one per line, or "" when the credential sees none. */
export function reachableLines(all: readonly ReachableWorkspace[]): string {
  return all.map((w) => `  ${String(w.id).padStart(3)}  ${w.name ?? "(unnamed)"}`).join("\n");
}

/** The same ids on one line, for a note: `3 ("Main"), 7`. */
export function reachableInline(all: readonly ReachableWorkspace[]): string {
  return all.map((w) => (w.name === undefined ? String(w.id) : `${w.id} (${JSON.stringify(w.name)})`)).join(", ");
}

/** The whole answer: the id is not one this credential sees, the fix, and the ids that are. */
export function unreachableWorkspaceMessage(auth: Pick<ResolvedAuth, "credentialType" | "instance" | "workspaceId">, all: readonly ReachableWorkspace[]): string {
  const known = reachableLines(all);
  return (
    `Workspace ${auth.workspaceId} does not exist on ${new URL(auth.instance).host} ` +
    `(or your credential cannot see it).\n${workspaceIdFix(auth)}.` +
    (known === "" ? "" : `\n\nWorkspaces you can reach:\n${known}`)
  );
}

/**
 * Refuse, as a usage error, a credential pinned to a workspace its own list
 * does not hold — for a write the platform answered "not found" for, where
 * the bare answer names neither the setting to fix nor the ids that work.
 * Returns when the list holds the id, holds nothing, or cannot be read: the
 * write's own failure is then the answer.
 */
export async function refuseUnreachableWorkspace(auth: ResolvedAuth): Promise<void> {
  const all = await readReachableWorkspaces(auth);
  if (all === undefined || all.length === 0 || all.some((w) => w.id === auth.workspaceId)) return;
  throw new UsageError(unreachableWorkspaceMessage(auth, all));
}

/** The workspaces this credential sees, or undefined when the list cannot be read. Best-effort, never throws. */
export async function readReachableWorkspaces(auth: ResolvedAuth, timeoutMs = 30_000): Promise<ReachableWorkspace[] | undefined> {
  try {
    const res = await fetch(new URL("/api:meta/workspace", auth.instance).href, {
      headers: { accept: "application/json", Authorization: `Bearer ${auth.access_token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    return reachableWorkspaces(JSON.parse(await res.text()) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * Where a backend the pinned workspace does not hold is, among the others
 * this credential reaches. `nowhere` only when every list that could hold it
 * was read; any read that failed makes it `unknown` — never confirmed gone.
 */
export type Whereabouts =
  | { readonly at: "nowhere" }
  | { readonly at: "unknown"; readonly detail: string }
  | { readonly at: "elsewhere"; readonly workspace: ReachableWorkspace; readonly kind: "tenant" | "ephemeral" };

/**
 * {@link Whereabouts} of `name` after the pinned workspace missed it. The
 * every-workspace ephemeral list says whether an ephemeral by that name exists
 * at all, but its rows carry no workspace — so where one is listed, or the list
 * cannot be read, the name is read under each other reachable workspace.
 * `"either"` always reads them, and a tenant of any kind answers; `"ephemeral"`
 * counts only an ephemeral.
 */
export async function whereaboutsOf(auth: ResolvedAuth, name: string, kinds: "ephemeral" | "either"): Promise<Whereabouts> {
  const { listAllEphemeral } = await import("../deploy/ephemeral.js");
  const failures: string[] = [];
  const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.replace(/[.:]$/, "");
  const [all, ephemerals] = await Promise.all([
    readReachableWorkspaces(auth),
    listAllEphemeral(auth).catch((err: unknown) => {
      failures.push(reason(err));
      return undefined;
    }),
  ]);
  const listed = ephemerals?.some((r) => r.name === name) === true;
  if (kinds === "ephemeral" && ephemerals !== undefined && !listed) return { at: "nowhere" };
  if (all === undefined) failures.push("the workspace list could not be read");
  const { getTenant } = await import("../deploy/tenant.js");
  const others = (all ?? []).filter((w) => w.id !== auth.workspaceId);
  const found = await Promise.all(
    others.map((w) =>
      getTenant(auth, { workspaceId: w.id, name }).then(
        (record) => {
          if (record === null) return undefined;
          const kind = record.type === "ephemeral" ? ("ephemeral" as const) : ("tenant" as const);
          return kinds === "ephemeral" && kind !== "ephemeral" ? undefined : { workspace: w, kind };
        },
        (err: unknown) => {
          failures.push(`workspace ${w.id}: ${reason(err)}`);
          return undefined;
        },
      ),
    ),
  );
  const hit = found.find((f) => f !== undefined);
  if (hit !== undefined) return { at: "elsewhere", ...hit };
  // Listed, yet no workspace this credential reaches answers for it: not confirmed gone.
  if (listed) failures.push("the ephemeral list names it, but no workspace this credential reaches holds it");
  return failures.length === 0 ? { at: "nowhere" } : { at: "unknown", detail: failures.join("; ") };
}

/**
 * How to rerun `command` against workspace `id`, by the credential's own kind:
 * an environment credential takes `XANO_WORKSPACE_ID` on the command line
 * itself. A stored profile is never re-pinned — every later command reads it —
 * so the rerun names another stored profile that reaches that workspace on the
 * same instance, or first stores one: `profile add` for a meta API token, a
 * sign-in as a new profile for OAuth.
 */
export function rerunInWorkspace(
  auth: Pick<ResolvedAuth, "credentialType"> & Partial<Pick<ResolvedAuth, "instance" | "profile">>,
  id: number,
  command: string,
): string {
  if (auth.credentialType === "token" && readEnvVar(ENV_WORKSPACE) !== undefined) return `Run \`${ENV_WORKSPACE}=${id} ${command}\`.`;
  if (auth.credentialType === "oauth-refresh") return `Mint \`XANO_REFRESH_TOKEN\` for workspace ${id}, then run \`${command}\`.`;
  const recorded = credentialFileOf();
  const path = recordedCredentialPath(recorded) ?? globalAuthFilePath();
  let file: CredentialFile | null = null;
  try {
    file = readCredentialFile(path);
  } catch {
    // Unreadable: no other profile can be offered, and a new one is still advice that runs.
  }
  const current = auth.profile?.name;
  const as = (profile: string): string => {
    const without = current === undefined ? command : command.split(` --profile ${shellQuote(current)}`).join("");
    return `${without} --profile ${shellQuote(profile)}`;
  };
  const stored = (name: string): CredentialRecord | undefined => {
    try {
      return (file !== null && readProfile(file, name, path)) || undefined;
    } catch {
      return undefined;
    }
  };
  const reaches =
    file === null || auth.instance === undefined
      ? undefined
      : Object.keys(file.profiles).find((name) => {
          const record = name === current ? undefined : stored(name);
          return (
            record !== undefined &&
            record.workspace_id === id &&
            sameOriginAs(record.type === "token" ? record.instance_base_url : record.instance, auth.instance!)
          );
        });
  if (reaches !== undefined) return `Run \`${as(reaches)}\`.`;
  const taken = new Set(file === null ? [] : Object.keys(file.profiles));
  let fresh = `workspace-${id}`;
  for (let n = 2; taken.has(fresh); n++) fresh = `workspace-${id}-${n}`;
  const fileFlag = credentialFileFlag(path);
  if (auth.credentialType === "oauth") {
    const record = current === undefined ? undefined : stored(current);
    const origin = record?.type === "oauth" ? record.auth_host : undefined;
    return (
      `Run \`${loginCommand(fresh, { path, ...(origin === undefined ? {} : { origin }) })}\` and choose workspace ${id}, ` +
      `then run \`${as(fresh)}\`.`
    );
  }
  const instance = auth.instance ?? "<instance-url>";
  return (
    `Store a profile for workspace ${id} with \`printf %s "$TOKEN" | xanosdk profile add ${shellQuote(fresh)} ` +
    `--instance ${shellQuote(instance)} --workspace-id ${id}${fileFlag}\`, then run \`${as(fresh)}\`.`
  );
}

/**
 * The refusal for a name the pinned workspace missed and another reachable
 * workspace holds: SDK_USAGE exit 1, as {@link refuseUnreachableWorkspace}
 * answers a pinned id that is wrong — the fix is the same setting.
 * `details.reason` is `"wrong-workspace"`, with `heldIn` the workspace's id.
 */
export function heldElsewhereError(
  auth: Pick<ResolvedAuth, "credentialType" | "workspaceId"> & Partial<Pick<ResolvedAuth, "instance" | "profile">>,
  where: Extract<Whereabouts, { at: "elsewhere" }>,
  name: string,
  /** What did not happen, e.g. "nothing was deleted or cleared". */
  aftermath: string,
  command: string,
  details: Readonly<Record<string, unknown>>,
): CliError {
  const kind = where.kind === "ephemeral" ? "Ephemeral" : "Tenant";
  const label = `${where.workspace.id}${where.workspace.name === undefined ? "" : ` (${JSON.stringify(where.workspace.name)})`}`;
  return new CliError(
    "SDK_USAGE",
    `${kind} "${name}" is in workspace ${label}, not workspace ${auth.workspaceId} this credential is pinned to — ${aftermath}.\n` +
      rerunInWorkspace(auth, where.workspace.id, command),
    { exitCode: 1, details: { reason: "wrong-workspace", ...details, heldIn: where.workspace.id } },
  );
}
