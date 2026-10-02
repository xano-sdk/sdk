/**
 * Node-only credential store for the CLI. Reads/writes a JSON file (the shared
 * `~/.xanosdk/auth.json`, or a project-local `./.xano/auth.json`) with
 * owner-only permissions, and keeps that file out of git. Never reachable from
 * the browser-safe `index.ts` surface — imported only by the CLI's command
 * modules.
 *
 * The file holds a map of NAMED PROFILES under a versioned envelope. Each
 * profile is one credential, discriminated by `type`:
 *   • `"oauth"` — written by `xanosdk login`; refreshes and rotates.
 *   • `"token"` — hand-authored or written by `xanosdk profile add`; a meta-API
 *     bearer token plus the instance and workspace it addresses. Never minted,
 *     refreshed, or rotated by the CLI.
 *
 * Both arms pin `workspace_id`, so `(instance, workspace)` is knowable from disk
 * alone and no command needs a runtime workspace lookup.
 *
 * A file written before profiles holds one bare record at the top level. It is
 * READ as the `default` profile and a read NEVER rewrites it — that keeps a
 * read-only `--config` path and a read-only filesystem working, and keeps a
 * read off the write lock. The next write upgrades it in place.
 *
 * The write mirrors `src/lock/io.ts` `writeLockFile` (temp-file + rename so a
 * crash can't leave a half-written credential file) and adds mode 0600 and a
 * recursive mkdir of the containing directory.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, rmdirSync, statSync, lstatSync, realpathSync, accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

/** The backend directory, whose contents are COMMITTED — never ignored wholesale. */
const XANO_DIR = "xano";
/** The dedicated project-local cache directory — the one directory ignored whole. */
const DEDICATED_DIR = ".xano";
import { basename, dirname, join, relative, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { DEFAULT_PROFILE, resolveActiveProfile } from "./profile-select.js";
import { pointerRootFor, resolveProjectProfile } from "./profile-pointer.js";
import { assertHttpsOrigin } from "./config.js";
import { DEFAULT_AUTH_HOST } from "./oauth.js";
import { shellQuote } from "../util/shell-quote.js";
import { atomicWrite, linkTarget } from "../util/atomic-write.js";
import { registerSecret, tokenTextProblem } from "../util/secrets.js";
import { expandHome, readPathEnvVar } from "../util/home-path.js";
import { UsageError } from "../emit/errors.js";
import type { ParsedArgs } from "../emit/cli.js";

export { DEFAULT_PROFILE };

/** Credentials minted by `xanosdk login` (OAuth 2.1 + PKCE). */
export interface OAuthCredential {
  type: "oauth";
  access_token: string;
  /** Present only when `offline_access` was granted. Rotated on every refresh. */
  refresh_token?: string;
  /** Epoch milliseconds after which `access_token` must be refreshed. */
  expires_at: number;
  /** Space-separated scopes the token was granted. */
  scope?: string;
  /** Instance origin the token is bound to (read from the token's `aud` claim). */
  instance: string;
  /** Numeric workspace the token consented to, pinned at login. */
  workspace_id: number;
  /** Xano control-plane OAuth host the token was minted by (for refresh). */
  auth_host: string;
  /** OAuth client_id the token was minted under — required to refresh it. */
  client_id: string;
}

/**
 * A hand-authored meta-API credential. Carries the same binding an OAuth record
 * does — one instance, one workspace — but the token is opaque, long-lived, and
 * user-managed: the CLI reads it and sends it, never refreshes or revokes it.
 */
export interface TokenCredential {
  type: "token";
  /** Instance origin the meta API is served from, normalized to a bare origin. */
  instance_base_url: string;
  /** Numeric workspace every command acts on. */
  workspace_id: number;
  /** Bearer token for `/api:meta` routes. */
  meta_api_token: string;
}

/** One profile's credential, discriminated by `type`. */
export type CredentialRecord = OAuthCredential | TokenCredential;

/**
 * The envelope `auth.json` holds. `version` is READ and branched on, unlike the
 * `version` in `.xano/ephemeral.json` which is written and ignored: an ephemeral
 * record is disposable, a credential file is not, and an older CLI that
 * silently rewrote a newer shape would destroy credentials it could not read.
 */
export interface CredentialFile {
  /** Envelope version. A file above {@link CREDENTIAL_FILE_VERSION} refuses to be written. */
  version: number;
  /** Which profile a command acts on when nothing selects one. May name a profile that is gone. */
  default?: string;
  /**
   * Raw, per-profile entries — deliberately UNVALIDATED here.
   *
   * Validation is lazy ({@link readProfile}) so one malformed entry cannot take
   * down commands using the others, and so `xanosdk profile list` — the command
   * someone runs to diagnose exactly that — can render the broken one instead
   * of throwing before it prints anything.
   */
  profiles: Record<string, unknown>;
}

/** The envelope version this build writes, and the ceiling it will overwrite. */
export const CREDENTIAL_FILE_VERSION = 2;

/** An empty v2 envelope — what a write verb creates before any login has run. */
export function emptyCredentialFile(): CredentialFile {
  return { version: CREDENTIAL_FILE_VERSION, profiles: {} };
}

/** The project-local cache path, relative to the project root. */
const DEFAULT_AUTH_FILE = join(".xano", "auth.json");

/**
 * Shared cross-project cache path (the default): `~/.xanosdk/auth.json`.
 * `$XANO_GLOBAL_CONFIG` overrides the location (mainly for tests, mirroring the
 * client store's `$XANO_CLIENT_FILE`).
 */
export function globalAuthFilePath(): string {
  return readPathEnvVar("XANO_GLOBAL_CONFIG") ?? join(homedir(), ".xanosdk", "auth.json");
}

/**
 * The project-local credential path — `<project root>/.xano/auth.json` —
 * resolved absolute. The root is the one `xano.profile.json` is found and
 * written by ({@link pointerRootFor}: the nearest pointer, `package.json` or
 * `.git` at or above the cwd), so from a project subdirectory the pin and the
 * credential it names are read from the same place, and `login --local` writes
 * where the next read looks. Outside every project it is the cwd's, as before.
 */
export function localAuthFilePath(): string {
  return join(pointerRootFor(process.cwd()), DEFAULT_AUTH_FILE);
}

/**
 * Resolve the credential file path. Precedence, highest first:
 *   1. `--config <path>` / `$XANO_CONFIG` — an explicit path wins over both
 *      default files (the environment credential, which reads no file, outranks it).
 *   2. `--local` — the project-local `./.xano/auth.json` cache.
 *   3. the shared `~/.xanosdk/auth.json` global cache (the default).
 *
 * `mode` disambiguates the default (step 3):
 *   • `"write"` (login, logout) always targets the shared global cache — the
 *     common flow is one global sign-in reused from every project. Reach the
 *     project-local cache with an explicit `--local` (step 2).
 *   • `"read"` (read-only commands: deploy, profile reads, token
 *     refresh) still prefers an existing project-local cache and, when it is
 *     absent, falls back to the global one — so a project that ran
 *     `login --local` keeps working without repeating the flag.
 */
export function resolveAuthFilePath(
  args: Pick<ParsedArgs, "authFile" | "local">,
  mode: "read" | "write" = "read",
): string {
  const explicit = expandHome(args.authFile) ?? readPathEnvVar("XANO_CONFIG");
  // Empty resolves to the working directory, and "names a directory (<cwd>)"
  // blamed a directory nobody typed.
  if (explicit !== undefined && explicit.trim() === "") {
    const named = args.authFile !== undefined ? "`--config`" : "XANO_CONFIG";
    throw new UsageError(
      `${named} is empty. It takes the path of a credential file — the JSON file \`xanosdk login\` or ` +
        `\`xanosdk profile add\` writes, e.g. \`.xano/auth.json\`` +
        (args.authFile !== undefined ? ` — or drop it to use the default one.` : ` — or unset XANO_CONFIG.`),
    );
  }
  // `--local` beside a `--config`/XANO_CONFIG naming the project-local file
  // itself is ONE answer spelled twice — nothing is dropped, so it is used.
  if (explicit !== undefined && args.local && resolve(explicit) !== localAuthFilePath()) {
    // Two answers to "which file" — refused rather than resolved: whichever
    // one won, the other was a typed instruction the command dropped, and
    // `login --local --config X` wrote X while saying it used the project cache.
    const named = args.authFile !== undefined ? `\`--config ${explicit}\`` : `XANO_CONFIG=${explicit}`;
    throw new UsageError(
      `\`--local\` selects the project-local .xano/auth.json and ${named} names another credential ` +
        `file — they cannot both be the one this command uses. Drop \`--local\`` +
        (args.authFile !== undefined ? `, or drop \`--config\`.` : `, or unset XANO_CONFIG.`),
    );
  }
  if (explicit !== undefined) {
    const path = resolve(explicit);
    assertCredentialPathUsable(path, args.authFile !== undefined ? `--config ${explicit}` : `XANO_CONFIG=${explicit}`);
    return path;
  }

  const local = localAuthFilePath();
  if (args.local) return local;

  const global = globalAuthFilePath();
  if (mode === "write") return global;

  // Read: prefer a project-local cache that holds something, then fall back to
  // the global one. A local file with NO profiles is read as absent: it can
  // answer nothing, and letting it shadow the shared file turns a machine that
  // is signed in into "no credential profile …" in this one directory. One that
  // will not parse still wins, so its error is reported rather than skipped.
  if (existsSync(local) && !holdsNoProfiles(local)) return local;
  return global;
}

/** A credential path that is a symbolic link resolving back to itself. */
function loopError(path: string): UsageError {
  return new UsageError(
    `The credential file ${path} is a symbolic link that loops back on itself (ELOOP). ` +
      `Point it at a real file, or pass \`--config <file>\`.`,
  );
}

/**
 * A filesystem failure on a credential WRITE path — the lock, the staged file,
 * the rename, the removal — as the usage failure it is, naming the file and
 * what to do. Every other error passes through unchanged.
 */
function credentialWriteFailure(err: unknown, path: string): unknown {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const head = `No credential can be written to ${path}:`;
  const elsewhere = "or pass `--config <file>` somewhere you can write.";
  switch (code) {
    case "EACCES":
    case "EPERM":
      return new UsageError(`${head} ${dirname(path)} is not writable by this user (${code}). Make it writable, ${elsewhere}`);
    case "EROFS":
      return new UsageError(`${head} ${dirname(path)} is on a read-only file system (EROFS). Pass \`--config <file>\` somewhere you can write.`);
    case "ELOOP":
      return loopError(path);
    case "EISDIR":
      return new UsageError(`${head} it is a directory. Remove or rename it, ${elsewhere}`);
    default:
      return err;
  }
}

/**
 * Read a credential file's text, turning a permission failure into what it is:
 * a file this user cannot open, named, with the command that restores access.
 * Never advice to delete it — it may hold every profile on the machine.
 */
/**
 * Whether the credential file is there — `false` only when it is truly absent.
 * `existsSync` also answers `false` when a directory on the way cannot be
 * searched (a `~/.xanosdk` created by a `sudo` run and owned by root), and that
 * read as "no profile stored … run login": a sign-in that then fails to write.
 */
function credentialFileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ELOOP") throw loopError(path);
    if (code !== "EACCES" && code !== "EPERM") return false;
    const dir = dirname(path);
    const quoted = shellQuote(dir);
    throw new Error(
      `Cannot read the credential directory ${dir}: permission denied (${code}). Nothing is lost — ` +
        `this user cannot open it, usually because a command run with sudo created it as root. ` +
        `Restore access with \`sudo chown -R "$(whoami)" ${quoted}\` and \`chmod 700 ${quoted}\`, then retry.`,
      { cause: err },
    );
  }
}

function readCredentialText(path: string): string {
  try {
    // A UTF-8 byte-order mark (Windows editors, PowerShell `Out-File`) is not part of the JSON.
    return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ELOOP") throw loopError(path);
    if (code === "EISDIR") throw new UsageError(`The credential file ${path} is a directory. Remove or rename it, or pass \`--config <file>\`.`);
    if (code !== "EACCES" && code !== "EPERM") throw err;
    const quoted = shellQuote(path);
    throw new Error(
      `Cannot read the credential file ${path}: permission denied (${code}). The file is not corrupt — ` +
        `this user cannot open it. Restore access with \`chmod u+rw ${quoted}\` (if another user owns it: ` +
        `\`sudo chown "$(whoami)" ${quoted}\`), then retry.`,
      { cause: err },
    );
  }
}

/**
 * Refuse an explicit `--config`/`$XANO_CONFIG` path that could never be a
 * credential file — a directory, or an existing file that is not one of ours —
 * as a usage failure, BEFORE anything else runs. Checked at resolution so every
 * command gets it up front: `login` otherwise ran a whole browser sign-in,
 * minted a session, and only then failed on the write (a raw EISDIR, or the
 * overwrite guard), and a read verb reported a raw EISDIR.
 *
 * An absent path passes: `login --config new.json` creates it.
 */
export function assertCredentialPathUsable(path: string, named: string): void {
  const blocker = fileInTheWay(path);
  if (blocker !== undefined) {
    throw new UsageError(
      `\`${named}\` names ${path}, but ${blocker} is a file, not a directory — no credential file can ` +
        `exist below it. Choose a path whose directories are directories, e.g. \`.xano/auth.json\`.`,
    );
  }
  if (isDirectory(path)) {
    throw new UsageError(
      `\`${named}\` names a directory (${path}). It must name a credential file — the JSON file ` +
        `\`xanosdk login\` or \`xanosdk profile add\` writes, e.g. \`.xano/auth.json\`.`,
    );
  }
  const existing = readExistingRaw(path);
  if (existing.absent) return;
  if (!existing.unparseable && isCredentialRecord(existing.value)) return;
  throw new UsageError(
    `\`${named}\` names ${path}, which exists but is not a Xano SDK credential file. Choose a ` +
      `different path — a new one is created on the first \`xanosdk login\` or \`xanosdk profile add\`. ` +
      `If it really is a credential file that has been corrupted beyond recognition, delete it ` +
      `yourself and sign in again.`,
  );
}

/**
 * The nearest existing ancestor of `path` when it is NOT a directory — a
 * regular file standing where a directory has to be — or undefined. `mkdir`
 * would fail on it with ENOTDIR, and an access check on it misreads it as
 * "not writable by this user".
 */
function fileInTheWay(path: string): string | undefined {
  let dir = dirname(resolve(path));
  for (;;) {
    if (existsSync(dir)) return isDirectory(dir) ? undefined : dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A credential file that parses and stores no profile — nothing to lose, nothing to read. */
function holdsNoProfiles(path: string): boolean {
  try {
    const file = readCredentialFile(path);
    return file !== null && profileNames(file).length === 0;
  } catch {
    return false;
  }
}

/**
 * The file a bare command in this directory reads credentials from — no
 * `--config`, no `--local`; `$XANO_CONFIG` still applies. The project's pin and
 * its tracked environments are keyed to profiles in THIS file, so a verb editing
 * some other file (a `--config` copy) must not touch them.
 */
export function projectAuthFilePath(): string {
  return resolveAuthFilePath({ authFile: undefined, local: false }, "read");
}

/**
 * Read the credential envelope. Returns `null` — not a throw — when the file is
 * absent, so callers can emit an actionable "run `xanosdk login`" message rather
 * than surfacing an opaque ENOENT.
 *
 * A legacy bare record is adapted into `{version, default, profiles}` IN MEMORY
 * ONLY. Nothing here writes.
 */
export function readCredentialFile(path: string): CredentialFile | null {
  if (!credentialFileExists(path)) return null;
  if (isDirectory(path)) {
    throw new UsageError(`Credential file at ${path} is a directory, not a file. Remove or rename it, then sign in again.`);
  }
  const text = readCredentialText(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Credential file at ${path} is corrupt (invalid JSON). ${reauthHint(path)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Credential file at ${path} is not a JSON object. ${reauthHint(path)}`);
  }
  const record = parsed as Record<string, unknown>;
  if (isEnvelope(record)) {
    return {
      version: record.version as number,
      default: typeof record.default === "string" ? record.default : undefined,
      profiles: { ...(record.profiles as Record<string, unknown>) },
    };
  }
  // Neither an envelope nor a record of ours (a `package.json`, `{}`): reading it
  // as a legacy profile would blame a missing `type` field on a file that was
  // never a credential at all.
  // A `type` of any kind is left to the per-profile parse, which names an
  // unrecognized one precisely — `--config` paths get the strict check up front.
  if (!isCredentialRecord(record) && typeof record.type !== "string") {
    throw new Error(
      `${path} is not a Xano SDK credential file. If it should be one, delete it and run ` +
        `\`${loginCommand(DEFAULT_PROFILE, { path })}\` again.`,
    );
  }
  // Legacy: one bare record at the top level, read as the `default` profile.
  // No `default` key is synthesized — the file never designated one, and
  // claiming it did would report "this file's default" for a selection nobody
  // made. The implicit rung reaches the same record and says so honestly.
  return { version: CREDENTIAL_FILE_VERSION, profiles: { [DEFAULT_PROFILE]: record } };
}

/** Does this object carry the v2 envelope shape? */
function isEnvelope(record: Record<string, unknown>): boolean {
  return (
    typeof record.version === "number" &&
    typeof record.profiles === "object" &&
    record.profiles !== null &&
    !Array.isArray(record.profiles)
  );
}

/**
 * Validate one profile out of an envelope. `null` — not a throw — when the name
 * is absent, so the caller can list what IS there; a throw only when the entry
 * exists and is malformed, which is a file the user has to fix.
 */
export function readProfile(file: CredentialFile, name: string, path: string): CredentialRecord | null {
  if (!Object.prototype.hasOwnProperty.call(file.profiles, name)) return null;
  try {
    return parseCredential(file.profiles[name], path, name);
  } catch (err) {
    // A profile a NEWER CLI wrote fails this parse for the one reason that
    // matters: its format is past what this CLI knows. Blaming the record
    // ("predates the typed format", "sign in again") sends the reader to a
    // write the version ceiling then refuses.
    if (file.version > CREDENTIAL_FILE_VERSION) {
      throw new Error(
        `${name === DEFAULT_PROFILE ? "The default profile" : `Profile "${name}"`} in the credential file at ` +
          `${path} was written by a newer xanosdk (file version ${file.version}; this CLI understands ` +
          `${CREDENTIAL_FILE_VERSION}) — ${UPGRADE_REMEDY}`,
      );
    }
    throw err;
  }
}

/** How to get a CLI that reads (and may write) a newer credential file. */
export const UPGRADE_REMEDY = "upgrade with `npm install -g @xano/sdk@latest` (or `xanosdk upgrade`) and try again.";

/**
 * Read ONE profile straight from a path — the composition almost every caller
 * wants. `null` when the file is absent or holds no such profile.
 */
export function readCredential(path: string, profile = DEFAULT_PROFILE): CredentialRecord | null {
  const file = readCredentialFile(path);
  return file === null ? null : readProfile(file, profile, path);
}

/** Every profile name in the file, in insertion order. */
export function profileNames(file: CredentialFile): string[] {
  return Object.keys(file.profiles);
}

/**
 * The credential file a tracked record's `credential_file` names — `"shared"`,
 * `"local"` or a path — or null for an older record that names none.
 */
export function recordedCredentialPath(recorded: string | undefined): string | null {
  if (recorded === undefined) return null;
  if (recorded === "shared") return globalAuthFilePath();
  if (recorded === "local") return localAuthFilePath();
  return recorded;
}

/**
 * How a tracked record's `credential_file` names `path`: `"shared"`, `"local"`,
 * or the absolute path — the inverse of {@link recordedCredentialPath}.
 */
export function recordedCredentialFile(path: string): string {
  const abs = resolve(path);
  if (abs === resolve(globalAuthFilePath())) return "shared";
  if (abs === localAuthFilePath()) return "local";
  return abs;
}

/**
 * Whether a tracked record's `profile` is still stored in the file it names —
 * either default file when it names none. Advice only: an unreadable file
 * counts as holding it, so the remedy stays the one it always was. Status's
 * Environment and Deployed rows both ask it, so they cannot disagree about
 * whether `--profile <it>` or a sign-in is the fix.
 */
export function recordedProfileStored(profile: string, recorded: string | undefined): boolean {
  const file = recordedCredentialPath(recorded);
  for (const path of file === null ? [globalAuthFilePath(), localAuthFilePath()] : [file]) {
    try {
      const read = readCredentialFile(path);
      if (read !== null && profileNames(read).includes(profile)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * One profile as `profile list` needs it: parsed, or the reason it would not
 * parse. Never throws — the command that diagnoses a broken file must render it.
 */
export function describeProfile(
  file: CredentialFile,
  name: string,
  path: string,
): { name: string; record: CredentialRecord } | { name: string; error: string } {
  try {
    // Callers iterate `profileNames`, so the name is present by construction and
    // only a PARSE failure can land in the error arm.
    return { name, record: readProfile(file, name, path)! };
  } catch (err) {
    return { name, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Is this parsed value a Xano SDK credential file — including a stale one?
 *
 * Used only by the write/delete guards, which answer "is this file OURS", not
 * "is this file valid". A pre-typed record (no `type`, but the old
 * `access_token` + `instance` shape) is ours: `login` must be able to overwrite
 * it and `logout` to delete it, or the format break would strand users needing a
 * manual `rm`. Reading it still fails loudly — see `parseCredential`.
 */
function isCredentialRecord(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const record = v as Record<string, unknown>;
  // The profile envelope. BOTH keys are required: the guard exists to stop a
  // mis-typed `--config` from clobbering an unrelated file, and a lone
  // `profiles` key is not distinctive enough to carry that weight. A v2 file
  // whose only profile is invalid is still ours, and still repairable.
  if (isEnvelope(record)) return true;
  if (record.type === "oauth" || record.type === "token") return true;
  // Legacy (pre-`type`) OAuth cache.
  return typeof record.access_token === "string" && typeof record.instance === "string";
}

/** Validate a parsed value into a credential, or throw naming the exact problem. */
function parseCredential(v: unknown, path: string, profile = DEFAULT_PROFILE): CredentialRecord {
  const where = `${profile === DEFAULT_PROFILE ? "" : `Profile "${profile}" in the `}credential file at ${path}`;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`${where} is not a JSON object. ${replaceHint(path, profile)}`);
  }
  const record = v as Record<string, unknown>;
  const type = record.type;

  if (type === undefined) {
    throw new Error(
      `${where} has no \`type\` field — it predates the typed credential ` +
        `format. Run ${loginHint(profile, { path })} again to replace it.`,
    );
  }
  if (type === "oauth") return parseOAuth(record, path, profile);
  if (type === "token") return parseToken(record, path, profile);
  throw new Error(
    `${where} has an unrecognized \`type\` (${JSON.stringify(type)}). ` +
      `Expected "oauth" or "token".`,
  );
}

/** Where a message points when a field is wrong — the profile, unless it is the default. */
function whereIn(kind: string, path: string, profile: string): string {
  const suffix = profile === DEFAULT_PROFILE ? "" : ` (profile "${profile}")`;
  return `in the "${kind}" credential at ${path}${suffix}`;
}

/**
 * "Delete it and sign in again", naming the sign-in that writes THIS file and
 * profile — a bare `xanosdk login` writes the shared file's default profile.
 */
function reauthHint(path: string, profile = DEFAULT_PROFILE): string {
  return `Delete it and run \`${loginCommand(profile, { path })}\` again.`;
}

/**
 * The fix for ONE malformed profile in an otherwise readable file: signing it
 * in again replaces just that entry. "Delete it" there read as deleting the
 * file, and with it every other profile stored beside the broken one.
 */
function replaceHint(path: string, profile: string): string {
  return `Run \`${loginCommand(profile, { path })}\` to replace it.`;
}

/**
 * How to re-run `login` for one profile. The default profile omits the flag:
 * telling someone to type `--profile default` for the selection they already
 * have is noise, and noise in a remedy is what stops it being followed.
 */
export function loginHint(profile: string, target: SignInTarget = {}): string {
  return `\`${loginCommand(profile, target)}\``;
}

/**
 * Where a printed sign-in remedy has to sign in to, beyond the profile: the
 * credential FILE the failing command read, and the sign-in server the profile
 * was minted at. A remedy that drops either signs into the wrong place — a bare
 * `xanosdk login` writes the shared file, not the `--config` copy that failed,
 * and signs in at the default server, not the one this profile came from.
 */
export interface SignInTarget {
  /** The credential file the remedy must write — omitted for the machine's shared one. */
  path?: string;
  /** The sign-in server — omitted for the default one. */
  origin?: string;
}

/**
 * The flag that makes a later command use `path`: none for the machine's shared
 * file (every command's default write target), `--local` for this directory's
 * project-local cache, else `--config <path>` shell-quoted.
 *
 * Under `$XANO_CONFIG` a bare command reads THAT file, pasted into the same
 * shell: its own path takes no flag (as contextFlags leaves it out), and every
 * other file — the shared and project-local ones too — needs `--config`, the
 * one flag that outranks the variable (`--local` beside it is refused).
 */
export function credentialFileFlag(path: string | undefined): string {
  if (path === undefined) return "";
  const abs = resolve(path);
  const byEnv = readPathEnvVar("XANO_CONFIG");
  if (byEnv !== undefined && byEnv.trim() !== "") {
    return abs === resolve(byEnv) ? "" : ` --config ${shellQuote(abs)}`;
  }
  if (abs === resolve(globalAuthFilePath())) return "";
  if (abs === localAuthFilePath()) return " --local";
  return ` --config ${shellQuote(abs)}`;
}

/**
 * The unquoted `xanosdk login …` that signs `profile` in again where `target`
 * says, with any trailing flags (`--force`, `--paste`). The default profile
 * omits `--profile`; the default sign-in server omits `--origin`.
 */
export function loginCommand(profile: string, target: SignInTarget = {}, extra: readonly string[] = []): string {
  const name =
    profile === DEFAULT_PROFILE && bareLoginReaches(target.path) === DEFAULT_PROFILE
      ? ""
      : ` --profile ${shellQuote(profile)}`;
  const origin =
    target.origin === undefined || sameOriginAs(target.origin, DEFAULT_AUTH_HOST)
      ? ""
      : ` --origin ${shellQuote(originOnly(target.origin))}`;
  return `xanosdk login${name}${credentialFileFlag(target.path)}${origin}${extra.map((f) => ` ${f}`).join("")}`;
}

/**
 * The profile a flagless `xanosdk login` writing `path` would sign in as — the
 * ladder `login` itself resolves: this project's pin, `$XANO_PROFILE`, then the
 * file's own `default`. Omitting `--profile default` is only honest when that
 * ladder lands on "default"; in a file whose default is "ghost", a bare remedy
 * re-signs "ghost" and never creates the profile it was printed for.
 *
 * Never throws: a remedy must not fail on its own advice. An unreadable file
 * or an invalid name keeps the flag, which is always correct.
 */
function bareLoginReaches(path: string | undefined): string | undefined {
  let fileDefault: string | undefined;
  try {
    fileDefault = readCredentialFile(path ?? globalAuthFilePath())?.default;
  } catch {
    // Unreadable: `login` reads no default from it either — see resolveLoginProfile.
  }
  try {
    return resolveActiveProfile({ fileDefault, readPointer: () => resolveProjectProfile(process.cwd()) }).name;
  } catch {
    return undefined;
  }
}

function originOnly(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function sameOriginAs(a: string, b: string): boolean {
  return originOnly(a) === originOnly(b);
}

/**
 * How to CREATE a missing profile, by either credential: an OAuth sign-in, or a
 * meta API token stored with `profile add`. A missing name says nothing about
 * which kind the user runs on, so naming only `login` sends a token user to a
 * browser flow they never use.
 */
export function addProfileHint(profile: string, target: ProfileTarget = {}): string {
  return `${loginHint(profile, target)} (OAuth), or \`${profileAddCommand(profile, target)}\` (meta API token)`;
}

/**
 * Where a profile to (re)create lives, beyond {@link SignInTarget}: the instance
 * and workspace a tracked record says it deployed to — filled into the
 * `profile add` remedy in place of its placeholders when known.
 */
export interface ProfileTarget extends SignInTarget {
  instance?: string;
  workspaceId?: number | string;
}

/** The unquoted `xanosdk profile add …` that stores a meta API token for `profile` where `target` says. */
export function profileAddCommand(profile: string, target: ProfileTarget = {}): string {
  const instance = target.instance !== undefined ? shellQuote(originOnly(target.instance)) : "<url>";
  const workspace = target.workspaceId !== undefined ? String(target.workspaceId) : "<id>";
  return `xanosdk profile add ${shellQuote(profile)}${credentialFileFlag(target.path)} --instance ${instance} --workspace-id ${workspace}`;
}

function parseOAuth(record: Record<string, unknown>, path: string, profile: string): OAuthCredential {
  const at = whereIn("oauth", path, profile);
  if (typeof record.access_token !== "string" || record.access_token === "") {
    throw new Error(`Missing \`access_token\` ${at}. ${replaceHint(path, profile)}`);
  }
  if (typeof record.instance !== "string" || record.instance === "") {
    throw new Error(`Missing \`instance\` ${at}. ${replaceHint(path, profile)}`);
  }
  if (record.workspace_id === undefined) {
    throw new Error(
      `Missing \`workspace_id\` ${at} — it predates workspace pinning at login. ${replaceHint(path, profile)}`,
    );
  }
  // `login` always writes both, and a refresh cannot be attempted without them —
  // an empty default here would surface much later as an unintelligible URL
  // error instead of "your credential is broken, sign in again".
  if (typeof record.auth_host !== "string" || record.auth_host === "") {
    throw new Error(`Missing \`auth_host\` ${at}. ${replaceHint(path, profile)}`);
  }
  if (typeof record.client_id !== "string" || record.client_id === "") {
    throw new Error(`Missing \`client_id\` ${at}. ${replaceHint(path, profile)}`);
  }
  registerSecret(record.access_token);
  registerSecret(record.refresh_token);
  for (const field of ["access_token", "refresh_token"] as const) {
    const value = record[field];
    const problem = typeof value === "string" ? tokenTextProblem(value) : undefined;
    if (problem !== undefined) {
      throw new UsageError(`\`${field}\` ${at} ${problem}, which no request can carry. ${replaceHint(path, profile)}`);
    }
  }
  return {
    type: "oauth",
    access_token: record.access_token,
    refresh_token: typeof record.refresh_token === "string" ? record.refresh_token : undefined,
    // A missing expiry reads as "already expired", which triggers a refresh
    // rather than handing out a token we cannot vouch for.
    expires_at: typeof record.expires_at === "number" ? record.expires_at : 0,
    scope: typeof record.scope === "string" ? record.scope : undefined,
    instance: record.instance,
    workspace_id: requireWorkspaceId(record.workspace_id, at),
    auth_host: record.auth_host,
    client_id: record.client_id,
  };
}

function parseToken(record: Record<string, unknown>, path: string, profile: string): TokenCredential {
  return buildTokenCredential(
    {
      instance: record.instance_base_url,
      workspaceId: record.workspace_id,
      token: record.meta_api_token,
    },
    {
      at: whereIn("token", path, profile),
      labels: {
        instance: "instance_base_url",
        workspace: "workspace_id",
        token: "meta_api_token",
      },
      fix: `Edit \`meta_api_token\` in ${path} to hold the token alone, on one line.`,
    },
  );
}

/** What to call each field, and where it came from, when a value is rejected. */
export interface TokenCredentialSource {
  /** Trailing context for every message, e.g. `in the environment`. */
  at: string;
  /** The name a reader would recognize — a JSON field, or an env var. */
  labels: { instance: string; workspace: string; token: string };
  /** How to supply a well-formed token from this source, when a malformed one is refused. */
  fix?: string;
}

/**
 * Validate the three values a meta credential is made of, whatever carried them.
 *
 * One validator for two sources: the `"token"` record in `auth.json` and the
 * `$XANO_INSTANCE_URL`/`$XANO_WORKSPACE_ID`/`$XANO_META_TOKEN` triple CI sets.
 * Both bind a command to one `(instance, workspace)`, so both must enforce the
 * same rules — a workspace id that is a positive integer HERE and a loose
 * numeric string THERE is how a typo'd secret addresses the wrong workspace.
 *
 * `workspaceId` is `unknown` on purpose: an env caller parses its own string to
 * a number FIRST and passes the original through on failure, so the rejection
 * message quotes what the user actually wrote instead of `NaN`.
 */
export function buildTokenCredential(
  values: { instance: unknown; workspaceId: unknown; token: unknown },
  source: TokenCredentialSource,
): TokenCredential {
  const { at, labels } = source;
  const raw = values.instance;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(
      `Missing \`${labels.instance}\` ${at}. It must be the instance URL, ` +
        `e.g. "https://your-instance.xano.io".`,
    );
  }
  let origin: string;
  try {
    origin = new URL(raw.trim()).origin;
  } catch {
    throw new Error(
      `\`${labels.instance}\` ${at} is not a valid URL ("${raw}"), ` +
        `e.g. "https://your-instance.xano.io".`,
    );
  }
  // The token is about to be sent to this origin (verified, then used on every
  // call), so plain http off loopback is refused HERE — before any request —
  // for every source that builds a token credential, not only at resolve time.
  assertHttpsOrigin(raw.trim(), `\`${labels.instance}\` ${at}`);
  const token = values.token;
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error(`Missing \`${labels.token}\` ${at}. It must be a meta API bearer token.`);
  }
  registerSecret(token);
  const problem = tokenTextProblem(token.trim());
  if (problem !== undefined) {
    // Named by source and position, never quoted: the value is a secret.
    throw new UsageError(
      `${labels.token.includes(" ") ? labels.token[0]!.toUpperCase() + labels.token.slice(1) : `\`${labels.token}\``} ${at} ${problem}, which no request can carry. ` +
        (source.fix ?? `Set it to the meta API token alone — one line, nothing else.`),
    );
  }
  if (values.workspaceId === undefined) {
    throw new Error(`Missing \`${labels.workspace}\` ${at}. It must be the numeric workspace id.`);
  }
  return {
    type: "token",
    instance_base_url: origin,
    workspace_id: requireWorkspaceId(values.workspaceId, at, labels.workspace),
    // A pasted token routinely carries stray whitespace or a newline.
    meta_api_token: token.trim(),
  };
}

/** Whether `text` is a run of digits that parses to an exact number — `9007199254740993` does not. */
export function isSafeIdText(text: string): boolean {
  return /^\d+$/.test(text.trim()) && Number.isSafeInteger(Number(text.trim()));
}

/** A workspace id is a positive integer — never a numeric string, zero, or a float. */
function requireWorkspaceId(value: unknown, at: string, label = "workspace_id"): number {
  if (
    (typeof value === "string" && /^\d+$/.test(value.trim())) ||
    (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value))
  ) {
    throw new UsageError(
      `\`${label}\` ${at} is out of range (got ${typeof value === "string" ? value.trim() : JSON.stringify(value)}) — ` +
        `a workspace id is a positive integer no larger than ${Number.MAX_SAFE_INTEGER}.`,
    );
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new UsageError(`\`${label}\` ${at} must be a positive integer (got ${JSON.stringify(value)}).`);
  }
  return value;
}

/**
 * Atomically write the credential envelope with owner-only permissions. Content
 * is staged in a per-pid temp file (created mode 0600) and renamed into place,
 * so a crash never leaves a half-written or world-readable credential file.
 *
 * Callers that change ONE profile must hold the write lock and re-read inside
 * it — see `withCredentialLock` — because this replaces the whole file.
 */
export function writeCredentialFile(path: string, file: CredentialFile): void {
  // ONE read for both guards: they ask different questions of the same bytes,
  // and this runs inside the lock every concurrent deploy waits on.
  const existing = readExistingRaw(path);
  // Guard against an `--config` typo clobbering an unrelated file (e.g.
  // package.json): if the target already exists, it must already be a Xano SDK
  // credential before we overwrite it.
  assertOursIfPresent(existing, path, "overwrite");
  assertWritableVersion(existing, path);
  const body: CredentialFile = {
    version: CREDENTIAL_FILE_VERSION,
    ...(file.default === undefined ? {} : { default: file.default }),
    profiles: file.profiles,
    ...unknownTopLevelKeys(existing),
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    atomicWrite(path, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    throw credentialWriteFailure(err, path);
  }
}

/**
 * Refuse to downgrade a file a NEWER CLI wrote. Its shape is unknown here, and
 * rewriting it as v2 would silently drop whatever that version added — for a
 * file whose whole content is credentials that cannot be reconstructed.
 */
/**
 * The version ceiling, checkable before doing expensive work. `login` calls it
 * ahead of consent so a file it cannot write fails immediately rather than
 * after a browser round trip that mints a credential it must then discard.
 */
export function assertCredentialFileWritable(path: string): void {
  if (isDirectory(path)) {
    throw new UsageError(`${path} is a directory, so no credential can be written there. Remove or rename it, or pass \`--config <file>\`.`);
  }
  const existing = readExistingRaw(path);
  // The same guard the write applies, asked BEFORE consent: a file the write
  // would refuse to overwrite must not cost a sign-in and a minted session.
  assertOursIfPresent(existing, path, "overwrite");
  assertWritableVersion(existing, path);
  // The write and the lock follow a symlink to the file it names, so the
  // directory that must be writable — and the lock beside the file — are the
  // TARGET's, even when the link dangles.
  const target = linkTarget(path);
  assertDirectoryWritable(target);
  assertLockPathUsable(target);
}

/**
 * Can this process create `path`'s lock and rename a new file over it? Both ask
 * the DIRECTORY — the write stages a temp file beside the target and renames it
 * into place — so the directory (or, when it does not exist yet, the nearest
 * one that does, where `mkdir` will create it) is what must be writable.
 * Without this a read-only `--config` directory failed with a raw EACCES only
 * after a whole browser round trip.
 */
function assertDirectoryWritable(path: string): void {
  // A regular file where a directory has to be is not a permission problem:
  // "not writable by this user" sent the reader to chmod a file.
  const blocker = fileInTheWay(path);
  if (blocker !== undefined) {
    throw new UsageError(
      `No credential can be written to ${path}: ${blocker} is a file, not a directory. ` +
        `Pass \`--config <file>\` with a path whose directories are directories.`,
    );
  }
  let dir = dirname(path);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
  try {
    accessSync(dir, fsConstants.W_OK | fsConstants.X_OK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "EROFS") {
      throw new UsageError(`No credential can be written to ${path}: ${dir} is on a read-only file system (EROFS). Pass \`--config <file>\` somewhere you can write.`);
    }
    throw new UsageError(
      `No credential can be written to ${path}: ${dir} is not writable by this user. ` +
        `Make it writable, or pass \`--config <file>\` somewhere you can write.`,
    );
  }
}

function assertWritableVersion(
  existing: RawFile,
  path: string,
  verb: "overwrite" | "delete" | "change" = "overwrite",
): void {
  if (existing.absent || existing.unparseable) return; // Unparseable: assertOursIfPresent's problem.
  const version = (existing.value as Record<string, unknown> | null)?.version;
  if (typeof version === "number" && version > CREDENTIAL_FILE_VERSION) {
    throw new Error(
      `Credential file at ${path} is version ${version}, newer than this CLI understands ` +
        `(${CREDENTIAL_FILE_VERSION}). Refusing to ${verb} it — ${UPGRADE_REMEDY}`,
    );
  }
}

/**
 * Both delete guards, on ONE read: the file must be ours, and not one a newer
 * CLI wrote — removing a v99 file loses credentials this CLI cannot even read,
 * exactly as overwriting it would.
 */
export function assertCredentialFileRemovable(path: string): void {
  const existing = readExistingRaw(path);
  assertOursIfPresent(existing, path, "delete");
  assertWritableVersion(existing, path, "delete");
}

/**
 * Refuse to touch a file that exists but isn't one of ours, so a `--config`
 * typo can't clobber or `rm` an unrelated file. Deliberately checks only the
 * discriminator: a credential that fails full validation is still OURS, and
 * must stay overwritable (by `login`) and deletable (by `logout`) — otherwise a
 * stale pre-typed record would be unrecoverable without a manual `rm`.
 */
/** The target file as the write guards need it: absent, unparseable, or a value. */
interface RawFile {
  absent: boolean;
  unparseable: boolean;
  value: unknown;
}

/**
 * The top-level keys of an existing envelope this build does not know, kept
 * across a write: a newer CLI (or a tool beside this one) may store more than
 * `version`, `default` and `profiles`, and rewriting one profile must not drop
 * it. A legacy bare record has no envelope, so nothing at its top level is kept.
 */
function unknownTopLevelKeys(existing: RawFile): Record<string, unknown> {
  const value = existing.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  if (!isEnvelope(record)) return {};
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== "version" && key !== "default" && key !== "profiles"));
}

/** Read and parse the target once, for the guards that both interrogate it. */
function readExistingRaw(path: string): RawFile {
  // Not existsSync: it answers false for a symlink loop, which then read as
  // "absent" and let `login` reach consent for a file it cannot write.
  if (!credentialFileExists(path)) return { absent: true, unparseable: false, value: undefined };
  // A file this user cannot open is not a file that is not ours: the read
  // failure is reported as itself, never as "not a credential file".
  const text = readCredentialText(path);
  try {
    return { absent: false, unparseable: false, value: JSON.parse(text) };
  } catch {
    return { absent: false, unparseable: true, value: undefined };
  }
}

function assertOursIfPresent(existing: RawFile, path: string, verb: "overwrite" | "delete"): void {
  if (existing.absent) return;
  // Unparseable: we can't prove it's ours, so treat it as someone else's.
  if (!existing.unparseable && isCredentialRecord(existing.value)) return;
  {
    throw new Error(
      `Refusing to ${verb} ${path}: it exists but is not a Xano SDK credential file. ` +
        `Choose a different --config/$XANO_CONFIG path — or, if this really is a credential ` +
        `file that has been corrupted beyond recognition, delete it yourself and run ` +
        `\`${loginCommand(DEFAULT_PROFILE, { path })}\` again.`,
    );
  }
}

/**
 * Cross-process lock options for every read-modify-write of the credential file.
 * A second writer WAITS rather than racing: the file now holds N profiles and
 * each writer replaces exactly one, so a writer that persisted a snapshot taken
 * before another's refresh would write back a SPENT rotating refresh token for a
 * profile it never touched — permanently unusable, with no error at the moment
 * of damage.
 */
const CREDENTIAL_LOCK_OPTS = {
  // The retry budget deliberately EXCEEDS `stale`: a writer killed mid-write
  // leaves a lock that only goes stale at 20s, and a budget shorter than that
  // would fail the next command with a raw ELOCKED for a process that no longer
  // exists. ~60s of retries against a 20s stale window means the common crash
  // recovers by waiting rather than by the user deleting a lock directory.
  retries: { retries: 60, factor: 1.3, minTimeout: 50, maxTimeout: 1_000 },
  stale: 20_000,
};

/**
 * Run `fn` holding the credential file's advisory lock, handing it the file as
 * RE-READ inside the lock. Every writer goes through here, and no writer may
 * write a snapshot it read before acquiring the lock.
 *
 * `proper-lockfile` locks a path that must exist, so an empty envelope is
 * created first when a write verb runs before any login.
 */
export async function withCredentialLock<T>(
  path: string,
  fn: (file: CredentialFile) => Promise<T> | T,
): Promise<T> {
  // Through a symlink to the file it names: a link whose target does not exist
  // yet (dotfiles linked before the first sign-in) gets that target created,
  // and the lock is taken on it.
  const target = linkTarget(path);
  // The lock is a directory created beside the file: a directory this user
  // cannot write fails every writer here, named, before anything is changed.
  assertDirectoryWritable(target);
  let created: boolean;
  let release: () => Promise<void>;
  try {
    mkdirSync(dirname(target), { recursive: true });
    created = bootstrapEnvelope(target);
  } catch (err) {
    throw credentialWriteFailure(err, path);
  }
  try {
    release = await acquireCredentialLock(target);
  } catch (err) {
    if (created && holdsNoProfiles(target)) rmSync(target, { force: true });
    throw credentialWriteFailure(err, path);
  }
  try {
    // Every writer comes through here, and none may change a file a newer CLI
    // wrote. Asked FIRST, before `fn` revokes a session or refreshes a rotating
    // token it could then never persist.
    assertWritableVersion(readExistingRaw(path), path, "change");
    return await fn(readCredentialFile(path) ?? emptyCredentialFile());
  } catch (err) {
    // A file we created for the lock, on a run that then failed, must not
    // survive: an empty envelope at the project-local path SHADOWS a working
    // global credential (read resolution prefers a local file that exists), so
    // a typo'd `profile set-default --local` would otherwise brick the project
    // in a way `login` cannot repair.
    if (created && holdsNoProfiles(target)) rmSync(target, { force: true });
    throw err;
  } finally {
    await release();
  }
}

/**
 * Create the lock target when it is absent. `proper-lockfile` locks a path that
 * must exist, so a write verb running before any login needs one.
 *
 * EXCLUSIVE create, not existsSync-then-write: two processes that both see the
 * file missing would otherwise both write an empty envelope, and the loser's
 * write lands AFTER the winner has already committed a real profile under the
 * lock — truncating it. `wx` makes the loser a no-op.
 *
 * Returns whether THIS call created the file.
 */
function bootstrapEnvelope(path: string): boolean {
  try {
    writeFileSync(path, JSON.stringify(emptyCredentialFile(), null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Take the lock, or explain what is holding it. `proper-lockfile` reports a bare
 * `ELOCKED` naming nothing, which for a credential file reads as an unrelated
 * failure — the reader needs to know another xanosdk run has it, and what to
 * remove if none is running.
 */
async function acquireCredentialLock(path: string): Promise<() => Promise<void>> {
  assertLockPathUsable(path);
  try {
    return await lockfile.lock(path, CREDENTIAL_LOCK_OPTS);
  } catch (err) {
    if ((err as { code?: string }).code !== "ELOCKED") throw err;
    throw new Error(
      `Timed out waiting for the credential file lock on ${path}. Another \`xanosdk\` command is ` +
        `writing it — wait for that one to finish and re-run. If no other run is in progress, a ` +
        `previous one was killed mid-write: remove ${path}.lock and try again.`,
    );
  }
}

/**
 * The lock is a DIRECTORY beside the file. Anything else standing at that path
 * never goes stale and is never removed by the lock library, so a writer waited
 * out its whole retry budget and then failed on a raw ENOTDIR.
 */
function assertLockPathUsable(path: string): void {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // The lock library resolves the same path; a failure here is its to report.
  }
  const lock = `${real}.lock`;
  let isDir: boolean;
  try {
    isDir = lstatSync(lock).isDirectory();
  } catch {
    return;
  }
  if (!isDir) {
    throw new UsageError(
      `The credential file lock ${lock} is not a directory, so no \`xanosdk\` run can take it. If no ` +
        `other \`xanosdk\` command is running, remove it (\`rm ${shellQuote(lock)}\`) and try again.`,
    );
  }
}

/**
 * Delete the credential file (logout). Returns true when a file was removed,
 * false when there was nothing to remove. Refuses to delete a file that isn't a
 * xanosdk credential, so a `--config` typo can't `rm` an unrelated file.
 */
export function clearCredential(path: string): boolean {
  if (!credentialFileExists(path)) return false;
  assertCredentialFileRemovable(path);
  removeCredentialFile(path);
  return true;
}

/** Remove the credential file, a filesystem failure named as {@link credentialWriteFailure} does. */
function removeCredentialFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch (err) {
    throw credentialWriteFailure(err, path);
  }
}

/**
 * {@link clearCredential} holding the write lock, and re-reading inside it.
 *
 * Every other writer takes the lock; an UNLOCKED delete is the one gap that
 * lets a concurrent token refresh — which writes back the whole profile map it
 * read under the lock — recreate the file after the delete, resurrecting
 * profiles whose sessions were just revoked. `fn` runs on the locked snapshot
 * so a caller can revoke from what is provably about to be removed.
 */
export async function clearCredentialUnderLock(
  path: string,
  fn?: (file: CredentialFile) => Promise<void> | void,
): Promise<boolean> {
  if (!credentialFileExists(path)) return false;
  return withCredentialLock(path, async (file) => {
    // BEFORE `fn`: callers revoke sessions from this snapshot, and a file this
    // run then refuses to remove must not have lost its sessions first.
    assertCredentialFileRemovable(path);
    await fn?.(file);
    removeCredentialFile(path);
    return true;
  });
}

/**
 * Persist `file` after a profile was removed from it, or remove the file when
 * that was the last one. Call it holding the lock, on the snapshot read there.
 *
 * An envelope with no profiles is worse than no file: "the credential file
 * exists" was the pre-profiles test for "am I signed in", and at the
 * project-local path an empty one used to shadow a working global credential.
 * Every verb that removes a profile — `logout`, `profile delete`, a refresh the
 * server rejected — goes through here so the last one out takes the file.
 *
 * Returns whether the file was removed.
 */
export function writeOrRemoveCredentialFile(path: string, file: CredentialFile): boolean {
  if (profileNames(file).length > 0) {
    writeCredentialFile(path, file);
    return false;
  }
  assertCredentialFileRemovable(path);
  removeCredentialFile(path);
  return true;
}

/**
 * After the project-local credential file was removed, remove the `.xano/`
 * directory it sat in — only when nothing else is left in it. `login --local`
 * created it for the credential alone; left behind empty, it reads as a
 * project cache that still holds something. Never touches any other directory
 * (a `--config` file's parent is the user's), and never a non-empty one: the
 * same directory holds tracked ephemerals and engine state. Call it AFTER the
 * write lock is released — the lock lives beside the file.
 *
 * Returns whether the directory was removed.
 */
export function removeEmptyProjectCacheDir(path: string): boolean {
  if (resolve(path) !== localAuthFilePath() || existsSync(path)) return false;
  try {
    rmdirSync(dirname(localAuthFilePath()));
    return true;
  } catch {
    // ENOTEMPTY (something else lives there) or already gone: nothing to do.
    return false;
  }
}

/**
 * Drop one profile from an envelope, clearing a `default` key left dangling by
 * it. An envelope invariant, so it lives HERE rather than in the three command
 * modules that delete a profile — a dangling default makes the next command
 * fail on a name the user deliberately removed.
 *
 * Mutates and returns the file so a caller already inside the lock can write it.
 */
export function dropProfile(file: CredentialFile, name: string): CredentialFile {
  delete file.profiles[name];
  if (file.default === name) delete file.default;
  return file;
}


/**
 * Is `path` inside a git working tree? A credential outside every repository
 * has nothing that could commit it, so a credential write skips the ignore rule
 * there rather than creating a `.gitignore` in whatever the cwd happens to be.
 */
export function insideGitRepo(path: string): boolean {
  return findGitRoot(dirname(resolve(path))) !== undefined;
}

/** Walk up from `startDir` to the nearest directory containing a `.git` entry. */
function findGitRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Ensure the credential file is ignored by git. Appends an entry to the project's
 * `.gitignore` (creating it if absent) when no existing rule already covers the
 * file. Idempotent. Returns true when `.gitignore` was modified.
 *
 * The entry is the containing directory only when that directory is the
 * dedicated `.xano/` cache below the git root; any other file is ignored by its
 * own path — so `.xano/` is ignored wholesale while a custom `--config` anywhere
 * (`src/creds.json`, `sub/mycreds.json`) ignores just that file, never the
 * directory it happens to sit in. A credential outside the repo tree (e.g. under $HOME) is left
 * alone: there is nothing to gitignore.
 */
export function ensureGitignored(
  authFilePath: string,
  opts: { fileOnly?: boolean; root?: string } = {},
): boolean {
  return addGitignoreRule(authFilePath, opts) !== undefined;
}

/**
 * The directory whose `.gitignore` {@link addGitignoreRule} writes for `path`:
 * the enclosing repository's root, else the caller's project root, else the
 * working directory. Exported so a line reporting the rule can name that file.
 */
export function gitignoreRootFor(path: string, opts: { root?: string } = {}): string {
  return findGitRoot(dirname(resolve(path))) ?? opts.root ?? process.cwd();
}

/**
 * {@link ensureGitignored}, answering with the rule it wrote — `undefined` when
 * it wrote none. For a line that says what it added: a root-level file's rule
 * is `/out.json`, not the `out.json` a label would print (E2E pass 27).
 */
export function addGitignoreRule(
  authFilePath: string,
  opts: { fileOnly?: boolean; root?: string } = {},
): string | undefined {
  const abs = resolve(authFilePath);
  // `opts.root` is the PROJECT root for a caller that knows it. Without one,
  // the cwd fallback wrote into a `.gitignore` OUTSIDE the directory being
  // scaffolded — `xanosdk init myapp` in a non-repo cwd created `./.gitignore`
  // holding `myapp/xano/.env`, and in a dotfiles $HOME it edited the user's own
  // repo, reporting only "Added xano/.env to .gitignore".
  const root = gitignoreRootFor(abs, opts);

  // A cache outside the repo (or outside $HOME-anchored trees) needs no ignore.
  const rel = relative(root, abs);
  if (rel.startsWith("..")) return undefined;

  const containingDir = dirname(abs);
  // The directory form is refused for anything under the backend directory, on
  // EVERY caller — not just the ones that remember to pass `fileOnly`. Ignoring
  // `xano/` un-commits the entire generated backend, and it does so silently:
  // files already committed stay tracked, so nothing looks broken until a later
  // pull's new files never appear in `git status`.
  const insideBackend = relForwardSlash(root, containingDir).split("/").includes(XANO_DIR);
  // Only the dedicated `.xano/` directory is ignored whole. A `--config` file
  // below the root sits in the user's OWN directory — `src/`, a package — and
  // ignoring that directory un-commits everything else in it.
  const dedicatedDir = basename(containingDir) === DEDICATED_DIR;
  const fileEntry = relForwardSlash(root, abs);
  const entry =
    opts.fileOnly === true || insideBackend || containingDir === root || !dedicatedDir
      ? // This file, and nothing around it. A root-level name is anchored with a
        // leading slash: a pattern with no slash in it matches at ANY depth, so
        // `out.json` also ignored every `out.json` in every subdirectory (E2E
        // pass 26). One with a slash inside is anchored already.
        fileEntry.includes("/")
        ? fileEntry
        : `/${fileEntry}`
      : relForwardSlash(root, containingDir) + "/"; // dedicated dir → ignore the dir

  const gitignorePath = join(root, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  // The line check FIRST: it is free, the bytes are already in hand, and it
  // answers the common case (the exact rule is already there). The subprocess
  // then runs only for the case it was added for — a rule that covers this path
  // without spelling it, which line comparison cannot see.
  // An unanchored rule an earlier version wrote (`out.json`) covers the anchored one.
  if (ignoreCovers(existing, entry) || ignoreCovers(existing, fileEntry) || gitIgnores(abs)) return undefined;

  const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : existing + "\n";
  writeFileSync(gitignorePath, `${prefix}${entry}\n`, "utf8");
  return entry;
}

/**
 * Does git ALREADY ignore this path, by whatever rule?
 *
 * {@link ignoreCovers} compares trimmed lines for exact equality, which cannot
 * see that a bare `.env` line ignores `xano/.env` at depth — so on its own it
 * would append a redundant rule to every scaffolded project on every init, pull
 * and `env pull`, churning a committed file. Git is the only thing that can
 * answer the question it is actually being asked.
 *
 * Three answers collapsed to two on purpose: "not ignored" and "cannot tell"
 * both fall through to the line comparison, which is the conservative direction
 * — a redundant rule is noise, a missing one is a committed secret.
 */
function gitIgnores(abs: string): boolean {
  return gitSaysIgnored(abs) === true;
}

/**
 * Ask git whether it ignores `abs`: true, false, or undefined when it cannot be
 * asked at all (no git, not a repo, a probe that timed out).
 *
 * The three answers are kept distinct HERE because callers need different
 * things from them. {@link ensureGitignored} collapses "no" and "cannot tell"
 * into "write the rule", the conservative direction. A caller about to write a
 * secret needs the distinction: a definite "no" after the rule was added is a
 * refusal, while "cannot tell" is not.
 */
export function gitSaysIgnored(abs: string): boolean | undefined {
  const root = findGitRoot(dirname(resolve(abs)));
  if (root === undefined) return undefined;
  try {
    execFileSync("git", ["check-ignore", "-q", "--", abs], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
      // Bounded: `execFileSync` with no timeout blocks forever on a git that
      // hangs or stops to prompt. A timeout reads as "cannot tell", which falls
      // through to the line comparison — the conservative direction.
      timeout: 5_000,
    });
    return true;
  } catch (err) {
    // Exit 1 is git's "not ignored" — a real answer. Anything else (git absent,
    // the probe killed by its own timeout, a corrupt repo) is no answer at all.
    const status = (err as { status?: unknown }).status;
    return status === 1 ? false : undefined;
  }
}

/** Path of `target` relative to `root`, always forward-slashed (gitignore style). */
function relForwardSlash(root: string, target: string): string {
  return relative(root, target).split(/[\\/]/).join("/");
}

/**
 * Does an existing `.gitignore` list `entry` verbatim (slash-insensitive)?
 *
 * A LINE comparison, not an ignore evaluation: it cannot see that a bare `.env`
 * covers `xano/.env` at depth, or that a `**` pattern matches. {@link gitIgnores}
 * is what actually answers that question — this is the fast path for an exact
 * match and the fallback for when git cannot be asked at all. Do not "improve"
 * it into a pattern matcher; git already is one.
 */
function ignoreCovers(gitignore: string, entry: string): boolean {
  const want = entry.replace(/\/$/, "");
  return gitignore
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\/$/, ""))
    .some((line) => line.length > 0 && !line.startsWith("#") && line === want);
}
