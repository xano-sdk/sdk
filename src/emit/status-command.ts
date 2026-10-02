/**
 * `xanosdk status` — the four things you have to know before running anything
 * else, in one read: who you are signed in as, which instance and workspace the
 * credential is bound to, which ephemeral environment THIS project last
 * deployed to, and whether that environment is still alive.
 *
 * It exists because that answer was spread across three commands — `whoami`,
 * `workspace details`, `ephemeral get <name>` — and the last one needed a name
 * the user had to already know. The name was never a mystery to the CLI: it is
 * tracked in `.xano/ephemeral.json` and is already the default for
 * `test --name`. This command just says it out loud.
 *
 * ## Reports rather than throws
 *
 * The question "what is my state" is asked exactly when the state might be
 * wrong, so a missing credential is an ANSWER here — `Signed in: no` and the
 * command that fixes it — not a failure. Same for a workspace the credential
 * cannot see and an environment that has expired: each is reported in place and
 * the rest of the report still prints. A network or parse failure IS still a
 * failure, because then the report would be a guess.
 *
 * ## Reads only
 *
 * Deliberately not `resolveLive`, which clears the local record for a dead
 * tenant. Answering "is it alive" must not be the thing that forgets which
 * environment you were asking about — the next `xanosdk status` would report
 * "none tracked" and lose the name you came to look up.
 *
 * The same rule covers the local engine: its liveness is asked of the
 * engine's own enumeration, and a stale record is REPORTED as not running
 * rather than cleared the way a resolve clears it.
 *
 * ## What a bare command would do
 *
 * `deployed` is the answer the tracked-backend resolver gives — pointer, then
 * fallback — or the reason a bare command would refuse, word for word. It and
 * `localEngine` are read before the credential, so a signed-out agent still
 * learns where a bare command goes; neither makes a network call.
 *
 * Node-only and lazily imported (like `whoami`/`login`) so the browser-safe
 * authoring bundle never pulls in the OAuth stack.
 */
import type { ParsedArgs } from "./cli.js";
import { getAccessToken, NotSignedInError, StoredCredentialError, type ResolvedAuth } from "../auth/token.js";
import { isExpired } from "../deploy/ephemeral.js";
import { environmentKey, getEnvironment, readEphemeralState, unreadableEphemeralState } from "../deploy/ephemeral-state.js";
import { fetchOrExplain, httpFailure, parseJsonAnswer } from "../util/http.js";
import { rejectedFixCommand, rejectedRemedy, signedInValue, profileValue, workspaceValue } from "./whoami-command.js";
import { isProjectDir, projectDirFrom } from "./xanosdk-project.js";
import { isMachineOutput, writeJson } from "./output.js";
import { CliError, isUsageError } from "./errors.js";
import { reachableInline, reachableWorkspaces } from "./workspace-binding.js";
import { formatFields, formatExpiration, printHuman, stdoutStyle } from "./ui.js";
import { selectionDocument, type ProfileSelection } from "../auth/profile-select.js";
import { readTrackedBackend, type TrackedAnswer } from "./tracked-backend.js";
import { shellQuote } from "../util/shell-quote.js";
import { displayPath } from "../util/rel-path.js";
import {
  loginCommand,
  profileAddCommand,
  recordedCredentialPath,
  recordedProfileStored,
} from "../auth/store.js";
import { credentialFileFlagFor, credentialFileOf, ENV_CREDENTIAL_VARS, recordedByEnvCredential } from "./context-flags.js";
import { retryCommand } from "./retry-command.js";
import { getEngineRecord } from "../deploy/local-engine-state.js";
import { readDeployed } from "../deploy/deployed-state.js";
import { isLoopbackUrl, type LocalEngine } from "../deploy/local-engine-handshake.js";
import { LookupFailedError, lookupEphemeral, type ResolveDeps } from "./source-resolve.js";
import { EXIT_SOURCE_UNRESOLVABLE } from "./source-selector.js";

/** Bound each read so a stalled endpoint cannot hang the CLI/CI. */
const TIMEOUT_MS = 30_000;

/** The projected status. Every field is either an answer or an explicit null. */
export interface Status {
  /**
   * The project directory this report is about — found by walking up from the
   * working directory, as the profile pin is — or null outside any project.
   */
  project: string | null;
  /** False when no usable credential was found — the other blocks are then null. */
  signedIn: boolean;
  /**
   * The command that signs this run in, when it is not: `xanosdk login`, or
   * `xanosdk profile set-default <name>` when only the stored default is gone
   * and other profiles remain, or the fix `credentialFailure` names. Null when
   * signed in, and when the fix is not a command (see `credentialFailure`).
   */
  signIn: string | null;
  /**
   * Set when a credential WAS found and the instance refused it (401/403): which
   * credential, and the fix — the sentence `whoami` gives. `signedIn` is then
   * false and `signIn` is the replacing command (null for an environment
   * credential, whose fix is a variable). Null otherwise.
   */
  rejected: string | null;
  /**
   * Set when a credential exists but could not be USED — its refresh failed, a
   * stored record was refused before anything was sent, the credential file or
   * an environment credential is malformed: the reason and its fix, the
   * sentence `whoami` prints. `signIn` is then the command that fixes it, or
   * null when the fix is not a sign-in (re-run the command after a server-side
   * refresh failure; correct a variable). Null otherwise.
   */
  credentialFailure: string | null;
  /**
   * Instance base URL from the token binding, or null when no credential was
   * found. A rejected credential still names the instance it was bound to.
   */
  instance: string | null;
  /**
   * Which stored credential profile this run acts as, and the rung that chose
   * it. Null when not signed in, and null on the environment-credential paths,
   * which have no profile map behind them.
   */
  profile: ProfileSelection | null;
  user: { id: number | undefined; name: string | undefined; email: string | undefined } | null;
  workspace: {
    id: number;
    /** Null when the credential is pinned to a workspace it cannot see — see `note`. */
    name: string | null;
    /** Which credential selected it: the only thing that does. */
    credential: string;
    /** Present only when something about the binding needs saying. */
    note?: string;
  } | null;
  /**
   * The ephemeral this project last deployed to, from `.xano/ephemeral.json`.
   * Null when nothing has been deployed from here yet.
   */
  environment: {
    name: string;
    display: string | undefined;
    url: string | undefined;
    /** The engine's own state string, or null when the tenant is gone. */
    state: string | null;
    expiresAt: string | number | undefined;
    /**
     * False for an expired or swept tenant — the question `ephemeral get`
     * answered. Null when the lookup got no answer (a network failure or a
     * server error): unknown, not gone, and `note` says why.
     */
    alive: boolean | null;
    /** Present only when `alive` is null: why the lookup could not answer. */
    note?: string;
  } | null;
  /**
   * When `environment` is null because the project's ephemeral is recorded
   * under ANOTHER credential: each such record — the profile it was deployed
   * as, the workspace and instance host it lives on, the credential file that
   * profile was read from (null when the record does not say: an environment
   * credential or an older record), and the command that reaches it: the
   * `xanosdk status` that reports it when that profile is stored in that file,
   * else the `xanosdk login` that creates it there (a `--profile` naming a
   * profile no file holds exits 8). Signed out, every record the project holds (none is under "this
   * credential"). Null when there is none, or when the environment was found.
   */
  /**
   * Present when `environment` is null because `.xano/ephemeral.json` exists but
   * cannot be read (bad JSON, empty, not an object): its path. The ephemeral it
   * recorded may still be alive — `xanosdk ephemeral list` finds it.
   */
  environmentUnreadable?: string;
  environmentTrackedUnder: Array<{
    profile: string | null;
    workspaceId: number | null;
    host: string | null;
    file: string | null;
    command: string | null;
    /**
     * Present when `command` is a `xanosdk login` because the profile is no
     * longer stored: the `xanosdk profile add` that stores a meta API token for
     * it instead (piped on stdin) — the record cannot say which kind it was.
     */
    tokenCommand?: string;
    /**
     * Present (true) when the record was made under an environment credential:
     * no profile or file reaches it, only those variables set again. `profile`
     * and `command` are then null.
     */
    environmentCredential?: true;
  }> | null;
  /**
   * What a bare command would go to: the kind the tracked-backend resolver
   * answers (via the pointer, or the fallback when there is none), or `kind:
   * null` with the refusal a bare command would print. Present signed in or out.
   */
  deployed: TrackedAnswer;
  /**
   * The local engine recorded for this directory, or null when none is. `url`
   * is the one the engine serves now when it is running, else the recorded one.
   * Never carries the engine's bearer or sign-in url.
   */
  localEngine: {
    name: string;
    url: string;
    /**
     * `live` — running and on loopback; `not-running` — the enumeration does not
     * show it (the record is stale, and left alone here); `unreachable` —
     * running somewhere its bearer may not follow; `unknown` — nothing on this
     * machine could be asked.
     */
    liveness: "live" | "not-running" | "unreachable" | "unknown";
  } | null;
}

/** Seams the tests replace; production passes nothing. */
export interface StatusDeps {
  /** Where local-engine records and the engine cache live. Defaults to the process env. */
  env?: NodeJS.ProcessEnv;
  /** The engine's own enumeration; see `ResolveDeps.listEngines`. */
  listEngines?: ResolveDeps["listEngines"];
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * What a dead connection means HERE, said out loud.
 *
 * `status` is asked when something is already wrong, and a transport failure
 * reaching the instance looks exactly like a credential problem from the outside
 * — so the reflex is to sign in again. That reflex costs something: a refresh
 * token is single-use, and burning one on a blocked network leaves the
 * credential worse than the network found it.
 */
const NETWORK_HINT =
  "A connection failure here is usually blocked egress, not a bad credential — check network access to the instance before running `xanosdk login`, which rotates a single-use refresh token.";

/** A non-2xx answer, carrying its status so a caller can tell a refused credential apart. */
class StatusReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Authed GET returning parsed JSON; throws the shared one-line failure on non-2xx. */
async function getJson(url: string, auth: ResolvedAuth, action: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchOrExplain(
      url,
      {
        headers: { accept: "application/json", Authorization: `Bearer ${auth.access_token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      action,
      TIMEOUT_MS,
    );
  } catch (err) {
    // Only the transport path. A 4xx below has the server's own sentence, which
    // IS about the credential often enough that this line would mislead.
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${NETWORK_HINT}`, { cause: err });
  }
  const text = await res.text();
  if (!res.ok) throw new StatusReadError(httpFailure(action, res, text), res.status);
  // Never the route or the raw body: a wrong host answers with a whole HTML page.
  return parseJsonAnswer(text, action, url);
}

/**
 * The workspace block: the pinned id, and the name it resolves to.
 *
 * A well-formed but WRONG `workspace_id` is the likeliest hand-authoring
 * mistake and is invisible everywhere else. `workspace details` fails hard on
 * it, which is right for a command whose whole job is that one question; here it
 * is one line of a report, so it is carried as a `note` and the rest still
 * prints.
 */
async function readWorkspace(auth: ResolvedAuth): Promise<Status["workspace"]> {
  const list = await getJson(`${auth.instance}/api:meta/workspace`, auth, "status (workspace list)");
  const all = Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
  const match = all.find((w) => w.id === auth.workspaceId);
  if (match === undefined) {
    return {
      id: auth.workspaceId,
      name: null,
      credential: auth.credentialType,
      note:
        `this credential cannot see workspace ${auth.workspaceId}` +
        (reachableWorkspaces(all).length > 0 ? ` — the ids it can: ${reachableInline(reachableWorkspaces(all))}` : ""),
    };
  }
  return {
    id: auth.workspaceId,
    name: asString(match.name) ?? null,
    credential: auth.credentialType,
  };
}

/**
 * The environment block: the tenant this project last deployed to, and whether
 * it is still there.
 *
 * A 404 and an expired row are the same answer to the user — the environment is
 * gone — so both come back `alive: false` with the name intact, which is what
 * makes the report worth reading after a tenant has been swept.
 */
async function readEnvironment(auth: ResolvedAuth, cwd: string): Promise<Status["environment"]> {
  const tracked = getEnvironment(readEphemeralState(cwd), auth);
  if (tracked === undefined) return null;
  // A lookup that got no answer — a network failure, a server error — proves
  // nothing about the ephemeral: reported as unknown with the reason, and the
  // rest of the report still prints, as an unreadable local engine's does
  // (E2E pass 30: a 5xx here failed the whole status).
  let summary: Awaited<ReturnType<typeof lookupEphemeral>>;
  try {
    summary = await lookupEphemeral(auth, tracked.name);
  } catch (err) {
    if (!(err instanceof LookupFailedError)) throw err;
    return {
      name: tracked.name,
      display: tracked.display,
      url: tracked.url,
      state: null,
      expiresAt: tracked.expires_at,
      alive: null,
      note: err.head,
    };
  }
  if (summary === null) {
    // Gone server-side. The local record still names it, and is deliberately
    // left alone — see the module header.
    return {
      name: tracked.name,
      display: tracked.display,
      url: tracked.url,
      state: null,
      expiresAt: tracked.expires_at,
      alive: false,
    };
  }
  return {
    name: summary.name,
    display: summary.display,
    url: summary.url,
    state: summary.state ?? null,
    expiresAt: summary.expiresAt,
    alive: !isExpired(summary.expiresAt),
  };
}

/**
 * The engine recorded for this directory, and whether it is running — asked of
 * the engine's own enumeration, never inferred from the record. A failed or
 * impossible enumeration is `unknown`, not an error: it proves nothing about
 * the engine, and the rest of the report still prints.
 */
async function readLocalEngine(cwd: string, deps: StatusDeps): Promise<Status["localEngine"]> {
  const env = deps.env ?? process.env;
  const record = getEngineRecord(cwd, env);
  if (record === undefined) return null;
  let running: readonly LocalEngine[] | undefined;
  try {
    running = await (deps.listEngines ?? defaultEnumeration(env, cwd))();
  } catch {
    running = undefined;
  }
  if (running === undefined) return { name: record.name, url: record.url, liveness: "unknown" };
  const engine = running.find((e) => e.name === record.name);
  if (engine === undefined) return { name: record.name, url: record.url, liveness: "not-running" };
  if (!isLoopbackUrl(engine.url)) return { name: record.name, url: engine.url, liveness: "unreachable" };
  return { name: record.name, url: engine.url, liveness: "live" };
}

/** The enumeration through the cached binary, loaded lazily: it runs a subprocess. */
function defaultEnumeration(env: NodeJS.ProcessEnv, cwd: string): () => Promise<readonly LocalEngine[] | undefined> {
  return async () => {
    const { cachedEngineEntry, listEngines } = await import("../deploy/local-engine-process.js");
    const entry = cachedEngineEntry(env, cwd);
    return entry === undefined ? undefined : listEngines({ entry, env });
  };
}

/**
 * Was the missing profile chosen by name? `-p` always is. So are a pointer and
 * `$XANO_PROFILE`, when the file holds other profiles — the credential file's
 * own default and the implicit `default` are not a choice anyone made.
 */
function isNamed(args: ParsedArgs, err: NotSignedInError): boolean {
  if (args.profile !== undefined) return true;
  const source = err.missingProfile?.source;
  return source === "flag" || source === "pointer" || source === "env";
}

/**
 * The fix for "not signed in". A default that `profile delete` removed while
 * other profiles remain needs no new sign-in — pointing the default at one of
 * them is the fix, and the one `whoami` already names.
 */
function signInCommand(err: unknown, args: ParsedArgs): string {
  const stored = err instanceof NotSignedInError ? err.storedProfiles : [];
  // Carrying `--config`/`--local`: a bare fix would act on the shared file,
  // not the one this run read.
  const flag = readFileFlag(args);
  if (stored.length === 0) return `xanosdk login${flag}`;
  return `xanosdk profile set-default ${stored.length === 1 ? stored[0]! : "<name>"}${flag}`;
}

/**
 * The flag that makes a later command read the credential file this run read.
 * Already resolved once by the credential read, so this cannot newly throw —
 * but a status must not fail on its own advice.
 */
function readFileFlag(args: ParsedArgs): string {
  // None when an environment credential resolved: it displaced the file, and a
  // hint naming it would send the next run to a file it ignores too.
  const recorded = credentialFileOf(args);
  return recorded === undefined ? "" : credentialFileFlagFor(recorded);
}


/**
 * Gather the status. `start` is where the lookup begins — the project whose
 * `.xano/ephemeral.json` is read is found by walking up from it. A parameter
 * so tests do not have to chdir.
 */
export async function readStatus(
  args: ParsedArgs,
  start: string = process.cwd(),
  deps: StatusDeps = {},
): Promise<Status> {
  const env = deps.env ?? process.env;
  const project = projectDirFrom(start) ?? null;
  const cwd = project ?? start;
  // Before the credential: a signed-out agent gets these too.
  const localEngine = await readLocalEngine(cwd, deps);

  let auth: ResolvedAuth;
  try {
    auth = await getAccessToken(args);
  } catch (err) {
    // A USAGE failure is the caller contradicting themselves — `--profile`
    // against an environment credential that outranks it — and reporting that
    // as "not signed in" would answer a question they did not ask while
    // silently dropping the flag they typed.
    if (isUsageError(err)) throw err;
    // Same for a profile typed on THIS command line (`-p`) that is not stored:
    // that asks about one profile, and "not signed in" would hide the typo
    // behind an answer about the machine. Refused with `whoami`'s message.
    if (err instanceof NotSignedInError && args.profile !== undefined) throw err;
    // A profile named by AMBIENT state — this project's xano.profile.json or
    // $XANO_PROFILE — is state to report, not a command to refuse: `status` is
    // what someone runs to find out why nothing works, and it answers every
    // other credential trouble as data. The name, the reason and every remedy
    // travel in the report, so nothing about which profile was asked is lost.
    if (err instanceof NotSignedInError && isNamed(args, err)) {
      const missing = err.missingProfile!;
      return {
        signedIn: false,
        project,
        signIn: `xanosdk login --profile ${shellQuote(missing.name)}${readFileFlag(args)}`,
        rejected: null,
        credentialFailure: err.message,
        instance: null,
        profile: missing,
        user: null,
        workspace: null,
        environment: null,
        environmentTrackedUnder: null,
        deployed: deployedHere(cwd, env, undefined),
        localEngine,
      };
    }
    // Not signed in is the ANSWER, not a failure — see the module header.
    // Absence has one fix, which `signIn` names. A credential that EXISTS and
    // did not work does not: a refresh the server answered 500 is fixed by a
    // re-run (a sign-in there spends a refresh token for nothing), a refused
    // `auth_host` only by `login --force`. So its reason and fix are carried.
    if (!(err instanceof NotSignedInError)) {
      const stored = err instanceof StoredCredentialError ? err : undefined;
      return {
        signedIn: false,
        project,
        signIn: stored?.fix ?? null,
        rejected: null,
        credentialFailure: err instanceof Error ? err.message : String(err),
        instance: stored?.instance ?? null,
        profile: stored?.profile ?? null,
        user: null,
        workspace: null,
        environment: null,
        environmentTrackedUnder: null,
        deployed: deployedHere(cwd, env, undefined),
        localEngine,
      };
    }
    // Signed out, the project's ephemeral is still recorded under SOME
    // credential — every record is "another" one. Naming it answers the
    // question a bare `xanosdk login` hid: the project is reachable, through
    // that profile and file, and a fresh sign-in would not reach it.
    const tracked = project === null ? [] : trackedUnderOthers(project, undefined);
    return {
      signedIn: false,
      project,
      signIn: trackedRemedy(tracked) ?? signInCommand(err, args),
      rejected: null,
      credentialFailure: null,
      instance: null,
      profile: null,
      user: null,
      workspace: null,
      environment: null,
      environmentTrackedUnder: tracked.length > 0 ? tracked : null,
      // No credential: the fallback skips the ephemeral check, as a bare command's does.
      deployed: deployedHere(cwd, env, undefined),
      localEngine,
    };
  }

  // Labelled from the CALLER's side. This read is the same one `xanosdk whoami`
  // makes, but naming it "whoami" in a failure told the reader `status` had
  // shelled out to another command — or that they had typed the wrong one.
  // The step is what failed; say which step.
  let me: Record<string, unknown>;
  try {
    me = (await getJson(`${auth.instance}/api:meta/auth/me`, auth, "status (signed-in user)")) as Record<
      string,
      unknown
    >;
  } catch (err) {
    // A credential the instance REFUSED is an answer too — the same one a
    // missing credential is: not signed in, and the command that fixes it.
    // The bare "401 Unauthorized: Invalid token." named neither which
    // credential nor the fix; this is `whoami`'s sentence for both.
    if (err instanceof StatusReadError && (err.status === 401 || err.status === 403)) {
      return {
        signedIn: false,
        project,
        signIn: rejectedFixCommand(auth, args),
        rejected: rejectedRemedy(auth, args),
        credentialFailure: null,
        instance: auth.instance,
        profile: auth.profile ?? null,
        user: null,
        // The pin is known without the instance's help: which workspace the
        // refused credential addresses is half of "which credential".
        workspace: { id: auth.workspaceId, name: null, credential: auth.credentialType },
        environment: null,
        environmentTrackedUnder: null,
        deployed: deployedHere(cwd, env, auth),
        localEngine,
      };
    }
    throw err;
  }
  return {
    signedIn: true,
    project,
    signIn: null,
    rejected: null,
    credentialFailure: null,
    instance: auth.instance,
    profile: auth.profile ?? null,
    user: {
      id: typeof me.id === "number" ? me.id : undefined,
      name: asString(me.name),
      email: asString(me.email),
    },
    workspace: await readWorkspace(auth),
    ...(await environmentBlock(auth, cwd, project)),
    deployed: deployedHere(cwd, env, auth),
    localEngine,
  };
}

/**
 * {@link readTrackedBackend}, except outside any project: there the resolver's
 * "This project has no backend…" describes a project that does not exist, so
 * the reason says there is none here instead. A tracked answer still wins —
 * `.xano/` state in this directory is a project's, whatever else is missing.
 */
function deployedHere(cwd: string, env: NodeJS.ProcessEnv, scope: ResolvedAuth | undefined): TrackedAnswer {
  const answer = readTrackedBackend({ cwd, env, scope });
  if (answer.kind !== null || isProjectDir(cwd)) return answer;
  return {
    ...answer,
    // "Inside", not "from a project's root": any subdirectory of one finds it.
    reason:
      `No Xano SDK project here (${cwd}) — run \`xanosdk status\` from inside a Xano SDK project, ` +
      `or \`xanosdk init\` to start one.`,
  };
}

/** `environment`, and — only when it is null — the records other credentials hold. */
async function environmentBlock(
  auth: ResolvedAuth,
  cwd: string,
  project: string | null,
): Promise<Pick<Status, "environment" | "environmentTrackedUnder" | "environmentUnreadable">> {
  const environment = await readEnvironment(auth, cwd);
  if (environment !== null || project === null) return { environment, environmentTrackedUnder: null };
  const unreadable = unreadableEphemeralState(cwd);
  if (unreadable !== undefined) return { environment, environmentTrackedUnder: null, environmentUnreadable: unreadable };
  const others = trackedUnderOthers(project, auth);
  return { environment, environmentTrackedUnder: others.length > 0 ? others : null };
}

/**
 * The ephemerals this project records under some OTHER credential than
 * `auth`. Non-empty means a missing environment for this one is not "none yet":
 * `xanosdk deploy` would create a second ephemeral beside the one the project
 * already tracks — and the reader needs to know WHICH credential reaches it.
 */
function trackedUnderOthers(
  project: string,
  auth: ResolvedAuth | undefined,
): NonNullable<Status["environmentTrackedUnder"]> {
  let state;
  try {
    state = readEphemeralState(project);
  } catch {
    return [];
  }
  // Signed out (`auth` undefined), every record is under another credential.
  const mine = auth === undefined ? undefined : environmentKey(auth);
  return Object.entries(state.environments)
    .filter(([key]) => auth === undefined || (key !== mine && key !== String(auth.workspaceId)))
    .map(([key, record]) => {
      // Keys are `"<profile>/<instance host>/<workspaceId>"`; a legacy bare
      // numeric key names only the workspace.
      const parts = key.split("/");
      const profile = parts.length >= 3 ? parts[0]! : null;
      const host = parts.length >= 3 ? parts.slice(1, -1).join("/") : null;
      const recorded = record.credential_file;
      if (recordedByEnvCredential(record)) {
        const workspaceId = Number(parts[parts.length - 1]);
        return {
          profile: null,
          workspaceId: Number.isSafeInteger(workspaceId) && workspaceId > 0 ? workspaceId : null,
          host,
          file: null,
          command: null,
          environmentCredential: true as const,
        };
      }
      const file = recordedCredentialPath(recorded);
      // `status --profile p` for a profile its file no longer holds exits 8
      // naming a profile that does not exist; signing in creates it there.
      // A hand-edited key can end in something that is not a workspace id; it is
      // "unknown", not NaN (which JSON already writes as null).
      const rawWorkspace = Number(parts[parts.length - 1]);
      const workspaceId = Number.isSafeInteger(rawWorkspace) && rawWorkspace > 0 ? rawWorkspace : null;
      const gone = profile !== null && !recordedProfileStored(profile, recorded);
      const command =
        profile === null
          ? null
          : !gone
            ? `xanosdk status --profile ${profile}${recorded !== undefined ? credentialFileFlagFor(recorded) : ""}`
            : loginCommand(profile, { path: file ?? undefined });
      // A deleted TOKEN profile is not signed in again with OAuth: the record
      // cannot say which kind it was, so both are offered, filled from it.
      const tokenCommand = gone
        ? profileAddCommand(profile!, {
            path: file ?? undefined,
            instance: record.instance ?? (host !== null ? `https://${host}` : undefined),
            workspaceId: workspaceId ?? undefined,
          })
        : undefined;
      return { profile, workspaceId, host, file, command, ...(tokenCommand !== undefined ? { tokenCommand } : {}) };
    });
}

/**
 * Signed out: the command of the first record whose profile is still stored
 * in the file it names — that `xanosdk status` reports the project's ephemeral,
 * where a bare `xanosdk login` would sign in beside it. With none stored, the
 * first record's `xanosdk login` — it creates the profile the ephemeral is
 * recorded under, so the Signed-in row and the Environment row agree. Undefined
 * when no record names a profile.
 */
function trackedRemedy(entries: NonNullable<Status["environmentTrackedUnder"]>): string | undefined {
  // A record naming no file (older) is not vouched for: its profile may sit in
  // either default file, so its status is not offered as the one fix.
  const status = entries.find((e) => e.file !== null && e.command?.startsWith("xanosdk status ") === true);
  return status?.command ?? entries.find((e) => e.command?.startsWith("xanosdk login") === true)?.command ?? undefined;
}

/** The Environment row's words for records held by other credentials: which, and the command that reports each. */
function trackedUnderText(
  entries: NonNullable<Status["environmentTrackedUnder"]>,
  fromEnv: boolean,
  signedOut = false,
): string {
  const one = (e: (typeof entries)[number]): string => {
    const where = `workspace ${e.workspaceId ?? "unknown"}${e.host !== null ? ` on ${e.host}` : ""}`;
    const who =
      e.environmentCredential === true
        ? `the environment credential (${where}`
        : e.profile !== null
          ? `profile "${e.profile}" (${where}`
          : `another credential (${where}`;
    const file = e.file !== null ? `, credential file ${e.file}` : "";
    const run =
      e.command !== null
        ? e.tokenCommand !== undefined
          ? ` · \`${e.command}\` (OAuth), or \`${e.tokenCommand}\` (meta API token)`
          : ` · \`${e.command}\``
        : e.environmentCredential === true
          ? ` · set ${ENV_CREDENTIAL_VARS} for it`
          : "";
    return `${who}${file})${run}`;
  };
  // An environment credential outranks every stored profile and refuses
  // `--profile`, so the printed command only runs once it is out of the way.
  const envNote =
    fromEnv && entries.some((e) => e.command !== null)
      ? " (run without the environment credential — it outranks every stored profile)"
      : "";
  const lead = signedOut ? "not signed in" : "none under this credential";
  return `${lead} · the project's ephemeral is recorded under ${entries.map(one).join("; ")}${envNote}`;
}


/** The two rows every branch prints: where a bare command goes, and this directory's engine. */
function trackedRows(status: Status, s: ReturnType<typeof stdoutStyle>): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const d = status.deployed;
  if (status.project === null && d.kind === null) {
    // Outside a project there is nothing a bare command could deploy from, so
    // the row says that — the same row signed in, signed out or refused.
    rows.push(["Project", `none ${s.dim(`· ${d.reason}`)}`]);
  } else {
    rows.push([
      "Deployed",
      // `none` where a kind would be, then why: a bare command has no backend to
      // go to and refuses with that sentence. Not a bold "refuse" standing in for
      // a kind, which read as a backend by that name.
      d.kind === null ? `none ${s.dim(`· ${d.reason}`)}` : `${d.kind} ${s.dim(`· ${d.via === "pointer" ? "last deployed" : "recorded"}`)}`,
    ]);
  }
  const e = status.localEngine;
  if (e !== null) {
    const hint =
      e.liveness === "not-running"
        ? " · not running · `xanosdk deploy --local-engine` starts it"
        : e.liveness === "live"
          ? ""
          : ` · ${e.liveness}`;
    rows.push(["Local engine", `${e.name} ${s.dim(`· ${e.url}${hint}`)}`]);
  }
  return rows;
}

/** The instance and profile of a credential that exists but failed, when known. */
function credentialRows(status: Status, s: ReturnType<typeof stdoutStyle>): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (status.instance !== null) rows.push(["Instance", s.bold(s.cyan(status.instance))]);
  if (status.workspace !== null) rows.push(["Workspace", workspaceValue(status.workspace, s)]);
  if (status.profile !== null) rows.push(["Profile", profileValue(status.profile, s)]);
  return rows;
}

/** The display name trailing the name, dimmed, when it differs — as `ephemeral list` prints it. */
function displayLabel(env: NonNullable<Status["environment"]>, s: ReturnType<typeof stdoutStyle>): string {
  return env.display !== undefined && env.display !== "" && env.display !== env.name ? ` ${s.dim(env.display)}` : "";
}

/**
 * Render the status as an aligned, colorized summary for an interactive terminal.
 * `fileFlag` is the `--config`/`--local` this run read its credential through,
 * carried onto the `xanosdk deploy` it suggests — a bare one reads the shared file.
 */
function prettyStatus(status: Status, fileFlag = "", rerun = `xanosdk status${fileFlag}`): string {
  const s = stdoutStyle();
  if (!status.signedIn) {
    const rows: Array<[string, string]> =
      status.rejected !== null
        ? [
            ["Signed in", `${s.bold("no")} ${s.dim("· the instance rejected the credential")}`],
            // The same Instance/Profile rows a credential that failed locally
            // shows: which credential was refused is half the answer.
            ...credentialRows(status, s),
            ["", s.dim(status.rejected)],
          ]
        : status.credentialFailure !== null
          ? [
              ["Signed in", `${s.bold("no")} ${s.dim("· the credential could not be used")}`],
              ...credentialRows(status, s),
              ...status.credentialFailure.split("\n").map((line): [string, string] => ["", s.dim(line)]),
            ]
          : [["Signed in", `${s.bold("no")} ${s.dim(`· run \`${status.signIn ?? "xanosdk login"}\``)}`]];
    // The credential the project's ephemeral is recorded under — signed out,
    // the one fact that says which sign-in reaches it.
    if (status.project !== null && status.environmentTrackedUnder !== null) {
      rows.push(["Environment", s.dim(trackedUnderText(status.environmentTrackedUnder, false, true))]);
    }
    return `\n${formatFields([...rows, ...trackedRows(status, s)])}`;
  }

  // Signed in, Instance, Workspace, Profile — the rows `whoami` prints, in its
  // order and through its formatters, so the two read as one answer.
  const rows: Array<[string, string]> = [
    ["Signed in", signedInValue(status.user, s)],
    ["Instance", s.bold(s.cyan(status.instance ?? ""))],
  ];

  const ws = status.workspace;
  if (ws !== null) {
    rows.push(["Workspace", workspaceValue(ws, s)]);
    if (ws.note !== undefined) rows.push(["", s.dim(ws.note)]);
  }
  rows.push(["Profile", profileValue(status.profile, s)]);

  const env = status.environment;
  if (status.project === null) {
    // Outside a project there is nothing to deploy from here: "none yet · run
    // `xanosdk deploy`" sat beside "No Xano SDK project here" and contradicted it.
  } else if (env === null && status.environmentUnreadable !== undefined) {
    // The record cannot be read, so nothing here knows whether its ephemeral
    // is alive: "gone" or "none yet" would send the reader to make a second.
    rows.push([
      "Environment",
      s.dim(`unknown · ${displayPath(status.environmentUnreadable)} is unreadable · \`xanosdk ephemeral list${fileFlag}\` finds the ephemeral it recorded`),
    ]);
  } else if (env === null && status.environmentTrackedUnder !== null) {
    // The project DOES track an ephemeral — under another credential or
    // workspace. "run `xanosdk deploy`" here would create a second one. The
    // credential that reaches the first is named HERE: the Deployed row names
    // it only when a bare command would go to the ephemeral, and a recorded
    // local engine left "see Deployed" pointing at nothing.
    rows.push(["Environment", s.dim(trackedUnderText(status.environmentTrackedUnder, status.profile === null))]);
  } else if (env === null && status.deployed.kind === "local-engine") {
    // The project's tracked backend is a local engine: "none yet · run `xanosdk
    // deploy`" beside "Deployed local-engine · last deployed" read as though it
    // had never deployed (E2E pass 25). The row is about the hosted ephemeral.
    rows.push(["Environment", s.dim(`no ephemeral · \`xanosdk deploy${fileFlag}\` without --local-engine makes one`)]);
  } else if (env === null && readDeployed(status.project)?.kind === "ephemeral") {
    // The project HAS deployed to an ephemeral, and no record of it is left —
    // `ephemeral delete` (or a gone one) cleared it. "none yet" read as though
    // it never had (E2E pass 28).
    rows.push(["Environment", s.dim(`none tracked · the last one is gone (deleted or expired) · run \`xanosdk deploy${fileFlag}\` for a fresh one`)]);
  } else if (env === null) {
    // Named as a next step rather than a gap: nothing is wrong with a project
    // that has not deployed yet, and this is the command that changes it.
    rows.push(["Environment", s.dim(`none yet · run \`xanosdk deploy${fileFlag}\``)]);
  } else if (env.alive === null) {
    rows.push(["Environment", `${env.name}${displayLabel(env, s)} ${s.dim("· unknown — the lookup got no answer")}`]);
    if (env.note !== undefined) rows.push(["", s.dim(`${env.note}. Run \`${rerun}\` again once it answers.`)]);
  } else if (!env.alive) {
    rows.push([
      "Environment",
      `${env.name}${displayLabel(env, s)} ${s.dim(`· gone or expired · run \`xanosdk deploy${fileFlag}\` for a fresh one`)}`,
    ]);
  } else {
    const state = env.state === null ? "" : ` ${s.dim(`· ${env.state}`)}`;
    rows.push([
      "Environment",
      `${env.name}${displayLabel(env, s)}${state} ${s.dim(`· expires ${formatExpiration(env.expiresAt)}`)}`,
    ]);
    if (env.url !== undefined) rows.push(["URL", s.bold(s.cyan(env.url))]);
  }
  rows.push(...trackedRows(status, s));

  return `\n${formatFields(rows)}`;
}

export async function runStatusCommand(args: ParsedArgs): Promise<void> {
  const status = await readStatus(args).catch(async (err: unknown) => {
    const { unansweredRead } = await import("./source-resolve.js");
    throw unansweredRead(err, "read the status", "workspace");
  });
  // A terminal gets the human summary; a pipe (agent/jq/CI) — or `--json` — gets
  // the stable JSON.
  if (isMachineOutput(args)) {
    const env = status.environment;
    const doc = { ...status, profile: selectionDocument(status.profile) };
    // The lookup got no answer: a failure document (exit 8), carrying the
    // report it could still read and the rerun, never a plain status beside a
    // failing exit (E2E pass 34).
    if (env?.alive === null) {
      // This run's own command line, flags and all — the rerun every other unanswered lookup names.
      const again = `${env.note ?? "The ephemeral lookup got no answer"}. Run \`${retryCommand(args, { command: "status" }).command}\` again once it answers.`;
      throw new CliError("SDK_ERROR", again, {
        exitCode: EXIT_SOURCE_UNRESOLVABLE,
        details: { status: { ...doc, environment: { ...env, note: again } } },
      });
    }
    writeJson(doc);
  } else {
    printHuman(prettyStatus(status, readFileFlag(args), retryCommand(args, { command: "status" }).command));
  }
  // The report is whole, but the one question it could not answer keeps the
  // exit a lookup that got no answer has everywhere: 8.
  if (status.environment?.alive === null) process.exitCode = EXIT_SOURCE_UNRESOLVABLE;
}
