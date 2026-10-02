/**
 * `xanosdk whoami` — print the scoped user and, most importantly, the
 * instance base URL. On an interactive terminal it prints an aligned, colorized
 * summary; when stdout is piped (an agent, `jq`, CI) it prints the projected
 * JSON verbatim, so machine consumers keep a stable, parseable contract.
 *
 * Reuses the existing `GET /api:meta/auth/me` endpoint. It **projects only**
 * `id`/`name`/`email` and the instance base URL (from the token binding via
 * `getAccessToken`) — it never emits the raw `extras` blob, which can carry OAuth
 * claims / membership internals and would land in shell history and CI logs.
 *
 * Node-only and lazily imported (like `login`/`logout`) so the browser-safe
 * authoring bundle never pulls in the OAuth stack.
 */
import type { ParsedArgs } from "./cli.js";
import { credentialRejected, getAccessToken, type ResolvedAuth } from "../auth/token.js";
import { profileSourceLabel, selectionDocument, type ProfileSelection } from "../auth/profile-select.js";
import { stdoutStyle, formatFields, printHuman, warn } from "./ui.js";
import { readReachableWorkspaces, reachableInline, reachableLines, workspaceIdFix } from "./workspace-binding.js";
import { fetchOrExplain, httpFailure, parseJsonAnswer } from "../util/http.js";
import { isMachineOutput, writeJson } from "./output.js";
import {
  CREDENTIAL_FILE_VERSION,
  credentialFileFlag,
  loginCommand,
  readCredentialFile,
  resolveAuthFilePath,
  UPGRADE_REMEDY,
  type SignInTarget,
} from "../auth/store.js";
import { shellQuote } from "../util/shell-quote.js";

/** Bound the metadata fetch so a stalled endpoint can't hang the CLI. */
const PROFILE_TIMEOUT_MS = 30_000;

/** The projected, safe-to-print profile. Never carries the raw `extras` blob. */
export interface Profile {
  /** Instance base URL — the headline field, from the token's `aud` binding. */
  instance: string;
  user: { id: number | undefined; name: string | undefined; email: string | undefined };
  /** Numeric workspace the credential is pinned to. */
  workspaceId: number;
  /**
   * The same workspace as `status` reports it: its name when the signed-in
   * user's answer carries it for this id (null otherwise), and which kind of
   * credential selected it.
   */
  workspace: WorkspaceView;
  /**
   * Which stored profile answered, and the rung that chose it. Null on the
   * environment-credential paths, which have no profile map behind them — and
   * saying "default" there would misreport where the credential came from.
   */
  profile: ProfileSelection | null;
}

/** A pinned workspace as `whoami` and `status` both print it. */
export interface WorkspaceView {
  id: number;
  name: string | null;
  /** Which credential selected it: the only thing that does. */
  credential: string;
  /** Present only when something about the binding needs saying — as `status` carries it. */
  note?: string;
}

/**
 * The "Workspace" value `whoami` and `status` both print — `5 · name · oauth`.
 * One function, so the two commands answering the same question cannot drift
 * into two spellings of the same row.
 */
export function workspaceValue(ws: WorkspaceView, s: ReturnType<typeof stdoutStyle>): string {
  return `${ws.id}${ws.name === null ? "" : ` · ${ws.name}`} ${s.dim(`· ${ws.credential}`)}`;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * The fix for a credential the instance refused, by where it came from: a
 * stored token profile is replaced with `profile add --force`, an OAuth one by
 * signing in again, and an environment credential is the variable to fix.
 */
export function rejectedRemedy(auth: ResolvedAuth, args?: ParsedArgs): string {
  const p = auth.profile;
  const command = rejectedFixCommand(auth, args);
  if (p === undefined) {
    return auth.credentialType === "token"
      ? "The meta API token in XANO_META_TOKEN was rejected — replace it with a valid token for XANO_INSTANCE_URL."
      : "The environment's refresh credential was rejected — replace XANO_REFRESH_TOKEN, or unset it to use a stored profile.";
  }
  const what = auth.credentialType === "token" ? "meta API token" : "session";
  const head = `The instance rejected the ${what} stored for profile "${p.name}" (${profileSourceLabel(p.source, p.defaultIn)}). `;
  if (command === null) {
    // Only a file this CLI cannot write: the replacing command would be refused.
    const newer = args === undefined ? undefined : storedSignInTarget(args, p.name).newer;
    return (
      head +
      `The credential file at ${newer?.path} is version ${newer?.version}, newer than this CLI can write ` +
      `(${CREDENTIAL_FILE_VERSION}) — ${UPGRADE_REMEDY.replace(/ and try again\.$/, "")}, then replace it from the newer CLI.`
    );
  }
  return auth.credentialType === "token"
    ? head + `Replace it with \`${command}\`.`
    : head + `Sign in again with \`${command}\`.`;
}

/**
 * `err`, coded `SDK_CREDENTIAL_REJECTED` with {@link rejectedRemedy}'s facts as
 * its `--json` details: which credential was refused, and the command that
 * replaces it — what `status` reports as `profile` and `signIn`.
 */
export function asRejectedCredential<E extends Error>(err: E, auth: ResolvedAuth, args?: ParsedArgs): E {
  return credentialRejected(err, {
    profile: auth.profile?.name ?? null,
    credentialType: auth.credentialType,
    instance: auth.instance,
    workspaceId: auth.workspaceId,
    signIn: rejectedFixCommand(auth, args),
  });
}

/**
 * The one command that replaces a rejected stored credential, or null for an
 * environment credential — the fix there is a variable, not a command — and for
 * a credential file a newer CLI wrote, which this one refuses to write (the
 * remedy is an upgrade). `status` reports it as `signIn`.
 */
export function rejectedFixCommand(auth: ResolvedAuth, args?: ParsedArgs): string | null {
  const p = auth.profile;
  if (p === undefined) return null;
  const target = args === undefined ? {} : storedSignInTarget(args, p.name);
  if (target.newer !== undefined) return null;
  // `--profile` stays explicit even for `default`: this names the profile the
  // instance refused, which a pin or XANO_PROFILE may have chosen.
  return auth.credentialType === "token"
    ? `xanosdk profile add ${shellQuote(p.name)}${credentialFileFlag(target.path)} --instance ${auth.instance} --workspace-id ${auth.workspaceId} --force`
    : loginCommand(p.name, target, ["--force"]).replace(/^xanosdk login(?! --profile)/, `xanosdk login --profile ${shellQuote(p.name)}`);
}

/**
 * Where a replacing sign-in for `profile` has to go: the credential file this
 * run read, and the sign-in server the profile was minted at. Best-effort — it
 * only words a remedy, so anything unreadable just leaves that part out.
 */
function storedSignInTarget(
  args: ParsedArgs,
  profile: string,
): SignInTarget & { newer?: { path: string; version: number } } {
  let path: string;
  try {
    path = resolveAuthFilePath(args);
  } catch {
    return {};
  }
  try {
    const file = readCredentialFile(path);
    const raw = file?.profiles[profile] as { auth_host?: unknown } | undefined;
    return {
      path,
      origin: typeof raw?.auth_host === "string" ? raw.auth_host : undefined,
      ...(file !== null && file.version > CREDENTIAL_FILE_VERSION ? { newer: { path, version: file.version } } : {}),
    };
  } catch {
    return { path };
  }
}

/**
 * Fetch and project the authenticated profile. The instance base URL comes from
 * the token binding (not the server); the user comes from `auth/me`. The raw
 * `extras` blob is deliberately dropped.
 */
export async function fetchProfile(args: ParsedArgs): Promise<Profile> {
  const auth = await getAccessToken(args);
  const { access_token, instance } = auth;
  const url = new URL("/api:meta/auth/me", instance);
  const res = await fetchOrExplain(
    url.href,
    {
      headers: { Authorization: `Bearer ${access_token}` },
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    },
    "whoami",
    PROFILE_TIMEOUT_MS,
  );
  const text = await res.text();
  if (!res.ok) {
    const head = httpFailure("whoami", res, text);
    // A rejected credential: say WHICH one, and the command that replaces it —
    // the bare status line leaves the reader to work out both.
    if (res.status === 401 || res.status === 403) {
      throw asRejectedCredential(new Error(`${head}\n${rejectedRemedy(auth, args)}`), auth, args);
    }
    // The status rides on the error: a 5xx is no answer, and exits 8 as one.
    throw Object.assign(new Error(head), { status: res.status });
  }
  // Never the route or the raw body: a wrong host, a proxy or a captive portal
  // answers with a whole HTML page, and the host is what the reader checks.
  const data = (parseJsonAnswer(text, "whoami", url.href) ?? {}) as Record<string, unknown>;
  return {
    instance,
    user: {
      id: typeof data.id === "number" ? data.id : undefined,
      name: asString(data.name),
      email: asString(data.email),
    },
    workspaceId: auth.workspaceId,
    workspace: await pinnedWorkspace(auth),
    profile: auth.profile ?? null,
  };
}

/**
 * The pinned workspace, named from the same workspace list `status` reads — so
 * the two print one Workspace row. A list that holds other workspaces and not
 * this id is a credential pinned to one it cannot see (a wrong
 * `XANO_WORKSPACE_ID`): warned, with the fix and the ids that would work, and
 * carried as `note` the way `status` carries it. A list that fails leaves the
 * name out rather than failing `whoami` — the identity is already answered.
 */
async function pinnedWorkspace(auth: ResolvedAuth): Promise<WorkspaceView> {
  const view: WorkspaceView = { id: auth.workspaceId, name: null, credential: auth.credentialType };
  const all = await readReachableWorkspaces(auth, PROFILE_TIMEOUT_MS);
  if (all === undefined) return view;
  const match = all.find((w) => w.id === auth.workspaceId);
  if (match !== undefined) return { ...view, name: match.name ?? null };
  if (all.length === 0) return view;
  const reach = reachableLines(all);
  warn(`This credential cannot see workspace ${auth.workspaceId}. ${workspaceIdFix(auth)}.`, "workspace.unreachable", [
    `Workspaces you can reach:\n${reach}`,
  ]);
  return {
    ...view,
    note: `this credential cannot see workspace ${auth.workspaceId} — the ids it can: ${reachableInline(all)}`,
  };
}

/**
 * The "Signed in" value `whoami` and `status` both print: name, email, and the
 * user id dimmed after them. One function, so the two commands answering the
 * same question cannot drift into two spellings of the same row.
 */
export function signedInValue(
  user: { id: number | undefined; name: string | undefined; email: string | undefined } | null | undefined,
  s: ReturnType<typeof stdoutStyle>,
): string {
  const who = [user?.name, user?.email && `<${user.email}>`].filter(Boolean).join(" ");
  const id = user?.id !== undefined ? ` ${s.dim(`· id ${user.id}`)}` : "";
  return who !== "" ? `${who}${id}` : s.dim("(unknown user)");
}

/**
 * The "Profile" value, shared the same way. Where the SELECTION came from, not
 * just its name: "right credentials, wrong profile" is the predictable failure,
 * and it is unreadable without knowing what chose the one in play.
 */
export function profileValue(profile: ProfileSelection | null, s: ReturnType<typeof stdoutStyle>): string {
  return profile === null
    ? s.dim("from the environment · no stored profile")
    : `${profile.name} ${s.dim(`· ${profileSourceLabel(profile.source, profile.defaultIn)}`)}`;
}

/** Render the profile as an aligned, colorized summary for an interactive terminal. */
function prettyProfile(p: Profile): string {
  const s = stdoutStyle();
  // Signed in, Instance, Workspace, Profile — the order `status` prints them in.
  return (
    "\n" +
    formatFields([
      ["Signed in", signedInValue(p.user, s)],
      ["Instance", s.bold(s.cyan(p.instance))],
      ["Workspace", workspaceValue(p.workspace, s)],
      ["Profile", profileValue(p.profile, s)],
    ])
  );
}

export async function runWhoamiCommand(args: ParsedArgs): Promise<void> {
  // A read that got no answer exits 8 with this run as the rerun, as `status` does.
  const profile = await fetchProfile(args).catch(async (err: unknown) => {
    const { unansweredRead } = await import("./source-resolve.js");
    throw unansweredRead(err, "read the signed-in user", "workspace");
  });
  // A terminal gets the human summary; a pipe (agent/jq/CI) — or `--json` — gets
  // the stable JSON.
  if (isMachineOutput(args)) {
    writeJson({ ...profile, profile: selectionDocument(profile.profile) });
  } else {
    printHuman(prettyProfile(profile));
  }
}
