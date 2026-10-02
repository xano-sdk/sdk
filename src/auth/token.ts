/**
 * Access-token lifecycle for the CLI. Owns the "produce a valid access token"
 * domain so command modules (today `push`, tomorrow anything else) don't each
 * re-implement the skew check, the discover→refresh dance, or — critically —
 * the server's refresh-token ROTATION invariant (`oauth.ts` `refresh`): the
 * refresh token you send is spent, and the returned one must be persisted.
 *
 * Node-only; keeps that invariant in exactly one place beside the token store.
 */
import { existsSync, statSync } from "node:fs";
import type { ParsedArgs } from "../emit/cli.js";
import { UsageError } from "../emit/errors.js";
import { registerSecret, tokenTextProblem } from "../util/secrets.js";
import { readEnvVar } from "../util/env.js";
import { expandHome, readPathEnvVar } from "../util/home-path.js";
import { dirname, resolve as resolvePath } from "node:path";
import { readEphemeralState } from "../deploy/ephemeral-state.js";
import { shellQuote } from "../util/shell-quote.js";
import { suggest } from "../util/suggest.js";
import { EXIT_SOURCE_UNRESOLVABLE } from "../emit/source-selector.js";
import {
  OpenIdProvider,
  oauthErrorCode,
  oauthErrorResponse,
  resolveOAuthErrorCode,
  decodeAudience,
  type RawTokens,
} from "./oauth.js";
import {
  readCredential,
  readCredentialFile,
  readProfile,
  profileNames,
  writeCredentialFile,
  writeOrRemoveCredentialFile,
  withCredentialLock,
  dropProfile,
  loginHint,
  loginCommand,
  credentialFileFlag,
  addProfileHint,
  resolveAuthFilePath,
  globalAuthFilePath,
  localAuthFilePath,
  buildTokenCredential,
  isSafeIdText,
  type CredentialFile,
  type CredentialRecord,
  type OAuthCredential,
  type TokenCredential,
} from "./store.js";
import { resolveAuthHost, resolveScope, assertHttpsOrigin, assertSignInOrigin, assertNoUserinfo, envOrigin } from "./config.js";
import {
  resolveActiveProfile,
  assertValidProfileName,
  describeProfileSelection,
  profileSourceLabel,
  ENV_PROFILE,
  DEFAULT_PROFILE,
  type ProfileSelection,
} from "./profile-select.js";
import { findProjectPointer, POINTER_FILE, type ProjectPin } from "./profile-pointer.js";
import { detail, info, warn, hostLabel, quotedNames, safeText } from "../emit/ui.js";
import { noteRunWarning } from "../emit/output.js";
import { RATE_LIMIT_MAX_WAIT_S, retryAfterSeconds, serverMessage } from "../util/http.js";
import { noteResolvedAuth } from "../util/last-credential.js";
import type { WarningCode } from "../codes.js";

/** Refresh this many ms before the cached access token actually expires. */
const EXPIRY_SKEW_MS = 30_000;

/**
 * The minimum any meta-API call needs: a bearer plus the origin it is valid for.
 * Transports that address a route directly (deploy POSTs, the workspace-id
 * lookup) take THIS, not {@link ResolvedAuth} — they have no business reading a
 * workspace id, and one of them is what derives it.
 */
export interface BearerTarget {
  access_token: string;
  /** Instance origin the token is bound to (also the push URL host). */
  instance: string;
}

/**
 * A usable bearer token plus the exact target it authorizes against.
 *
 * `workspaceId` is part of the credential, not a per-command choice: there is no
 * `--workspace` flag and no other way to reach a workspace id, so a command
 * physically cannot act on a workspace the credential is not bound to.
 */
export interface ResolvedAuth extends BearerTarget {
  /** Numeric workspace every command acts on. */
  workspaceId: number;
  /**
   * Which credential produced this. Reported by `workspace details` so a user
   * can see what they are acting under before a command acts.
   *
   * The CI refresh-grant path is `"oauth-refresh"`, NOT `"oauth"`. The two are
   * the same kind of token but not the same situation: a stored `"oauth"`
   * credential pinned its workspace at login consent, while the refresh-grant
   * path has nothing on disk and re-resolves the workspace on every run. When a
   * call is refused for addressing the wrong workspace, that difference IS the
   * remedy — telling a CI runner to `xanosdk login` is advice it cannot take.
   */
  credentialType: "oauth" | "oauth-refresh" | "token";
  /**
   * Which stored profile produced this, and which rung chose it.
   *
   * `undefined` on the two environment-credential paths: they hold a complete
   * credential with no file and no profile map behind them, so there is no
   * profile to name. Reported rather than inferred — a message that says
   * "profile default" for a CI run using `XANO_META_TOKEN` is a lie about where
   * the credential came from.
   */
  profile?: ProfileSelection;
}

/** Stamp an absolute `expires_at` onto a token-endpoint response. */
function stampExpiry(raw: RawTokens): { access_token: string; refresh_token?: string; scope?: string; expires_at: number } {
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    scope: raw.scope,
    expires_at: Date.now() + (raw.expires_in ?? 0) * 1000,
  };
}

/**
 * Run a refresh-grant exchange for the client that minted the token. The AS
 * ROTATES the refresh token, so the caller MUST persist the returned one. No
 * `resource` is sent — the new token is bound to the instance the refresh token
 * was already minted for (read it back from the token's `aud`).
 */
function refreshAccessToken(
  authHost: string,
  clientId: string,
  refreshToken: string,
  scope: string | undefined,
): Promise<RawTokens> {
  const provider = new OpenIdProvider({ authHost, scope: scope ?? "", clientId });
  return provider.refresh(refreshToken, { scope });
}

/**
 * Is a refresh failure worth retrying?
 *
 * Transient means the authorization server never got to reject anything — a
 * transport-level blip (DNS/connection reset/timeout, a bare `fetch failed`) —
 * so `xanosdk login` is the wrong remedy and re-running usually just works.
 *
 * The test is whether the server ANSWERED, not whether its answer was
 * RFC-shaped. An earlier version keyed only on the RFC `error` field, so a
 * server rejecting a spent refresh token with its own envelope (Xano's dev AS
 * answers `401 {"code":"ERROR_CODE_UNAUTHORIZED","message":"invalid_grant"}`)
 * fell through to "transient" and the CLI advised re-running the deploy
 * forever, for a credential no retry could repair. A 4xx is the server's
 * verdict and is deterministic; a 5xx is the one answered case that may
 * genuinely pass on a retry.
 */
export function isTransientRefreshError(err: unknown): boolean {
  if (oauthErrorCode(err) !== undefined) return false;
  const res = oauthErrorResponse(err);
  if (res === undefined) return true;
  return res.status >= 500 || res.status === 429;
}

/**
 * A refresh that reached no verdict on the credential — no answer, a 5xx, a
 * rate limit — as the failure every other unanswered request is: exit 8, and
 * the server's `status` where it answered, so a caller's unanswered-read
 * classification reads it the way it reads its own request's.
 */
function unansweredRefresh<E extends Error>(failure: E, err: unknown): E {
  const status = oauthErrorResponse(err)?.status;
  return Object.assign(failure, { exitCode: 8 }, status === undefined ? {} : { status });
}

/**
 * Which refresh credential the authorization server refused, or undefined when
 * it refused neither — a transport failure, a 5xx, or a request-shaped error.
 * `"token"` is the refresh token itself (`invalid_grant`: expired, revoked, or
 * spent by an earlier exchange); `"client"` is the client it was exchanged as
 * (`invalid_client`, `unauthorized_client`). Either is a refused credential,
 * coded `SDK_CREDENTIAL_REJECTED` by every path that exchanges one — one
 * classifier, so a new path cannot read the same answer differently.
 */
export async function refusedRefreshCredential(err: unknown): Promise<"token" | "client" | undefined> {
  const code = await resolveOAuthErrorCode(err);
  if (code === "invalid_grant") return "token";
  if (code === "invalid_client" || code === "unauthorized_client") return "client";
  return undefined;
}

/**
 * A refresh failure in words the reader can act on.
 *
 * openid-client reports a non-conformant error response as the bare
 * "unexpected HTTP response status code", which names neither the status nor
 * anything the server said — so when it answered, the status and the server's
 * own message are said in its place.
 */
export async function describeRefreshFailure(err: unknown): Promise<string> {
  // An RFC-shaped error body: openid-client's own message is the bare "server
  // responded with an error in the response body", which says nothing the
  // reader can act on. The server's `error` and `error_description` do.
  const rfc = oauthErrorCode(err);
  if (rfc !== undefined) {
    const { status, error_description: description } = (err ?? {}) as { status?: unknown; error_description?: unknown };
    const said = typeof description === "string" && description.trim() !== "" ? `: ${description.trim()}` : "";
    return `the authorization server answered ${typeof status === "number" ? `HTTP ${status} — ` : ""}${rfc}${said}`;
  }
  // The library's own sentence ("unexpected HTTP response status code") is
  // left out once the server's answer is known: it says nothing that answer does not.
  const answer = await describeRefreshAnswer(err);
  if (answer !== undefined) return `the authorization server answered ${answer}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * What the authorization server ANSWERED — `HTTP 500 — <its message>` — or
 * undefined when it answered nothing (a transport failure). The body goes
 * through the shared formatter, so an HTML error page contributes its
 * `<title>`, never its markup.
 */
export async function describeRefreshAnswer(err: unknown): Promise<string | undefined> {
  const res = oauthErrorResponse(err);
  if (res === undefined) return undefined;
  const parts = [`HTTP ${res.status}`];
  const code = await resolveOAuthErrorCode(err);
  if (code !== undefined) parts.push(code);
  else if (!res.bodyUsed) {
    try {
      const said = serverMessage(await res.clone().text());
      if (said !== undefined) parts.push(said);
    } catch {
      // Nothing readable; the status alone is still more than the bare message.
    }
  }
  return parts.join(" — ");
}

/**
 * Refresh the access token, retrying once on a transient network failure. An
 * OAuth error response is deterministic and never retried — a second attempt
 * would only re-reject. If the retry hits `invalid_grant` (e.g. the first
 * attempt actually rotated the token server-side before the response was lost),
 * the caller's `invalid_grant` branch handles it correctly.
 */
async function refreshWithRetry(
  authHost: string,
  clientId: string,
  refreshToken: string,
  scope: string | undefined,
): Promise<RawTokens> {
  try {
    return await refreshAccessToken(authHost, clientId, refreshToken, scope);
  } catch (err) {
    if (!isTransientRefreshError(err)) throw err;
    // A 5xx is retried too, and it is the server's error, not the network's.
    const status = oauthErrorResponse(err)?.status;
    if (status === 429) {
      // A rate limit is retried after the wait it asks for, when that is short;
      // a longer one ends the run, naming it, as a rate-limited read does.
      const wait = refreshRetryAfter(err) ?? 1;
      if (wait > RATE_LIMIT_MAX_WAIT_S) throw err;
      detail(`The authorization server is rate limiting (HTTP 429); retrying once in ${wait}s…`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return await refreshAccessToken(authHost, clientId, refreshToken, scope);
    }
    detail(
      status === undefined
        ? `Token refresh hit a network error; retrying once…`
        : `The authorization server answered HTTP ${status}; retrying once…`,
    );
    return await refreshAccessToken(authHost, clientId, refreshToken, scope);
  }
}

/** `, even after one retry` — unless a 429 asked for a wait too long to sit out, so none was made. */
function retriedNote(err: unknown): string {
  return oauthErrorResponse(err)?.status === 429 && (refreshRetryAfter(err) ?? 1) > RATE_LIMIT_MAX_WAIT_S
    ? ""
    : ", even after one retry";
}

/** The seconds a rate-limited refresh's `Retry-After` asks for, or undefined. */
function refreshRetryAfter(err: unknown): number | undefined {
  return retryAfterSeconds(oauthErrorResponse(err)?.headers?.get?.("retry-after") ?? null);
}

/**
 * The sentence after "the authorization server answered …" in an unanswered
 * refresh: rate limiting with the wait it asked for on a 429, else a
 * server-side error. `fix` is the remedy that would NOT help.
 */
function unansweredRefreshCause(err: unknown, authHost: string, fix: string): string {
  if (oauthErrorResponse(err)?.status === 429) {
    const wait = refreshRetryAfter(err);
    return (
      `This is rate limiting, not an auth problem — ` +
      `${wait === undefined ? "wait a moment, then re-run the command" : `wait ${wait}s (its Retry-After), then re-run the command`}. ` +
      `${fix} would not help.`
    );
  }
  return (
    `This is a server-side error, not an auth problem — re-run the command. ` +
    `If it persists, ${authHost} is having trouble; ${fix.charAt(0).toLowerCase()}${fix.slice(1)} would not help.`
  );
}

/** The meta credential CI supplies by environment — an `auth.json` with no file. */
export const ENV_INSTANCE = "XANO_INSTANCE_URL";
export const ENV_WORKSPACE = "XANO_WORKSPACE_ID";
export const ENV_META_TOKEN = "XANO_META_TOKEN";

/**
 * The `(instance, workspace, meta token)` triple, read from the environment.
 *
 * `undefined` when NONE of the three is set — the only reading of "not
 * configured". A PARTIAL triple throws instead of falling through, because the
 * fallthrough is the dangerous outcome: a workflow with one typo'd secret name
 * would silently authenticate as whatever credential happens to be on the
 * runner and, on `release`, write to the wrong workspace.
 */
export function readEnvMetaCredential(): TokenCredential | undefined {
  const instance = readEnvVar(ENV_INSTANCE);
  const workspace = readEnvVar(ENV_WORKSPACE);
  const token = readEnvVar(ENV_META_TOKEN);

  if (instance === undefined && workspace === undefined && token === undefined) return undefined;

  const missing = [
    instance === undefined ? ENV_INSTANCE : undefined,
    workspace === undefined ? ENV_WORKSPACE : undefined,
    token === undefined ? ENV_META_TOKEN : undefined,
  ].filter((n): n is string => n !== undefined);
  if (missing.length > 0) {
    const set = [ENV_INSTANCE, ENV_WORKSPACE, ENV_META_TOKEN].filter((n) => !missing.includes(n));
    throw new UsageError(
      `Incomplete meta credential in the environment: ${set.join(", ")} ${set.length === 1 ? "is" : "are"} set ` +
        `but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not. All three are required — ` +
        `check for a misspelled secret name, or unset the rest to use a different credential.`,
    );
  }

  try {
    return buildTokenCredential(
      {
        instance,
        // Parsed here, not in the validator: pass the ORIGINAL string through on a
        // bad parse so the rejection quotes what was actually set, not `NaN`.
        workspaceId: isSafeIdText(workspace!) ? Number(workspace!.trim()) : workspace,
        token,
      },
      {
        at: "in the environment",
        labels: { instance: ENV_INSTANCE, workspace: ENV_WORKSPACE, token: ENV_META_TOKEN },
      },
    );
  } catch (err) {
    // A value the caller set, fixed by setting it again — usage, whichever of the three it is.
    throw err instanceof UsageError ? err : new UsageError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Which of the three env vars are actually set — empty when none is.
 *
 * A NON-EMPTY result is the condition under which a file credential stops being
 * used: a complete triple wins, and an incomplete one is a hard error. Either
 * way the file is not what the next command acts on. Reporting names the ones
 * that are really set rather than a stand-in, so a lone misspelled secret is
 * visible in the message itself.
 *
 * Deliberately NEVER throws, unlike {@link readEnvMetaCredential} — its one
 * caller is `login`, reporting AFTER the credential is already on disk, and a
 * throw there would abandon the rest of that command's cleanup.
 */
export function envMetaCredentialVarsSet(): string[] {
  return [ENV_INSTANCE, ENV_WORKSPACE, ENV_META_TOKEN].filter(
    (name) => readEnvVar(name) !== undefined,
  );
}

/**
 * Every environment credential variable that outranks a stored profile — the
 * meta-token triple and XANO_REFRESH_TOKEN — and whether what is set would
 * actually authenticate. Never throws, for the reason
 * {@link envMetaCredentialVarsSet} does not: `login` and `logout` report it after
 * their write.
 *
 * `complete` mirrors {@link getAccessToken}'s arms: a full triple wins; with no
 * triple at all, a refresh token wins when XANO_CLIENT_ID is set beside it. Any
 * other non-empty set makes every command FAIL rather than fall back to a stored
 * profile — still outranking it, which is what `login` and `logout` have to say.
 * XANO_CLIENT_ID is never listed on its own: it authenticates nothing.
 */
export function environmentCredentialVars(): { vars: string[]; complete: boolean } {
  const meta = envMetaCredentialVarsSet();
  const refresh = readEnvVar("XANO_REFRESH_TOKEN") !== undefined;
  const clientId = readEnvVar("XANO_CLIENT_ID") !== undefined;
  const vars = refresh ? [...meta, "XANO_REFRESH_TOKEN"] : [...meta];
  const complete = meta.length === 3 || (meta.length === 0 && refresh && clientId);
  return { vars, complete };
}

/**
 * Say what the env triple displaced. Silently winning over a credential the
 * caller also pointed at is the same invisible-wrong-target hazard
 * {@link warnIfLocalShadowsGlobal} guards — an FYI, not a warning, because
 * every CI run would otherwise print a scary line for the intended setup.
 */
function noteDisplacedCredentials(args: ParsedArgs, variable: string): void {
  const configPath = expandHome(args.authFile) ?? readPathEnvVar("XANO_CONFIG");
  // Only a file that exists was displaced: naming a path with nothing at it
  // read as a credential this run chose not to use.
  if (configPath !== undefined && existsSync(configPath)) {
    // `release transfer --to-profile` still reads its destination from the
    // file, so "ignoring" it was false there (E2E pass 23).
    info(
      args.toProfile !== undefined
        ? `Using the ${variable} credential from the environment for this run's sign-in — \`--to-profile\` still reads ${configPath}.`
        : `Using the ${variable} credential from the environment — ignoring ${configPath}.`,
    );
  }
  if (variable !== "XANO_REFRESH_TOKEN" && readEnvVar("XANO_REFRESH_TOKEN") !== undefined) {
    info(`Using the ${variable} credential from the environment — ignoring XANO_REFRESH_TOKEN.`);
  }
  // `$XANO_PROFILE` joins the same list rather than reporting separately: one
  // environment credential displaces one set of things, and a run that named
  // only the profile while staying silent about a displaced `--config` told
  // half the story.
  const profile = readEnvVar(ENV_PROFILE);
  if (profile !== undefined) {
    info(`Using the ${variable} credential from the environment — ignoring ${ENV_PROFILE}=${profile.trim()}.`);
  }
  // The project's PIN joins the same list, and it is the member of it that
  // matters most: the env arms hold a complete credential with no profile map
  // behind them, so a pin cannot be honoured here — there is nothing for it to
  // select. It is therefore DISCLOSED rather than compared: this path knows
  // which credential it holds, and nothing about which target the pinned
  // profile would have addressed. Naming it is what lets a reader see, in the
  // run's first lines, that the repository asked for something else.
  const pin = pinnedProfile();
  if (pin !== undefined) {
    const message =
      `Using the ${variable} credential from the environment — ignoring ${pin.path}, ` +
      `which pins this project to profile "${pin.profile}".`;
    info(message);
    // A `--json` reader sees no stderr, and its document says `"profile": null`
    // — without this entry it cannot tell the pin was set aside.
    noteRunWarning("credential.env-overrides-pin", message);
  }
}

/**
 * The project's pin, or `undefined` — and never a throw.
 *
 * {@link findProjectPointer} rejects a malformed or token-bearing pointer, which
 * is right where the pointer is about to be ACTED on. Here it is only being
 * mentioned, on paths that resolved their credential without it, and a CI job
 * holding a complete environment credential must not start failing over a file
 * it no longer reads. A disclosure that cannot be made is simply not made.
 */
function pinnedProfile(): ProjectPin | undefined {
  try {
    return findProjectPointer(process.cwd());
  } catch {
    return undefined;
  }
}

/**
 * The profile this run would act as, the file it would be read from, and its
 * kind — read without refreshing, warning or throwing, only to word a refusal
 * about it. `kind` is `"none"` when nothing is stored under that name (or the
 * file is absent); undefined when the file cannot be read at all.
 */
function storedProfile(
  args: ParsedArgs,
): { name: string; path: string; kind: "oauth" | "token" | "none" | "unknown" } | undefined {
  try {
    const path = resolveAuthFilePath(args);
    const file = readCredentialFile(path);
    // The bare ladder, not `resolveProfile`: that one discloses overrides, and
    // this read is for wording a refusal, not for acting.
    const selection = resolveActiveProfile({
      flag: args.profile,
      fileDefault: file?.default,
      readPointer: () => findProjectPointer(process.cwd())?.profile,
    });
    const raw = file?.profiles[selection.name] as { type?: unknown } | undefined;
    const kind = raw === undefined ? "none" : raw.type === "token" || raw.type === "oauth" ? raw.type : "unknown";
    return { name: selection.name, path, kind };
  } catch {
    return undefined;
  }
}

/**
 * Refuse `--origin` on a run that exchanges no refresh token at a host it
 * chooses — see {@link getAccessToken}. Worded by what the run DOES use, with a
 * remedy that signs the same profile, into the same file, through the typed
 * host — a bare `xanosdk login --origin <url> --force` wrote the shared file.
 */
function refuseUnusedOrigin(args: ParsedArgs, envMeta: TokenCredential | undefined): never {
  const typed = args.authHost!;
  // A secret in the value is refused before anything quotes it.
  try {
    assertNoUserinfo(typed, "`--origin`");
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const lead =
    "`--origin` selects the OAuth host a sign-in (`login`) goes to and the one XANO_REFRESH_TOKEN is exchanged at, " +
    "and this run does neither: ";
  if (envMeta !== undefined) {
    throw new UsageError(`${lead}it uses XANO_META_TOKEN, which never refreshes. Drop \`--origin\`.`);
  }
  const stored = storedProfile(args);
  // A meta API token profile has no sign-in server at all, so "refreshes at
  // the one recorded with it" described a credential it is not.
  if (stored?.kind === "token") {
    throw new UsageError(
      `${lead}it uses a stored meta API token profile, which has no sign-in server and never refreshes. ` +
        `Drop \`--origin\`.`,
    );
  }
  const name = stored?.name ?? DEFAULT_PROFILE;
  const target = { path: stored?.path, origin: typed };
  // The remedies below run `login --origin <typed>`, which refuses what its
  // own check refuses — so a value it would refuse is never echoed into one.
  // The reason is said instead: the reader learns both halves at once.
  let unusable: string | undefined;
  try {
    assertSignInOrigin(typed, "`--origin`");
  } catch (err) {
    unusable = err instanceof Error ? err.message : String(err);
  }
  // Nothing stored under that name: no profile's sign-in server is being
  // ignored — the run has no credential at all, and a sign-in through the typed
  // host is what would give it one. No `--force`: there is nothing to replace.
  if (stored?.kind === "none") {
    throw new UsageError(
      `${lead}no XANO_REFRESH_TOKEN is set, and no profile "${name}" is stored in ${stored.path}. ` +
        (unusable === undefined
          ? `Drop \`--origin\`, or sign in through that server with \`${loginCommand(name, target)}\`.`
          : `Drop \`--origin\` — it could not be a sign-in server either: ${unusable}`),
    );
  }
  throw new UsageError(
    `${lead}it uses a stored profile, which refreshes at the sign-in server recorded with it. ` +
      (unusable === undefined
        ? `Drop \`--origin\`; to change that profile's sign-in server, run \`${loginCommand(name, target, ["--force"])}\`.`
        : `Drop \`--origin\` — it could not be that profile's sign-in server either: ${unusable}`),
  );
}

/**
 * Resolve a bearer token and the target it authorizes against. The instance and
 * workspace always come from the credential — chosen at consent during `login`,
 * hand-authored in a `"token"` record, or set as the environment triple. Never a
 * flag: a token on a command line lands in the process list and the run log.
 *
 * Four paths, highest precedence first:
 *   • CI (`XANO_INSTANCE_URL` + `XANO_WORKSPACE_ID` + `XANO_META_TOKEN`) — a
 *     complete credential already. No disk I/O, no network, and nothing to
 *     rotate, which is what makes it the one that survives repeated CI runs.
 *   • CI (`XANO_REFRESH_TOKEN`) — exchange it; the instance is read back from
 *     the fresh token's `aud` and the workspace resolved from the meta API,
 *     since there is no stored record to read either from. No disk I/O.
 *     ⚠ Refresh tokens ROTATE on use, so a stored one is spent by its first
 *     exchange — prefer the triple above for a job that runs more than once.
 *   • `"oauth"` credential — refresh + persist the rotated refresh token when
 *     the cached access token is stale; the workspace was pinned at login.
 *   • `"token"` credential — everything is already on disk. No refresh, no
 *     network call, no write.
 */
export async function getAccessToken(args: ParsedArgs): Promise<ResolvedAuth> {
  const auth = await resolveAccessToken(args);
  registerSecret(auth.access_token);
  // Kept for the CLI's 401 remedy, which names where this credential came from.
  noteResolvedAuth(auth, args);
  return auth;
}

async function resolveAccessToken(args: ParsedArgs): Promise<ResolvedAuth> {
  const envMeta = readEnvMetaCredential();
  // `--origin` picks the OAuth host a refresh token is exchanged at. Only the
  // XANO_REFRESH_TOKEN arm exchanges one against a host the run chooses; a
  // stored profile refreshes at the host recorded with it and a meta API token
  // never refreshes. Accepted and ignored there, `--origin http://evil.example`
  // read as a setting that took effect.
  if (args.authHost !== undefined && (envMeta !== undefined || readEnvVar("XANO_REFRESH_TOKEN") === undefined)) {
    refuseUnusedOrigin(args, envMeta);
  }
  if (envMeta) {
    assertHttpsOrigin(envMeta.instance_base_url, ENV_INSTANCE);
    refuseProfileDisplacedByEnv(args, ENV_META_TOKEN);
    noteDisplacedCredentials(args, ENV_META_TOKEN);
    return {
      access_token: envMeta.meta_api_token,
      instance: envMeta.instance_base_url,
      workspaceId: envMeta.workspace_id,
      credentialType: "token",
    };
  }

  const envRefresh = readEnvVar("XANO_REFRESH_TOKEN");

  if (envRefresh) {
    registerSecret(envRefresh);
    const malformed = tokenTextProblem(envRefresh.trim());
    if (malformed !== undefined) {
      // Named by position, never quoted: the value is a secret.
      throw new UsageError(
        `XANO_REFRESH_TOKEN ${malformed}, which no request can carry. Set it to the refresh token alone — one line, nothing else.`,
      );
    }
    refuseProfileDisplacedByEnv(args, "XANO_REFRESH_TOKEN");
    noteDisplacedCredentials(args, "XANO_REFRESH_TOKEN");
    const authHost = resolveAuthHost(args);
    try {
      assertSignInOrigin(authHost, args.authHost === undefined ? "XANO_ORIGIN" : "--origin");
    } catch (err) {
      // A value the caller set is fixed by retyping it — `SDK_USAGE`, as `login`
      // reports the same value.
      throw new UsageError(err instanceof Error ? err.message : String(err));
    }
    const clientId = readEnvVar("XANO_CLIENT_ID");
    if (!clientId) {
      // Named where a sign-in really wrote one — an OAuth profile actually
      // stored, in the file this run resolved, the shared file or the
      // project's — and only then: a file of
      // meta-token profiles holds no client id to copy.
      const searched = oauthSearchPaths(args);
      const stored = storedOAuthProfiles(searched);
      // An incomplete environment credential is fixed by setting a variable — `SDK_USAGE`.
      throw new UsageError(
        `XANO_REFRESH_TOKEN is set but XANO_CLIENT_ID is not. A refresh token can only be ` +
          `exchanged by the client that minted it` +
          (stored.length > 0
            ? ` — copy both values from the OAuth profile it came from (${stored.join("; ")}): ` +
              `its "refresh_token" and "client_id" fields.`
            : `, and no OAuth profile is stored here to copy one from (${searched.join(", ")}). Set XANO_CLIENT_ID to the "client_id" stored beside that refresh token ` +
              `where \`xanosdk login\` wrote it — or run \`xanosdk login\` to sign in and store a pair.`),
      );
    }
    let set: RawTokens;
    try {
      // The same one retry the stored-profile path gets, for the same reason: a
      // network blip or a 5xx never reached a verdict on the token.
      set = await refreshWithRetry(authHost, clientId, envRefresh, resolveScope(args));
    } catch (err) {
      // A transport failure or a 5xx is not the token's fault — blaming a spent
      // token sends the reader to mint a new one for a server that is down.
      if (isTransientRefreshError(err)) {
        const answer = await describeRefreshAnswer(err);
        const message = await describeRefreshFailure(err);
        throw unansweredRefresh(new Error(
          answer === undefined
            ? `XANO_REFRESH_TOKEN exchange could not reach the authorization server (${message}), even after one retry. ` +
                `This is a transient network error, not an auth problem — re-run the command. ` +
                `If it persists, check connectivity to ${authHost}.`
            : `XANO_REFRESH_TOKEN exchange failed: the authorization server answered ${answer}${retriedNote(err)}. ` +
                unansweredRefreshCause(err, authHost, "Minting a new refresh token"),
        ), err);
      }
      const failure = `XANO_REFRESH_TOKEN exchange failed: ${await describeRefreshFailure(err)}`;
      const mint = loginCommand(DEFAULT_PROFILE, { origin: authHost }, ["--force"]);
      const refused = await refusedRefreshCredential(err);
      // The fix is a variable, not a stored profile: no `signIn` command, and
      // no instance or workspace — both are read from a token never minted.
      const rejected = (message: string): Error =>
        credentialRejected(new Error(message), {
          profile: null,
          credentialType: "oauth-refresh",
          instance: null,
          workspaceId: null,
          signIn: null,
        });
      if (refused === "client") {
        throw rejected(
          `${failure}\n` +
            `XANO_CLIENT_ID is not a client the authorization server accepts for XANO_REFRESH_TOKEN — set both ` +
            `from the same OAuth profile (its "client_id" and "refresh_token" fields), or unset both to use a ` +
            `stored profile.`,
        );
      }
      const message =
        `${failure}\n` +
        `The refresh token may be expired or already spent — refresh tokens rotate on use, so a ` +
        `single stored value is consumed on first exchange. Replace XANO_REFRESH_TOKEN (with the XANO_CLIENT_ID ` +
        `stored beside it), or unset both to use a stored profile. Mint a fresh one via \`${mint}\`.`;
      throw refused === "token" ? rejected(message) : new Error(message);
    }
    // The target instance is whatever the refresh token is bound to.
    const instance = decodeAudience(set.access_token);
    if (!instance) {
      throw new Error(
        `Could not determine the target instance from the token minted by XANO_REFRESH_TOKEN ` +
          `(no readable \`aud\` claim). Mint a fresh refresh token via ` +
          `\`${loginCommand(DEFAULT_PROFILE, { origin: authHost }, ["--force"])}\`.`,
      );
    }
    assertHttpsOrigin(instance, "instance");
    // No stored record on this path, so the workspace must be resolved live.
    const { resolveScopedWorkspaceId } = await import("../deploy/workspace.js");
    const workspaceId = await resolveScopedWorkspaceId({ access_token: set.access_token, instance });
    return { access_token: set.access_token, instance, workspaceId, credentialType: "oauth-refresh" };
  }

  const authFilePath = resolveAuthFilePath(args);
  const file = readCredentialFile(authFilePath);
  const { selection, pin } = resolveProfile(args, file, authFilePath);
  const saved = file === null ? null : readProfile(file, selection.name, authFilePath);
  if (!saved) {
    throw notSignedIn(authFilePath, file, selection, args.authHost ?? envOrigin(), pin);
  }
  warnIfReadableByOthers(authFilePath);
  warnIfLocalShadowsGlobal(args, authFilePath, saved, selection);
  await warnIfUnpinnedMachineDefault(file, selection, pin, saved, authFilePath);
  return fromStoredProfile(authFilePath, selection, saved);
}

/**
 * Resolve a SECOND credential, named on the command line, beside the one the
 * run acts as — the destination of a command that reads from one workspace and
 * writes to another. `flag` is the flag that named it, and every message this
 * produces says that flag rather than `--profile`.
 *
 * It is the file-profile half of {@link getAccessToken} without the selection
 * ladder, and each thing it leaves out is left out on purpose:
 *
 * - **No environment displacement.** The env credentials replace the ACTIVE
 *   credential and nothing else; they hold no profile map, so they have no
 *   opinion about which stored profile a destination is. A CI job whose source
 *   is `XANO_META_TOKEN` can still name a stored destination, and the
 *   `--profile`-versus-env refusal stays the source's to raise.
 * - **No pin, no `$XANO_PROFILE`.** Those answer "which profile is this project
 *   acting as", and the typed name has already answered "which one receives
 *   this". Reporting that it "overrides the pin" would read as a retarget of
 *   the source. The pointer file is not even read, so a broken one cannot
 *   break a destination that never consulted it.
 * - **No unpinned-default warning.** Nothing was defaulted: the reader typed it.
 *
 * What it keeps: the credential FILE ladder (`--config`, `--local`), the same
 * name validation `--profile` gets, the local-shadows-global warning (a
 * shadowed destination is the same wrong-target hazard), and the locked,
 * one-profile refresh — a stale destination rotates its own refresh token and
 * no other profile's.
 *
 * A name that does not validate is a {@link UsageError}. A valid name that is
 * not stored is a {@link ProfileNotFoundError} (exit 8), as a missing
 * `--profile` is: the command was typed correctly and the stored state said no.
 */
export async function resolveNamedProfile(
  name: string,
  args: ParsedArgs,
  flag = "--to-profile",
): Promise<ResolvedAuth> {
  try {
    assertValidProfileName(name, flag);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const selection: ProfileSelection = { name, source: "flag", flag };
  const authFilePath = resolveAuthFilePath(args);
  const file = readCredentialFile(authFilePath);
  const saved = file === null ? null : readProfile(file, name, authFilePath);
  if (!saved) {
    const available = file === null ? [] : profileNames(file);
    const have =
      available.length === 0
        ? `Nothing is signed in there.`
        : `Stored profiles there: ${quotedNames(available)}.`;
    throw new ProfileNotFoundError(
      `\`${flag} ${name}\` names no stored credential profile in ${authFilePath}. ${have} ` +
        `Run ${addProfileHint(name, { path: authFilePath })} to add it.`,
    );
  }
  warnIfReadableByOthers(authFilePath);
  warnIfLocalShadowsGlobal(args, authFilePath, saved, selection);
  return fromStoredProfile(authFilePath, selection, saved);
}

/**
 * A stored profile's record, turned into a usable bearer — the tail both
 * resolvers share once they know WHICH profile.
 */
async function fromStoredProfile(
  authFilePath: string,
  selection: ProfileSelection,
  saved: CredentialRecord,
): Promise<ResolvedAuth> {
  // A hand-authored meta-API token is already complete: it never expires from
  // our point of view, never refreshes, and is never written back.
  if (saved.type === "token") {
    assertHttpsOrigin(saved.instance_base_url, "instance_base_url");
    return {
      access_token: saved.meta_api_token,
      instance: saved.instance_base_url,
      workspaceId: saved.workspace_id,
      credentialType: "token",
      profile: selection,
    };
  }

  const instance = saved.instance;
  assertStoredInstance(instance, authFilePath, selection);

  if (Date.now() < saved.expires_at - EXPIRY_SKEW_MS) {
    return {
      access_token: saved.access_token,
      instance,
      workspaceId: saved.workspace_id,
      credentialType: "oauth",
      profile: selection,
    };
  }

  return refreshUnderLock(authFilePath, selection, saved);
}

/**
 * An OAuth record's instance, refused unless it is https (or loopback http) —
 * the bearer is about to be sent there. Refused as a {@link StoredCredentialError}
 * naming the profile, the file and `login --force`, the way a refused
 * `auth_host` is, so `status` can report which credential and its fix instead
 * of a bare "instance must use https://". (A `"token"` record's instance is
 * already refused, naming its file and profile, when the file is parsed.)
 */
function assertStoredInstance(instance: string, authFilePath: string, selection: ProfileSelection): void {
  try {
    assertHttpsOrigin(instance, `The instance stored for profile "${selection.name}" in ${authFilePath}`);
  } catch (err) {
    const fix = loginCommand(selection.name, { path: authFilePath }, ["--force"]);
    throw new StoredCredentialError(
      `${err instanceof Error ? err.message : String(err)} Nothing was sent. ` +
        `Run \`${fix}\` to sign in again and replace the record.`,
      selection,
      instance,
      fix,
      { cause: err },
    );
  }
}

/**
 * Which profile this run acts as, resolving the rungs in one place — and whether
 * the project carries a pin at all, which the rung alone cannot say (a pin that
 * LOST to `--profile` still exists, and still has to be disclosed).
 *
 * The pointer file is read HERE rather than in the parser because it is a
 * filesystem lookup. It is read on every run that did not type `--profile`,
 * because it now outranks `$XANO_PROFILE`; the one walk is memoised so the
 * flag-override disclosure below cannot pay for a second one.
 */
function resolveProfile(
  args: ParsedArgs,
  file: CredentialFile | null,
  path: string,
): { selection: ProfileSelection; pin?: ProjectPin } {
  let pin: ProjectPin | undefined;
  let walked = false;
  const readPin = (): ProjectPin | undefined => {
    if (!walked) {
      walked = true;
      pin = findProjectPointer(process.cwd());
    }
    return pin;
  };
  const selection = resolveActiveProfile({
    flag: args.profile,
    fileDefault: file?.default,
    defaultIn: path === globalAuthFilePath() ? undefined : path,
    readPointer: () => readPin()?.profile,
  });
  if (selection.source === "flag") {
    // The flag is the ONE rung left above the pin, so it is not refused — it is
    // disclosed. A refusal would leave a pinned project with no way to reach
    // another target from the command line at all, and "you may not do that"
    // over a target the reader typed is worse than "here is what you overrode".
    //
    // NON-FATAL here, unlike every rung where the pointer decides. A malformed
    // or token-bearing pointer throws when it is read, and on this path it is
    // read only to describe what the flag overrode — so letting it throw would
    // break `--profile`, which is precisely the escape hatch someone reaches for
    // when the pointer is the broken thing. The refusal still fires on every
    // path where the pin is what selects the credential.
    let overridden: ProjectPin | undefined;
    try {
      overridden = readPin();
    } catch {
      overridden = undefined;
    }
    if (overridden !== undefined && overridden.profile !== selection.name) {
      info(
        `\`--profile ${selection.name}\` overrides ${overridden.path}, ` +
          `which pins this project to profile "${overridden.profile}".`,
      );
    }
  } else if (selection.source === "pointer") {
    // The symmetric disclosure, one rung down. The pin outranking a shell's
    // `$XANO_PROFILE` is the safety property this change exists for, but a
    // retarget nobody is told about is the same silence the whole feature was
    // written against — and this one lands on CI, where the variable was set
    // once and the pointer arrived later with a clone. Only when they disagree:
    // a pin and an env naming the same profile is not an override.
    const env = readEnvVar(ENV_PROFILE)?.trim();
    if (env !== undefined && env !== selection.name && pin !== undefined) {
      info(
        `${pin.path} pins this project to profile "${selection.name}" — ` +
          `ignoring ${ENV_PROFILE}=${env}.`,
      );
    }
  }
  return { selection, pin };
}

/**
 * The hazard is not a wrong answer, it is an UNREMARKED one: a project that
 * never said which backend it belongs to, resolving through whichever profile
 * the last `login` left as this machine's default, on a machine that holds
 * several. The write goes somewhere plausible and nothing in the terminal says
 * where.
 *
 * Gated on all three parts of that, so the common setups stay silent: no pin
 * (a pinned project has already answered), a MACHINE-LEVEL default rung (a flag,
 * a pin or `$XANO_PROFILE` means something named this profile), and more than
 * one profile stored (with one, there is no other target to have meant). And
 * only inside a project: outside one there is nothing to pin.
 *
 * It lives here, next to {@link warnIfLocalShadowsGlobal}, rather than in the
 * selection grammar: the requirement is to name the resolved INSTANCE and
 * WORKSPACE, and those are properties of the credential that was read, not of
 * the name that selected it. The grammar stays filesystem-free and target-free.
 */
async function warnIfUnpinnedMachineDefault(
  file: CredentialFile | null,
  selection: ProfileSelection,
  pin: ProjectPin | undefined,
  saved: CredentialRecord,
  path: string,
): Promise<void> {
  if (pin !== undefined) return;
  if (selection.source !== "file-default" && selection.source !== "implicit") return;
  const stored = file === null ? [] : profileNames(file);
  if (stored.length < 2) return;
  // A command run outside any project (`generate` from a scratch directory, a
  // directory holding only a package.json) has no project to pin, so "this
  // project has no xano.profile.json" is wrong — by the detection `status`
  // uses for "No Xano SDK project here", so the two never disagree.
  const { projectDirFrom } = await import("../emit/xanosdk-project.js");
  if (projectDirFrom(process.cwd()) === undefined) return;

  const target = targetOf(saved);
  credentialWarning(
    "credential.unpinned-profile",
    `This project has no ${POINTER_FILE}, so this run acts as ` +
      `${describeProfileSelection(selection)} — ${hostLabel(target.instance)}, ` +
      `workspace ${target.workspaceId}. ${stored.length} profiles are stored on this machine.`,
    `Run \`xanosdk profile use ${selection.name}${credentialFileFlag(path)}\` to pin this project to that profile, ` +
      `or name another with \`--profile\`.`,
  );
}

/** Credential files already warned about this process: said once, however many reads. */
const warnedReadable = new Set<string>();

/**
 * A credential file other users of this machine can read is used — refusing
 * would strand a working setup over a mode bit — but said, once, with the one
 * command that fixes it. Every file this tool writes is 0600; one that is not
 * was copied or written by hand.
 */
export function warnIfReadableByOthers(path: string): void {
  if (process.platform === "win32" || warnedReadable.has(path)) return;
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return;
  }
  if ((mode & 0o077) === 0) return;
  warnedReadable.add(path);
  credentialWarning(
    "credential.readable-file",
    `${path} can be read by other users of this machine, and it holds your Xano credentials.`,
    `Run \`chmod 600 ${shellQuote(path)}\` to make it readable by you alone.`,
  );
}

/**
 * A warning credential resolution prints (`!`, with its remedy as a detail
 * line) — also recorded, whole and under `code`, for every `--json` document
 * the run writes, so its `warnings[]` carries what stderr said.
 */
export function credentialWarning(code: WarningCode, message: string, remedy?: string): void {
  warn(message, code, remedy === undefined ? [] : [remedy]);
}

/**
 * An explicit `--profile` cannot be quietly displaced by an environment
 * credential; `$XANO_PROFILE` can.
 *
 * The env paths hold a complete credential with no profile map behind them, so
 * a profile selection there is not "overridden", it is IMPOSSIBLE. The flag is
 * a typed instruction and acting on a different tenant while it sits on the
 * command line is exactly the failure `readEnvMetaCredential`'s hard error on a
 * partial triple already exists to prevent. `$XANO_PROFILE` is commonly
 * inherited from a shell rc, so erroring on it would break CI for people who
 * set it once — it is displaced with an info line, like `--config`.
 */
function refuseProfileDisplacedByEnv(args: ParsedArgs, variable: string): void {
  if (args.profile !== undefined) {
    // A UsageError, not a plain one: the command line and the environment
    // contradict each other, and `status` — which reports every OTHER
    // credential failure as "not signed in" rather than throwing — must not
    // turn a flag it cannot honour into a report that nothing is signed in.
    // The remedy names EVERY credential variable that is set: unsetting only
    // the token left the instance and workspace behind, and the next run failed
    // on an incomplete triple instead of reaching the profile.
    const { vars } = environmentCredentialVars();
    // A profile that is not stored either: unsetting the environment would
    // only trade this refusal for "no such profile" (exit 8) — so that is the
    // answer now, with the command that adds it.
    const authFilePath = resolveAuthFilePath(args, "read");
    let file: CredentialFile | null = null;
    try {
      file = readCredentialFile(authFilePath);
    } catch {
      // Unreadable: the refusal below still names the contradiction.
    }
    const stored = file === null ? [] : profileNames(file);
    if (!stored.includes(args.profile)) {
      const have =
        stored.length === 0 ? `Nothing is signed in there.` : `Stored profiles there: ${quotedNames(stored)}.`;
      throw new ProfileNotFoundError(
        `\`--profile ${args.profile}\` names no stored credential profile in ${authFilePath}. ${have} ` +
          `Run ${addProfileHint(args.profile, { path: authFilePath })} to add it — and \`unset ${vars.join(" ")}\` ` +
          `to act as it, since ${variable} in this environment outranks the credential file.`,
      );
    }
    throw new UsageError(
      `\`--profile ${args.profile}\` selects a stored credential, but ${variable} is set in this ` +
        `environment and outranks the credential file — there is no profile for it to select. ` +
        `Run \`unset ${vars.join(" ")}\` to act as profile "${args.profile}", or drop \`--profile\` to use the ` +
        `environment credential.`,
    );
  }
}

/**
 * `profile "p" in <file>` for each OAuth profile stored in the credential file
 * this run resolved (`--config`, `$XANO_CONFIG`, `--local`), the shared file or
 * this project's — the places a sign-in writes a refresh token and its client
 * id. Advice only: an unreadable file lists nothing.
 */
function storedOAuthProfiles(paths: readonly string[]): string[] {
  const found: string[] = [];
  for (const path of [...new Set(paths)]) {
    try {
      const file = readCredentialFile(path);
      if (file === null) continue;
      for (const name of profileNames(file)) {
        if ((file.profiles[name] as { type?: unknown } | null)?.type === "oauth") found.push(`profile "${name}" in ${path}`);
      }
    } catch {
      // Unreadable: nothing to point at.
    }
  }
  return found;
}

/**
 * Where a refresh token's client id may be stored: the file this run resolved
 * first — the one the "ignoring" line names — then the two default files.
 */
function oauthSearchPaths(args: ParsedArgs): string[] {
  let resolved: string | undefined;
  try {
    resolved = resolveAuthFilePath(args);
  } catch {
    // A contradiction in the flags: the default files are still worth naming.
  }
  return [...new Set([...(resolved !== undefined ? [resolved] : []), globalAuthFilePath(), localAuthFilePath()])];
}

/**
 * No credential is stored for the selection: nobody has signed in, or not as
 * this profile.
 *
 * Its own class because absence is the one credential failure a caller may
 * read as an answer. The tracked-backend fallback skips the ephemeral check on
 * it; a refresh that failed, an incomplete environment credential, or an
 * unreadable token is a credential that EXISTS and did not work, and has to
 * reach the user with its own fix rather than silently change which backend a
 * bare command lands on.
 */
export class NotSignedInError extends Error {
  override readonly name: string = "NotSignedInError";
  /**
   * The profile that was asked for by NAME and is not stored — set when other
   * profiles are, or when a flag, `$XANO_PROFILE` or a pin named it, so the
   * absence is a wrong name rather than a machine nobody has signed in on
   * without choosing anything. `status` reads it to refuse rather than answer
   * "not signed in" about a profile someone (or a pointer) chose.
   */
  readonly missingProfile?: ProfileSelection;
  /**
   * The profiles the file DOES hold — empty on a machine nobody signed in on.
   * `status` reads it to name `profile set-default` rather than `login` when
   * only the default is missing.
   */
  readonly storedProfiles: readonly string[];

  constructor(message: string, missingProfile?: ProfileSelection, storedProfiles: readonly string[] = []) {
    super(message);
    if (missingProfile !== undefined) this.missingProfile = missingProfile;
    this.storedProfiles = storedProfiles;
  }
}

/**
 * A profile named — by `-p`, `$XANO_PROFILE`, a project pin, the file's own
 * default, or a `profile` verb — that is not stored: the not-found failure,
 * exit 8 like every other named thing that is not there (`release show`,
 * `tenant get`). Not a usage error: the command was typed correctly and the
 * stored state said no. Still a {@link NotSignedInError}, because to a
 * resolver it is the same absence.
 */
export class ProfileNotFoundError extends NotSignedInError {
  override readonly name: string = "ProfileNotFoundError";
  readonly exitCode = EXIT_SOURCE_UNRESOLVABLE;
}

/**
 * A stored profile EXISTS and could not be turned into a bearer: its refresh
 * failed, or its record is refused before anything is sent. Unlike
 * {@link NotSignedInError} it is not an absence, and each variant has its own
 * fix — a retry for a refresh the server never answered, `login --force` for a
 * record that must be replaced — so it carries which profile, which instance,
 * and the one command that fixes it. `status` reports all three rather than
 * collapsing every variant into "run `xanosdk login`".
 */
export class StoredCredentialError extends Error {
  override readonly name = "StoredCredentialError";
  constructor(
    message: string,
    readonly profile: ProfileSelection,
    readonly instance: string,
    /** The command that fixes it, or null when the fix is re-running the same command. */
    readonly fix: string | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * The facts of a credential the instance (or its sign-in server) refused — the
 * `details` of the `--json` failure coded `SDK_CREDENTIAL_REJECTED`. `profile`
 * is null for an environment credential, and `signIn` is null where the fix is
 * a variable or an upgrade rather than a command.
 */
export interface RejectedCredential {
  profile: string | null;
  credentialType: ResolvedAuth["credentialType"];
  /** Null where the credential never named one: a refused `XANO_REFRESH_TOKEN`. */
  instance: string | null;
  workspaceId: number | null;
  signIn: string | null;
}

/**
 * Tag `err` as a refused credential, so a caller branches on the code rather
 * than matching `401` and "rejected" in the prose. Set by shape: this layer
 * does not import the CLI's error types, which read `code` the same way.
 */
export function credentialRejected<E extends Error>(err: E, details: RejectedCredential): E {
  return Object.assign(err, { code: "SDK_CREDENTIAL_REJECTED", details });
}

/**
 * The instance and workspace a pinned profile last deployed to, read from the
 * project's tracked ephemerals (keyed `"<profile>/<host>/<workspace>"`) — empty
 * when none, or several, are recorded under it. The profile itself is gone, so
 * this is the one place left that knows where it pointed.
 */
function recordedTargetFor(pin: ProjectPin | undefined, name: string): { instance?: string; workspaceId?: string } {
  if (pin === undefined) return {};
  const keyed = Object.entries(readEphemeralState(dirname(pin.path)).environments).filter(
    ([key]) => key.startsWith(`${name}/`) && key.split("/").length >= 3,
  );
  const targets = new Map(
    keyed.map(([key, record]) => {
      const instance = record.instance ?? `https://${key.split("/").slice(1, -1).join("/")}`;
      const workspaceId = key.slice(key.lastIndexOf("/") + 1);
      return [`${instance} ${workspaceId}`, { instance, workspaceId }] as const;
    }),
  );
  return targets.size === 1 ? [...targets.values()][0]! : {};
}

/**
 * "Not signed in" has three readings, and they need three different remedies.
 *
 * An EMPTY file is someone who has never signed in. A file with profiles but
 * not this one is a typo — or, when a committed pointer named it, a teammate
 * who never chose the name and cannot be told to check their spelling. Those
 * last two are the same absence and must not read the same.
 */
export function notSignedIn(
  path: string,
  file: CredentialFile | null,
  selection: ProfileSelection,
  /**
   * The sign-in server this run named (`--origin` / `$XANO_ORIGIN`). The remedy
   * carries it when it is not the default: a `login` without it signs in to the
   * default server, not the one this run was pointed at.
   */
  origin?: string,
  /**
   * The project pin that chose the name, when one did: the project's tracked
   * deploys under that profile say which instance and workspace it reached, so
   * the `profile add` remedy is filled in rather than left `<url>`/`<id>`.
   */
  pin?: ProjectPin,
): NotSignedInError {
  const available = file === null ? [] : profileNames(file);
  const target = {
    path,
    ...(origin !== undefined ? { origin } : {}),
    ...(selection.source === "pointer" ? recordedTargetFor(pin, selection.name) : {}),
  };
  // A profile NAMED — `-p`, `$XANO_PROFILE`, this project's pin — is asked
  // about by name, and on an empty machine it is just as missing as on a full
  // one. "Not signed in" there dropped the name and exited 1 where a non-empty
  // file exits 8 naming it.
  const named = selection.source === "flag" || selection.source === "env" || selection.source === "pointer";
  if (available.length === 0 && named) {
    return new ProfileNotFoundError(
      `No credential profile "${selection.name}" (${profileSourceLabel(selection.source)}) — ` +
        `no profile is stored at ${path}.\n` +
        `Run ${addProfileHint(selection.name, target)} to add it.`,
      selection,
      available,
    );
  }
  if (available.length === 0) {
    return new NotSignedInError(
      `Not signed in (no credential at ${path}). ` +
        `Run \`${loginCommand(DEFAULT_PROFILE, target)}\` to sign in, or store a meta API token with ` +
        `\`xanosdk profile add <name>${credentialFileFlag(path)} --instance <url> --workspace-id <id>\`. ` +
        `For CI, set XANO_INSTANCE_URL, XANO_WORKSPACE_ID and XANO_META_TOKEN together.`,
    );
  }
  const have = `Stored profiles: ${quotedNames(available)}.`;
  // The project-local file SHADOWS the shared one: a profile the shared file
  // holds is not "not signed in on this machine" — it is one file away.
  const shared = shadowedInShared(path, selection.name);
  if (shared !== undefined) {
    return new ProfileNotFoundError(
      `Profile "${selection.name}" (${profileSourceLabel(selection.source)}) is stored in this machine's shared ` +
        `credential file (${shared}), but this project's ${path} is read instead and does not hold it. ${have}\n` +
        `Use the shared one with \`--config ${shellQuote(shared)}\`, remove ${path} so commands here fall back ` +
        `to it, or add the profile here: ${addProfileHint(selection.name, target)}.`,
      selection,
      available,
    );
  }
  if (selection.source === "pointer") {
    // A pin one slip from a stored name (a case variant above all) is likelier
    // a typo than a profile never added, as for `-p` and XANO_PROFILE.
    const near = suggest(selection.name, available);
    const err = new ProfileNotFoundError(
      `This project's xano.profile.json names profile "${selection.name}", which is not signed in ` +
        `on this machine (${path}). ${have}` +
        (near === undefined
          ? ""
          : ` Did you mean "${safeText(near)}"? Run \`xanosdk profile use ${shellQuote(near)}${credentialFileFlag(path)}\` to pin it.`) +
        `\nRun ${addProfileHint(selection.name, target)} to sign in as it, or ` +
        `\`xanosdk profile use <name>${credentialFileFlag(path)}\` to point this project at one you have.`,
      selection,
      available,
    );
    if (near !== undefined) Object.defineProperty(err, "suggestion", { value: near, enumerable: true });
    return err;
  }
  // Nobody chose a DEFAULT that is missing — it is what `profile delete` of the
  // default leaves — so a profile already stored is as good a fix as a login.
  const unchosen = selection.source === "file-default" || selection.source === "implicit";
  if (unchosen) {
    // Led by the stored profile, not by a sign-in: nobody asked for
    // "default" by name, and one that works is already on this machine.
    const one = available.length === 1;
    return new ProfileNotFoundError(
      `No default profile to use: ${path} holds no profile "${selection.name}". ${have} ` +
        `Run \`xanosdk profile set-default ${one ? shellQuote(available[0]!) : "<name>"}${credentialFileFlag(path)}\` to make ` +
        `${one ? "it" : "one of them"} the default, or ${addProfileHint(selection.name, target)} to add "${selection.name}".`,
      selection,
      available,
    );
  }
  // A name typed (`-p`, `$XANO_PROFILE`) one slip from a stored one is likelier
  // a typo than a profile never added (E2E pass 26: `whoami -p <typo>` named
  // only the add), so the near name leads, in the spelling that selected this one.
  const near = suggest(selection.name, available);
  const retype =
    near === undefined
      ? ""
      : ` Did you mean "${safeText(near)}"? ${selection.source === "env" ? `Set XANO_PROFILE=${shellQuote(near)}` : `Pass \`--profile ${shellQuote(near)}\``} instead.`;
  const err = new ProfileNotFoundError(
    `No credential profile "${selection.name}" in ${path} (${profileSourceLabel(selection.source)}). ` +
      `${have}${retype} Run ${addProfileHint(selection.name, target)} to add it.`,
    selection,
    available,
  );
  // The `--json` failure document's `suggestion`, as a usage failure's.
  if (near !== undefined) Object.defineProperty(err, "suggestion", { value: near, enumerable: true });
  return err;
}

/**
 * The shared file's path when `path` is the project-local file and the shared
 * one holds `name` — the local file shadowing it. Advice only: an unreadable
 * shared file answers undefined.
 */
function shadowedInShared(path: string, name: string): string | undefined {
  if (resolvePath(path) !== localAuthFilePath()) return undefined;
  const shared = globalAuthFilePath();
  try {
    const file = readCredentialFile(shared);
    return file !== null && Object.prototype.hasOwnProperty.call(file.profiles, name) ? shared : undefined;
  } catch {
    return undefined;
  }
}

/** The `(instance, workspace)` a credential addresses, regardless of arm. */
function targetOf(credential: CredentialRecord): { instance: string; workspaceId: number } {
  return credential.type === "token"
    ? { instance: credential.instance_base_url, workspaceId: credential.workspace_id }
    : { instance: credential.instance, workspaceId: credential.workspace_id };
}

/**
 * Loud guard against a project-local credential silently shadowing the global
 * default. Read mode prefers a local `./.xano/auth.json` over the global one,
 * which — if the two address DIFFERENT targets — would point a full-replace
 * deploy at the wrong place with no visible sign.
 *
 * Compares the whole `(instance, workspace)` target, across arms: a local
 * `"token"` credential shadowing a global `"oauth"` one is the same hazard, and
 * is more likely since both types share the file. A divergent workspace on
 * the same instance is just as damaging as a divergent instance.
 *
 * Only fires for the *default* resolution (no `--config`/`$XANO_CONFIG`, no
 * `--local`) that landed on the local file while a divergent global one also
 * exists. An explicit path or `--local` is a deliberate choice and stays quiet.
 */
function warnIfLocalShadowsGlobal(
  args: ParsedArgs,
  resolved: string,
  saved: CredentialRecord,
  selection: ProfileSelection,
): void {
  const isDefaultResolution = args.authFile === undefined && readPathEnvVar("XANO_CONFIG") === undefined && !args.local;
  if (!isDefaultResolution || resolved !== localAuthFilePath()) return;
  const globalPath = globalAuthFilePath();
  if (globalPath === resolved) return;

  // A broken/stale global credential must not blow up a run that isn't using it.
  // The SAME profile is looked up over there: two files whose `default` keys
  // disagree are exactly the divergence this exists to surface.
  let globalSaved: CredentialRecord | null = null;
  try {
    globalSaved = readCredential(globalPath, selection.name);
  } catch {
    return;
  }
  if (!globalSaved) return;

  const here = targetOf(saved);
  const there = targetOf(globalSaved);
  if (here.instance === there.instance && here.workspaceId === there.workspaceId) return;

  credentialWarning(
    "credential.shadowed-global",
    `Using project-local ${resolved}, ${describeProfileSelection(selection)} ` +
      `(${hostLabel(here.instance)}, workspace ${here.workspaceId}), but a global credential for ` +
      `${hostLabel(there.instance)}, workspace ${there.workspaceId} also exists under the same ` +
      `profile name — the local one wins. Remove ./.xano/auth.json (or pass --config) to use the ` +
      `global credential instead.`,
  );
}

/**
 * Refresh + persist ONE profile's oauth credential while holding the credential
 * file's advisory lock.
 *
 * After acquiring the lock we re-read: if a concurrent run refreshed while we
 * waited, we use its result instead of spending our now-stale refresh token a
 * second time. We also re-check that the profile still EXISTS and still names
 * the same `(instance, workspace)` — a profile deleted or repointed while we
 * waited must not be resurrected or written to with another tenant's token.
 */
async function refreshUnderLock(
  authFilePath: string,
  selection: ProfileSelection,
  saved: OAuthCredential,
): Promise<ResolvedAuth> {
  const profile = selection.name;
  return withCredentialLock(authFilePath, async (file) => {
    const current = rereadOAuthProfile(file, profile, authFilePath, saved);
    const instance = current.instance;
    const workspaceId = current.workspace_id;
    if (Date.now() < current.expires_at - EXPIRY_SKEW_MS) {
      return {
        access_token: current.access_token,
        instance,
        workspaceId,
        credentialType: "oauth" as const,
        profile: selection,
      };
    }
    /**
     * The sign-in that replaces this profile, unquoted — what `status` reports
     * as the fix. It carries the file this run read and the server the profile
     * was minted at: a bare `login` would sign into the shared file, at the
     * default server.
     */
    const target = { path: authFilePath, origin: current.auth_host };
    const login = (force = false): string => loginCommand(profile, target, force ? ["--force"] : []);
    const unusable = (message: string, fix: string | null, cause?: unknown): StoredCredentialError =>
      new StoredCredentialError(message, selection, instance, fix, { cause });
    if (!current.refresh_token) {
      throw unusable(
        `No usable access token for ${instance} and no refresh token is cached. ` +
          `Run \`${login()}\` again.`,
        login(),
      );
    }
    // The refresh token is about to be SENT to `auth_host`, so it gets the rule
    // every other credential destination gets: https, or plain http to this
    // machine. A hand-edited or tampered record must not leak a live refresh
    // token over cleartext. Nothing is written — the record is left for the
    // re-login that replaces it.
    try {
      assertStoredAuthHost(current.auth_host, profile, authFilePath);
    } catch (err) {
      // No `--origin`: the stored host is the thing refused, so the fix must
      // not send the reader back to it.
      const fix = loginCommand(profile, { path: authFilePath }, ["--force"]);
      throw unusable(err instanceof Error ? err.message : String(err), fix, err);
    }
    detail(`Refreshing access token for ${hostLabel(instance)}…`);
    let set: RawTokens;
    try {
      set = await refreshWithRetry(current.auth_host, current.client_id, current.refresh_token, current.scope);
    } catch (err) {
      const message = await describeRefreshFailure(err);
      // A rejected/replayed/expired refresh token can't be salvaged: drop the
      // spent credential so the next run starts a clean login rather than
      // retrying with a token the AS will keep rejecting. Resolved through the
      // envelope-aware reader, so a server that answers `invalid_grant` outside
      // the RFC `error` field still lands here rather than in the retry advice.
      //
      // Scoped to THIS profile: one expired session must not sign the user out
      // of every other tenant in the same file.
      const refused = await refusedRefreshCredential(err);
      if (refused === "token") {
        const removedFile = writeOrRemoveCredentialFile(authFilePath, dropProfile(file, profile));
        // The remedy carries the sign-in server this profile was minted at and
        // the file it was stored in — see `login` above.
        const relogin = login();
        throw credentialRejected(
          unusable(
            `Session for profile "${profile}" (${instance}) has expired or was revoked ` +
              `(the refresh token was rejected), so the profile was removed from ${authFilePath}` +
              `${removedFile ? " — it was the last one, so the file went with it" : ""}. ` +
              `Run \`${relogin}\` to sign in again.`,
            relogin,
          ),
          { profile, credentialType: "oauth", instance, workspaceId, signIn: relogin },
        );
      }
      // A transient network failure (bare `fetch failed`, timeout) reached no
      // authorization server, so `xanosdk login` is the wrong fix — and the one
      // command automated agents are told not to run. Point at a retry instead.
      // Nothing is written, so the file stays byte-identical.
      //
      // A 5xx is transient too, but the server DID answer — "could not reach"
      // would send the reader to check a network that is fine.
      if (isTransientRefreshError(err)) {
        const answer = await describeRefreshAnswer(err);
        throw unansweredRefresh(unusable(
          answer === undefined
            ? `Token refresh for ${instance} could not reach the authorization server (${message}), even after one retry. ` +
                `This is a transient network error, not an auth problem — re-run the command. ` +
                `If it persists, check connectivity to ${current.auth_host}.`
            : `Token refresh for ${instance} failed: the authorization server answered ${answer}${retriedNote(err)}. ` +
                unansweredRefreshCause(err, current.auth_host, "Signing in again"),
          null,
          err,
        ), err);
      }
      // A genuine OAuth error (invalid_client, etc.) — credentials/config are at
      // fault, so re-authenticating is the right remedy.
      const failed = unusable(
        `Token refresh failed for ${instance}: ${message}\n` +
          `Run \`${login()}\` to sign in again.`,
        login(),
        err,
      );
      throw refused === "client"
        ? credentialRejected(failed, { profile, credentialType: "oauth", instance, workspaceId, signIn: login() })
        : failed;
    }
    const stamped = stampExpiry(set);
    // Persist the rotated refresh token — the old one is now spent. ONE profile
    // is merged into the file we read inside the lock; every other entry is
    // carried through exactly as the previous writer left it.
    file.profiles[profile] = {
      ...current,
      access_token: stamped.access_token,
      refresh_token: stamped.refresh_token ?? current.refresh_token,
      expires_at: stamped.expires_at,
      scope: stamped.scope ?? current.scope,
    } satisfies OAuthCredential;
    writeCredentialFile(authFilePath, file);
    return {
      access_token: stamped.access_token,
      instance,
      workspaceId,
      credentialType: "oauth" as const,
      profile: selection,
    };
  });
}

/**
 * Refuse a stored OAuth `auth_host` that is not https (or http to loopback)
 * before a refresh or revoke sends the refresh token to it. Shared with
 * `logout` / `profile delete`, which revoke at the same host.
 */
export function assertStoredAuthHost(authHost: string, profile: string, authFilePath?: string): void {
  try {
    assertHttpsOrigin(
      authHost,
      `The sign-in server (\`auth_host\`) stored for profile "${profile}"${authFilePath === undefined ? "" : ` in ${authFilePath}`}`,
    );
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)} The refresh token was not sent. ` +
        `Run \`${loginCommand(profile, { path: authFilePath }, ["--force"])}\` to sign in again and replace the record.`,
      { cause: err },
    );
  }
}

/**
 * The profile as it stands inside the lock, or a hard stop.
 *
 * Abandoning is the safe outcome for all three divergences: a profile that was
 * deleted must not be resurrected, one repointed at a different
 * `(instance, workspace)` must not receive this tenant's token, and one replaced
 * with a hand-authored `"token"` record has nothing to refresh.
 */
function rereadOAuthProfile(
  file: CredentialFile,
  profile: string,
  path: string,
  saved: OAuthCredential,
): OAuthCredential {
  let current: CredentialRecord | null;
  try {
    current = readProfile(file, profile, path);
  } catch {
    // Replaced with something unparseable while we waited — the same situation
    // as gone, and repairing someone else's write is not this path's business.
    current = null;
  }
  if (current === null) {
    throw new Error(
      `Profile "${profile}" was removed from ${path} while its token was being refreshed. ` +
        `Nothing was written. Run ${loginHint(profile, { path, origin: saved.auth_host })} to sign in again.`,
    );
  }
  if (current.type !== "oauth") {
    throw new Error(
      `Profile "${profile}" in ${path} was replaced with a hand-authored meta API token while ` +
        `its OAuth token was being refreshed. Nothing was written — re-run the command to use it.`,
    );
  }
  if (current.instance !== saved.instance || current.workspace_id !== saved.workspace_id) {
    throw new Error(
      `Profile "${profile}" in ${path} was repointed from ${hostLabel(saved.instance)} workspace ` +
        `${saved.workspace_id} to ${hostLabel(current.instance)} workspace ${current.workspace_id} ` +
        `while its token was being refreshed. Nothing was written — re-run the command.`,
    );
  }
  return current;
}

