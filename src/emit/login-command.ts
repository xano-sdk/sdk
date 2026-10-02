/**
 * `xanosdk login` — run the OAuth 2.1 authorization-code + PKCE flow against the
 * Xano control-plane and cache the resulting tokens locally for reuse by
 * `push`.
 *
 * Two ways to receive the authorization code, differing ONLY in that step:
 *   • default — a fixed-port 127.0.0.1 loopback server catches the redirect.
 *   • `--paste` — nothing is bound; the user finishes consent in whatever
 *     browser they have and pastes the redirect back. For hosts whose loopback
 *     the browser cannot reach: a remote shell, a container, a Codespace. Note
 *     this is NOT what `XANO_NO_BROWSER` does — that only suppresses the browser
 *     LAUNCH, and still needs the redirect to arrive.
 *
 * Flow: start a fixed-port 127.0.0.1 loopback server (or not, under `--paste`) → build an OpenIdProvider
 * (discovers endpoints and dynamically registers, or reuses, a client whose
 * redirect_uri is exactly that loopback URL) → open the browser to the authorize
 * URL → capture the callback → exchange the code → read the bound instance from
 * the token's `aud` claim → write the shared global cache (0600, or the
 * project-local one with `--local`) and ensure it is gitignored.
 *
 * The user always picks the target instance at the hosted consent screen (like
 * the dashboard); the saved instance is the token's true `aud`, never a flag.
 *
 * Robustness: a stale DCR client (the AS forgot our registration) surfaces as
 * `invalid_client` at authorize OR exchange; we drop the cached client and retry
 * the whole flow ONCE, mirroring the dashboard BFF's callback recovery.
 *
 * All progress/prompts go to STDERR (stdout stays clean, matching `push`).
 * Node-only and lazily imported so `compile`/`export` never pull in `node:http`.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as client from "openid-client";
import type { ParsedArgs } from "./cli.js";
import { UsageError } from "./errors.js";
import {
  OpenIdProvider,
  oauthErrorCode,
  oauthErrorResponse,
  resolveOAuthErrorCode,
  decodeAudience,
  CALLBACK_PATH,
  DEFAULT_PORT,
} from "../auth/oauth.js";
import { startCallbackServer, openBrowser, loopbackRedirectUri } from "../auth/loopback.js";
import { normalizePastedCallback } from "../auth/paste.js";
import { promptLine } from "./prompt.js";
import {
  writeCredentialFile,
  withCredentialLock,
  readCredentialFile,
  readProfile,
  profileNames,
  assertCredentialFileWritable,
  resolveAuthFilePath,
  loginCommand,
  credentialFileFlag,
  globalAuthFilePath,
  type OAuthCredential,
  type CredentialRecord,
} from "../auth/store.js";
import { resolveActiveProfile } from "../auth/profile-select.js";
import { ensureGitignoredOrWarn, type CredentialGitignored } from "./gitignore.js";
import { isMachineOutput, writeJson } from "./output.js";
import { resolveProjectProfile } from "../auth/profile-pointer.js";
import { resolveAuthHost, resolveScope, assertSignInOrigin, envOrigin } from "../auth/config.js";
import { environmentCredentialVars, describeRefreshAnswer } from "../auth/token.js";
import { revokeProfileSession, revocableRecord, warnRevokeFailed } from "./logout-command.js";
import { describeTransportFailure, isTimeoutError } from "../util/http.js";
import { envFlagSet } from "../util/env.js";
import { shellQuote } from "../util/shell-quote.js";
import { step, success, warn, info, detail, blank, hostLabel } from "./ui.js";

export async function runLoginCommand(args: ParsedArgs): Promise<void> {
  const authHost = resolveAuthHost(args);
  const scope = resolveScope(args);
  const port = args.port ?? DEFAULT_PORT;
  try {
    assertSignInOrigin(authHost, args.authHost === undefined && envOrigin() !== undefined ? "XANO_ORIGIN" : "--origin");
  } catch (err) {
    // Fixed by retyping the origin: a usage failure, `SDK_USAGE`.
    throw new UsageError(err instanceof Error ? err.message : String(err), { hintFor: { command: "login" } });
  }
  // An ephemeral port is meaningful only when something binds it. Under --paste
  // it would produce a redirect_uri nothing can ever serve AND a throwaway client
  // registration, so refuse instead of failing later at the authorize screen.
  if (args.paste && port === 0) {
    throw new UsageError(
      "`--port 0` asks for an ephemeral port, which --paste cannot use: nothing is bound, " +
        "so the port is only part of the redirect URL's identity. Drop --port to use the default.",
      { hintFor: { command: "login" } },
    );
  }

  // Check the file we would OVERWRITE (the write-mode path), not the one a read
  // would resolve to — otherwise a project-local cache would block a global login.
  const targetPath = resolveAuthFilePath(args, "write");
  // Which PROFILE this login creates or replaces. `--profile` is how a profile
  // is created: there is no separate `profile create`, because creating an
  // OAuth profile IS a consent round trip.
  const profile = resolveLoginProfile(args, targetPath);
  // Refuse a file this build cannot write BEFORE consent, not after: the write
  // is the last step, and discovering it there throws away a freshly minted
  // credential and a whole browser round trip.
  assertCredentialFileWritable(targetPath);
  if (!args.force && reportAlreadySignedIn(args, targetPath, profile)) return;

  // Refuse BEFORE any network work, but AFTER the short-circuit above: a
  // container's setup script re-running `login --paste` on an already-signed-in
  // machine has nothing to prompt for, and should succeed rather than exit
  // non-zero. Everything past this point does need a person.
  if (args.paste && process.stdin.isTTY !== true) {
    throw new UsageError(
      "`--paste` reads the authorization code back from you, so it needs a terminal. " +
        "For automation, set XANO_INSTANCE_URL / XANO_WORKSPACE_ID / XANO_META_TOKEN, or store a meta API token with " +
        // The profile this login was told to create, when it was named.
        `\`xanosdk profile add ${args.profile !== undefined ? shellQuote(profile) : "<name>"}${credentialFileFlag(targetPath)} ` +
        `--instance <url> --workspace-id <id>\`.`,
      { hintFor: { command: "login" } },
    );
  }

  step(`Signing in to ${hostLabel(authHost)}`);

  // The command a failure tells the reader to run again: this one, with every
  // flag that decides WHERE the sign-in goes — the profile, the credential
  // file, the sign-in server — so a re-run cannot land somewhere else.
  const again = loginCommand(profile, { path: targetPath, origin: authHost }, [
    ...(args.paste ? ["--paste"] : []),
    ...(args.port !== undefined ? [`--port ${args.port}`] : []),
    ...(args.force ? ["--force"] : []),
  ]);

  let record: OAuthCredential;
  try {
    record = await attemptLogin({ authHost, scope, port, paste: args.paste, again, profile });
  } catch (err) {
    // A rejected registration can't be salvaged mid-flight: reset() (inside
    // attemptLogin) already dropped it, so retry the whole flow once with a
    // fresh registration.
    if (oauthErrorCode(err) !== "invalid_client") throw err;
    warn("The registered client was rejected — re-registering and retrying once.", "login.client-reregistered");
    record = await attemptLogin({ authHost, scope, port, paste: args.paste, again, profile, retry: true });
  }

  const authFilePath = targetPath;
  let becameDefault = false;
  let isDefault = false;
  let replaced: OAuthCredential | undefined;
  try {
    await withCredentialLock(authFilePath, (file) => {
      // Merge ONE profile into the file as re-read inside the lock: every other
      // profile is carried through exactly as its own writer left it.
      // The FIRST profile in an EMPTY file becomes the default; a later one does
      // not silently displace it.
      //
      // Keyed on emptiness, not on the absent `default` key: a file written before
      // profiles designates no default (none is synthesized on read, so the rung
      // stays honest), yet it already holds a credential. Testing the key would
      // let `login --profile staging` on such a file claim the default and point
      // every later bare command at the new tenant.
      //
      // Read from the snapshot the write replaces, so the session revoked below
      // is provably the one this write removed.
      replaced = revocableRecord(file, profile, authFilePath);
      becameDefault = profileNames(file).length === 0;
      file.profiles[profile] = record;
      if (becameDefault) file.default = profile;
      isDefault = file.default === profile;
      writeCredentialFile(authFilePath, file);
    });
  } catch (err) {
    // The session is minted and was not stored: nothing will ever use or revoke
    // it, so it is revoked here rather than left live on the server.
    await revokeProfileSession(args, record, profile, "minted");
    throw err;
  }
  // A `--force` over an OAuth profile revokes the session it replaced, as
  // `profile add --force` does: with the record overwritten nothing can reach
  // that refresh token again, and it would stay live and replayable. After the
  // write, so a write that fails leaves the old session working.
  if (replaced !== undefined && replaced.refresh_token !== record.refresh_token) {
    step(`Revoking the session that profile "${profile}" held…`);
    await revokeProfileSession(args, replaced, profile, "replace");
  }

  blank();
  success(`Signed in to ${hostLabel(record.instance)} as profile "${profile}"`);
  detail(`Workspace ${record.workspace_id} (pinned — every command acts on this one)`);
  detail(`Credentials saved to ${authFilePath}`);
  // "This machine's default" only for the machine-wide file: a `--local` or
  // `--config` file's default governs runs that read THAT file, nothing more.
  const machineFile = authFilePath === globalAuthFilePath();
  const defaultOf = machineFile ? "this machine's default" : `the default profile in ${authFilePath}`;
  if (becameDefault) {
    detail(machineFile ? `It is this machine's default profile.` : `It is ${defaultOf}.`);
  } else if (isDefault) {
    // A re-login (`--force`, or an expired session) of the profile that is
    // already the default: it stays the default, and the select-it advice
    // below would contradict the `isDefault: true` the document carries.
    detail(machineFile ? `It is still this machine's default profile.` : `It is still ${defaultOf}.`);
  } else {
    // A sign-in the NEXT command ignores is the most confusing outcome there
    // is: the user consented to a tenant nothing will act on until they select
    // it, so the exact line that selects it goes here.
    const fileFlag = credentialFileFlag(authFilePath);
    info(
      `"${profile}" is not ${defaultOf} — select it with \`--profile ${profile}${fileFlag}\`, ` +
        `or pin this project to it with \`xanosdk profile use ${profile}${fileFlag}\`.`,
    );
  }
  // A sign-in that every later command ignores is the most confusing possible
  // outcome — the env credential outranks this file, so say so HERE rather than
  // letting the next deploy land on a workspace the user did not just consent to.
  // A PRESENCE check, never a parse: this runs after the credential is on disk
  // and before it is gitignored, so it must not be able to throw. The vars are
  // NAMED because a partial set is the confusing case — the one that is set is
  // what the user has to find and unset. The same reading `logout` reports:
  // the meta-token triple AND XANO_REFRESH_TOKEN both outrank every profile.
  const env = environmentCredentialVars();
  if (env.vars.length > 0) {
    const them = env.vars.length === 1 ? "it" : "them";
    warn(
      `${env.vars.join(", ")} ${env.vars.length === 1 ? "is" : "are"} set in this environment, ` +
        `outranking this credential — ` +
        (env.complete
          ? `commands will keep using ${them}. `
          : `it is an incomplete credential, so commands will fail on ${them} rather than use this one. `) +
        `Unset ${them} to act as the account you just signed in as.`,
      "credential.env-outranks",
    );
  }
  // Scope line keys on the resolved path, not the flag: an explicit `--config`
  // path is neither cache, so it gets no (potentially false) scope claim.
  if (machineFile) {
    // The real directory: XANO_GLOBAL_CONFIG can put the shared cache anywhere.
    const shared = authFilePath === join(homedir(), ".xanosdk", "auth.json") ? "~/.xanosdk" : dirname(authFilePath);
    detail(`Using the shared ${shared} cache — available from any project directory.`);
  } else if (args.local) {
    // The project ROOT's cache, which from a subdirectory is not the cwd's —
    // said, so the reader does not go looking for ./.xano beside them.
    const root = dirname(dirname(authFilePath));
    detail(
      root === process.cwd()
        ? "Using the project-local .xano cache — scoped to this project."
        : `Using the project-local .xano cache at the project root ${root} — scoped to this project, ` +
            `and read from any directory in it.`,
    );
  }

  // Tokens are already durably saved; a .gitignore failure must not fail the
  // login (and thus exit non-zero). Warn and continue.
  const gitignored = ensureGitignoredOrWarn(authFilePath);
  if (!record.refresh_token) {
    warn(
      "No refresh token was issued (offline_access not granted); " +
        "push will require re-login once the access token expires.",
      "login.no-refresh-token",
    );
  }
  if (isMachineOutput(args)) {
    writeLoginDocument({
      profile,
      path: authFilePath,
      signedIn: true,
      changed: true,
      gitignored,
      instance: record.instance,
      workspaceId: record.workspace_id,
      credential: "oauth",
      isDefault,
    });
  }
}

/**
 * Which profile this login writes.
 *
 * The same ladder every other command resolves, minus the environment-credential
 * arms `getAccessToken` has: a bare `xanosdk login` on a machine whose default is
 * "prod" means "sign me back in to prod", not "create a second profile called
 * default". The project pointer is honoured for the same reason — a repository
 * that pins itself to a profile is saying which one a sign-in here is for.
 */
function resolveLoginProfile(args: ParsedArgs, authFilePath: string): string {
  let fileDefault: string | undefined;
  try {
    fileDefault = readCredentialFile(authFilePath)?.default;
  } catch {
    // A file too broken to read still gets a login — that IS its repair.
  }
  return resolveActiveProfile({
    flag: args.profile,
    fileDefault,
    readPointer: () => resolveProjectProfile(process.cwd()),
  }).name;
}

/**
 * Short-circuit `login` when the file it would overwrite already holds a usable
 * credential — the common "did that work?" re-run. A second full browser round
 * trip buys nothing there, and against a hand-authored `token` record it is
 * destructive, so signing in anyway takes `--force`.
 *
 * "Usable" excludes an OAuth record that has expired with no refresh token —
 * nothing can renew it, so that falls through to a real login. A corrupt or
 * pre-typed file throws on read; a fresh login is exactly its repair, so the
 * throw is swallowed here rather than blocking the fix.
 *
 * Deliberately offline: naming the signed-in *user* would cost a meta call, and
 * this path exists to avoid needless waiting, not add a round trip to it. The
 * pinned `(instance, workspace)` is already on disk.
 */
function reportAlreadySignedIn(args: ParsedArgs, authFilePath: string, profile: string): boolean {
  let existing: CredentialRecord | null;
  let isDefault = false;
  try {
    const file = readCredentialFile(authFilePath);
    // PER-PROFILE, not per-file: `login --profile staging` on a machine that
    // already has `prod` must proceed to consent rather than short-circuit on
    // a credential for a different tenant entirely.
    existing = file === null ? null : readProfile(file, profile, authFilePath);
    isDefault = file?.default === profile;
  } catch {
    return false;
  }
  if (!existing) return false;
  if (existing.type === "oauth" && !existing.refresh_token && Date.now() >= existing.expires_at) return false;

  const target =
    existing.type === "token"
      ? `${hostLabel(existing.instance_base_url)} with a meta API token profile (from \`profile add\`)`
      : hostLabel(existing.instance);
  info(`Profile "${profile}" is already signed in to ${target}, workspace ${existing.workspace_id}.`);
  detail(`Credential: ${authFilePath}`);
  // An `--origin` that is not the sign-in server this profile was minted at
  // asked for something this short-circuit does not do — say so, and name the
  // flag that does, rather than answer about the old host as if it were moot.
  const asked = args.authHost === undefined ? undefined : originOf(resolveAuthHost(args));
  const stored = existing.type === "oauth" ? originOf(existing.auth_host) : undefined;
  // The forced sign-in, naming THIS profile and file: a bare `login --force`
  // resolves the project's pinned profile, which may be another one entirely.
  const origin = asked === undefined ? "" : ` --origin ${shellQuote(asked)}`;
  const forced = `xanosdk login --profile ${shellQuote(profile)}${credentialFileFlag(authFilePath)}${origin} --force`;
  const hint =
    asked !== undefined && asked !== stored
      ? `\`--origin ${asked}\` was not used: this profile signed in through ` +
        `${stored ?? "a meta API token, with no sign-in server"}. ` +
        `Run \`${forced}\` to sign in through ${asked} and replace it.`
      : existing.type === "token"
        ? // `login --force` would REPLACE a token profile with an OAuth sign-in;
          // refreshing its token is `profile add --force`, which keeps the kind.
          `To replace its meta API token, run \`xanosdk profile add ${shellQuote(profile)}${credentialFileFlag(authFilePath)} ` +
          `--instance ${existing.instance_base_url} --workspace-id ${existing.workspace_id} --force\` ` +
          `(\`${forced}\` would replace it with an OAuth sign-in instead).`
        : `Run \`${forced}\` to sign in again.`;
  detail(hint);
  // The guarantee a fresh sign-in gives, on the re-run too: the credential file
  // is kept out of git (a rule missing since the first sign-in is added now),
  // and the document says so — `gitignored` and `isDefault` in both shapes.
  const gitignored = ensureGitignoredOrWarn(authFilePath);
  if (isMachineOutput(args)) {
    writeLoginDocument({
      profile,
      path: authFilePath,
      signedIn: true,
      changed: false,
      gitignored,
      isDefault,
      instance: existing.type === "token" ? existing.instance_base_url : existing.instance,
      workspaceId: existing.workspace_id,
      credential: existing.type,
      hint,
    });
  }
  return true;
}

/** An origin, or the raw string when it will not parse — it is only compared and printed. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * The `--json` answer. `signedIn` is the profile's state after the run, so it
 * is true on both paths; `changed: false` is the short-circuit — the profile
 * already held a usable credential and nothing was written — so a script can
 * tell "signed in now" from "was already" without reading stderr.
 * `gitignored` and `isDefault` ride on both: `changed` is about the credential,
 * and the short-circuit still keeps its file out of git.
 */
function writeLoginDocument(doc: {
  profile: string;
  path: string;
  signedIn: true;
  changed: boolean;
  gitignored: CredentialGitignored;
  instance: string;
  workspaceId: number;
  credential: "oauth" | "token";
  isDefault: boolean;
  /** The short-circuit's advice, when it is more than "re-run with --force". */
  hint?: string;
}): void {
  const { hint, ...rest } = doc;
  writeJson({ verb: "login", ...rest, ...(doc.changed ? {} : { hint: hint ?? "Re-run with --force to sign in again." }) });
}

/**
 * One end-to-end login attempt. On `invalid_client` it drops the stale
 * registration (`provider.reset()`) and rethrows so the caller can retry with a
 * fresh one. Every other outcome (success or a real failure) is returned/thrown
 * as-is.
 */
async function attemptLogin(p: {
  authHost: string;
  scope: string;
  port: number;
  paste: boolean;
  /** The unquoted `xanosdk login …` a failure says to run again. */
  again: string;
  /** The profile this sign-in is for — named if a minted session cannot be revoked. */
  profile: string;
  /** Second pass after an `invalid_client` reset — labels the repeated prompt. */
  retry?: boolean;
}): Promise<OAuthCredential> {
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();

  const { callbackUrl, provider } = p.paste
    ? await acquireByPaste({ ...p, verifier, state })
    : await acquireByLoopback({ ...p, verifier, state });

  let tokens;
  try {
    tokens = await provider.exchange(callbackUrl, { verifier, state });
  } catch (err) {
    if (oauthErrorCode(err) === "invalid_client") {
      await provider.reset();
      throw err;
    }
    throw (await explainRefusedCode(err, p.again)) ?? explainRejectedResponse(err, p.paste, p.again);
  }

  // The instance is whatever the user chose at consent — read it back from the
  // token's `aud` claim (the authoritative binding).
  const boundInstance = decodeAudience(tokens.access_token);
  if (!boundInstance) {
    await revokeMinted(provider, tokens.refresh_token, p.authHost, p.profile);
    throw new Error(
      `Could not determine the instance from the issued token (no readable \`aud\` claim). ` +
        `This is unexpected — please report it.`,
    );
  }

  // PIN the numeric workspace now, once. The token carries the workspace *guid*
  // it consented to, not its id, so this is the one place the mapping is read.
  // Every later command reads the pinned value — there is no per-run override
  // and no per-run lookup. A failure here is fatal by design: a record without a
  // pinned workspace is exactly the stale shape the store rejects on read, so we
  // must not write one.
  const { resolveScopedWorkspaceId } = await import("../deploy/workspace.js");
  detail("Resolving the workspace this token is scoped to…");
  let workspaceId: number;
  try {
    workspaceId = await resolveScopedWorkspaceId(
      { access_token: tokens.access_token, instance: boundInstance },
      { again: p.again },
    );
  } catch (err) {
    // Minted and never stored: revoke it, or it stays live with nothing to reach it.
    await revokeMinted(provider, tokens.refresh_token, p.authHost, p.profile);
    throw err;
  }

  return {
    type: "oauth",
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in ?? 0) * 1000,
    scope: tokens.scope ?? p.scope,
    instance: boundInstance,
    workspace_id: workspaceId,
    auth_host: p.authHost,
    // Record exactly which client minted the token — required to refresh/revoke
    // it later. Resolved already (buildAuthUrl awaited the config).
    client_id: provider.clientId(),
  };
}

/**
 * Best-effort revoke of a refresh token this run minted and will not store. A
 * failure does not replace the run's own failure — that reason is the one the
 * run ends on — but it is WARNED, in the words the store-write path uses: a
 * session left live on the server is the reader's to know about, and a silent
 * swallow told them nothing was left behind.
 */
async function revokeMinted(
  provider: OpenIdProvider,
  refreshToken: string | undefined,
  authHost: string,
  profile: string,
): Promise<void> {
  if (refreshToken === undefined) return;
  try {
    await provider.revoke(refreshToken);
  } catch (err) {
    await warnRevokeFailed(`the session this sign-in minted for profile "${profile}"`, authHost, err, "minted");
  }
}

/**
 * The OAuth library reports a redirect it will not accept as a bare "invalid
 * response encountered", with the reason only on `.cause`. Surface the reason
 * and the way out; every other error passes through untouched.
 */
function explainRejectedResponse(err: unknown, paste: boolean, again: string): unknown {
  if ((err as { code?: unknown } | null)?.code !== "OAUTH_INVALID_RESPONSE") return err;
  const cause = (err as { cause?: unknown }).cause;
  const reason = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : undefined;
  return new Error(
    `The sign-in response was rejected${reason === undefined ? "" : `: ${reason}`}. ` +
      (paste
        ? "Paste the full URL your browser lands on after finishing THIS sign-in (or just its code=… value). "
        : "") +
      `Run \`${again}\` again to start over.`,
    { cause: err },
  );
}

/**
 * A token endpoint that ANSWERED and refused the code — spent, expired, or from
 * another sign-in. openid-client reports a non-RFC error body as a bare
 * "unexpected HTTP response status code", with the status and body only on
 * `.cause`; this reads both back, the way a refresh failure is described, and
 * says what to do. Undefined for anything else, which passes through.
 */
async function explainRefusedCode(err: unknown, command: string): Promise<Error | undefined> {
  const res = oauthErrorResponse(err);
  const code = await resolveOAuthErrorCode(err);
  const again = `run \`${command}\` again`;
  if (res === undefined && code === undefined) {
    // Nothing answered at all — a dropped connection or our own deadline. The
    // code was never judged, so this is a retry, not a sign-in mistake.
    if (!isTransportFailure(err)) return undefined;
    return new Error(
      `Sign-in failed: could not reach the authorization server to exchange the code ` +
        `(${describeTransportFailure(err)}). This is a network error, not an auth problem — ${again}.`,
      { cause: err },
    );
  }
  // A 5xx with no OAuth error is the server failing, not a verdict on the code:
  // "refused … single-use" would send the reader hunting for a sign-in mistake
  // they did not make. The same words a failed refresh uses for the same answer.
  if (code === undefined && res !== undefined && res.status >= 500) {
    const answer = (await describeRefreshAnswer(err)) ?? `HTTP ${res.status}`;
    return new Error(
      `Sign-in failed while exchanging the code: the authorization server answered ${answer}. ` +
        `This is a server-side error, not an auth problem — ${again}. ` +
        `If it persists, the sign-in server is having trouble.`,
      { cause: err },
    );
  }
  const why = [res === undefined ? undefined : `HTTP ${res.status}`, code].filter((p) => p !== undefined);
  return new Error(
    `The authorization server refused the sign-in code${why.length === 0 ? "" : ` (${why.join(" — ")})`}. ` +
      `A code is single-use and expires within minutes, so one that was already used, has expired, ` +
      `or belongs to another sign-in is refused. Run \`${command}\` again ` +
      `for a fresh one.`,
    { cause: err },
  );
}

/** `fetch`'s own transport failure (`TypeError: fetch failed`) or a deadline — never a server answer. */
function isTransportFailure(err: unknown): boolean {
  if (isTimeoutError(err)) return true;
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

/** How many unreadable pastes to absorb before giving up on the run. */
const MAX_PASTE_ATTEMPTS = 3;

/** What an acquisition strategy hands back: a callback URL, and the provider that built it. */
interface Acquired {
  callbackUrl: string;
  provider: OpenIdProvider;
}

/** Params both acquisition strategies need. */
interface AcquireParams {
  authHost: string;
  scope: string;
  port: number;
  verifier: string;
  state: string;
  retry?: boolean;
}

/**
 * Default: bind the loopback callback and wait for the browser to redirect into
 * it. Requires the browser to be able to reach THIS machine's 127.0.0.1.
 */
async function acquireByLoopback(p: AcquireParams): Promise<Acquired> {
  let listener;
  try {
    listener = await startCallbackServer({ callbackPath: CALLBACK_PATH, expectedState: p.state, port: p.port });
  } catch (err) {
    throw loopbackListenRefusal(err, p.port);
  }

  const provider = new OpenIdProvider({ authHost: p.authHost, redirectUri: listener.redirectUri, scope: p.scope });

  let authorizeUrl: string;
  try {
    authorizeUrl = await provider.buildAuthUrl({ verifier: p.verifier, state: p.state });
  } catch (err) {
    listener.close();
    throw err;
  }

  if (envFlagSet("XANO_NO_BROWSER")) {
    // Nothing is launched under XANO_NO_BROWSER, so "Opening your browser" would
    // have the reader wait for a window that never comes.
    detail("Open this URL in your browser to authorize — waiting for you to finish:");
  } else {
    detail("Opening your browser to authorize — waiting for you to finish…");
    detail("If it doesn't open, paste this URL into your browser:");
  }
  detail(authorizeUrl);
  openBrowser(authorizeUrl);

  try {
    const { callbackUrl } = await listener.waitForCallback;
    return { callbackUrl, provider };
  } catch (err) {
    listener.close();
    // An authorize-time `invalid_client` (the loopback tags it on `.error`)
    // is recoverable: drop the stale registration and let the caller retry.
    if (oauthErrorCode(err) === "invalid_client") await provider.reset();
    throw err;
  }
}

/**
 * A loopback port that could not be bound, as a usage error naming the fix —
 * every one of them is fixed by choosing another `--port`. Bound before any
 * request to the authorization server, so nothing was registered either.
 * Exported for the test, which cannot bind a privileged port on every machine.
 */
export function loopbackListenRefusal(err: unknown, port: number): UsageError {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const fix = `Pass another with \`--port <n>\`, or drop \`--port\` for the default ${DEFAULT_PORT}.`;
  const hint = { hintFor: { command: "login" } };
  if (code === "EADDRINUSE") {
    return new UsageError(`Loopback port ${port} is in use. ${fix}`, hint);
  }
  if (code === "EACCES") {
    return new UsageError(
      `Loopback port ${port} needs elevated privileges to listen on (EACCES) — ports below 1024 usually do. ` +
        `Pass one of 1024 or above with \`--port <n>\`, or drop \`--port\` for the default ${DEFAULT_PORT}.`,
      hint,
    );
  }
  const why = err instanceof Error ? err.message : String(err);
  return new UsageError(`Could not listen on loopback port ${port} (${why}). ${fix}`, hint);
}

/**
 * `--paste`: bind nothing, and read the redirect back from the user.
 *
 * The redirect_uri is still the loopback one — unchanged, so the registered
 * client is reused rather than duplicated — it just never gets served. The
 * browser lands on a "can't connect" page, and the address bar holds the code.
 *
 * The paste has to happen in THIS process: the PKCE verifier was generated here
 * and never leaves memory, so a code carried into a later invocation cannot be
 * exchanged. That is why there is no `--code` flag and no piped-stdin form —
 * automation belongs on the environment-credential path instead.
 */
async function acquireByPaste(p: AcquireParams): Promise<Acquired> {
  const redirectUri = loopbackRedirectUri(p.port, CALLBACK_PATH);
  const provider = new OpenIdProvider({ authHost: p.authHost, redirectUri, scope: p.scope });
  const authorizeUrl = await provider.buildAuthUrl({ verifier: p.verifier, state: p.state });

  blank();
  if (p.retry) detail("Starting over with a freshly registered client — this is a NEW link and a NEW code.");
  detail("Open this URL in any browser and finish signing in:");
  detail(authorizeUrl);
  blank();
  detail(
    `Your browser will then fail to load ${redirectUri} — that is expected, ` +
      `nothing is listening here. The address bar is what you want.`,
  );
  // Still best-effort open: this host may have a browser even when its loopback
  // is unreachable from one. A no-op under XANO_NO_BROWSER.
  openBrowser(authorizeUrl);

  // Re-ask on a paste we cannot READ. The PKCE verifier lives only in this
  // process, so throwing would strand a code that is still perfectly good and
  // cost the user another full consent round trip over a truncated copy.
  // An authorization ERROR is different — the server has decided, and no better
  // paste exists — so those propagate on the first try.
  for (let attempt = 0; ; attempt++) {
    const pasted = await promptLine("Paste that URL (or just the code from it):", {
      noTtyHint:
        "--paste has to read the code from you, so it needs a terminal. " +
        "For automation, set XANO_INSTANCE_URL / XANO_WORKSPACE_ID / XANO_META_TOKEN, or store a meta API token with `xanosdk profile add <name>`.",
    });

    try {
      const callbackUrl = normalizePastedCallback(pasted, {
        redirectUri,
        state: p.state,
        issuer: provider.issuer(),
      });
      return { callbackUrl, provider };
    } catch (err) {
      // A pasted `error=invalid_client` is recoverable the same way the loopback
      // path's is: drop the stale registration so the caller can retry once.
      if (oauthErrorCode(err) === "invalid_client") await provider.reset();
      const unreadable = oauthErrorCode(err) === undefined;
      if (!unreadable || attempt + 1 >= MAX_PASTE_ATTEMPTS) throw err;
      warn(
        `${err instanceof Error ? err.message : String(err)}`,
        "login.paste-failed",
        ["The link above is still valid — try pasting again."],
      );
    }
  }
}
