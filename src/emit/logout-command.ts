/**
 * `xanosdk logout` — sign out of ONE profile; `--all` clears the file.
 *
 * For an `oauth` credential this mirrors the Xano dashboard BFF's logout:
 * best-effort REVOKE the refresh token at the authorization server (so a leaked
 * file can't be replayed), then remove the record. Revocation failure never
 * blocks the local clear — the important half is removing the credential from
 * disk.
 *
 * A hand-authored `token` credential has no session and no authorization server,
 * so there is nothing to revoke: the removal IS the whole operation.
 *
 * Scoped to one profile by default, because the file is multi-tenant: signing
 * out of staging must not sign the user out of production. `--all` is the
 * explicit way to sign out of every profile.
 *
 * Node-only and lazily imported (like `login`/`push`) so `compile`/`export`
 * never pull in the OAuth stack.
 */
import type { ParsedArgs } from "./cli.js";
import { OpenIdProvider } from "../auth/oauth.js";
import { existsSync } from "node:fs";
import { describeRefreshAnswer, environmentCredentialVars, ProfileNotFoundError } from "../auth/token.js";
import {
  readCredentialFile,
  emptyCredentialFile,
  readProfile,
  profileNames,
  describeProfile,
  dropProfile,
  writeOrRemoveCredentialFile,
  withCredentialLock,
  clearCredential,
  clearCredentialUnderLock,
  assertCredentialFileRemovable,
  removeEmptyProjectCacheDir,
  resolveAuthFilePath,
  projectAuthFilePath,
  globalAuthFilePath,
  localAuthFilePath,
  credentialFileFlag,
  loginCommand,
  type CredentialFile,
  type CredentialRecord,
  type OAuthCredential,
} from "../auth/store.js";
import { resolveActiveProfile, type ProfileSelection } from "../auth/profile-select.js";
import { findProjectPointer, resolveProjectProfile, type ProjectPin } from "../auth/profile-pointer.js";
import { resolve } from "node:path";
import { confirm } from "./prompt.js";
import { yesRerun } from "./retry-command.js";
import { suggestAll } from "../util/suggest.js";
import { assertHttpsOrigin, resolveScope } from "../auth/config.js";
import { success, warn, info, detail, hostLabel, quotedNames, safeText } from "./ui.js";
import { UsageError } from "./errors.js";
import { shellQuote } from "../util/shell-quote.js";
import { isMachineOutput, writeJson } from "./output.js";

export async function runLogoutCommand(args: ParsedArgs): Promise<void> {
  // `--all` and `--profile` ask for opposite scopes. Refused rather than
  // resolved: whichever one we honoured, the other was a typed instruction the
  // command ignored, and here that means clearing credentials the user did not
  // mean to touch.
  if (args.all && args.profile !== undefined) {
    throw new UsageError(
      `\`--all\` clears every stored profile, so it cannot be scoped to ` +
        `\`--profile ${args.profile}\`. Drop \`--all\` to sign out of that one profile, or drop ` +
        `\`--profile\` to sign out of all of them.`,
      { hintFor: { command: "logout" } },
    );
  }
  // "write" mode: like `login`, target a definite cache. Defaults to the shared
  // global cache (the common sign-in); `--local` clears the project cache
  // instead. Never falls back between the two — the target is exactly the one
  // the flag (or its absence) names.
  const authFilePath = resolveAuthFilePath(args, "write");
  const targetsGlobal = authFilePath === globalAuthFilePath();

  // A stale/invalid credential must still be removable — that is the whole point
  // of logout. Fall back to a bare delete rather than stranding the user with a
  // read error and a file they cannot clear through the CLI.
  let file: CredentialFile | null;
  try {
    file = readCredentialFile(authFilePath);
  } catch (err) {
    warn(`Could not read ${authFilePath} (${err instanceof Error ? err.message : String(err)}).`, "logout.unreadable");
    const removedFile = clearCredential(authFilePath);
    if (removedFile) removeEmptyProjectCacheDir(authFilePath);
    if (removedFile) {
      success("Removed the unreadable credential file.");
      detail(`Removed ${authFilePath}`);
    }
    // No profile names to report — the file could not be read for them.
    if (isMachineOutput(args)) {
      writeJson({
        verb: "logout",
        path: authFilePath,
        removed: [],
        remaining: [],
        alreadyGone: false,
        removedUnreadableFile: removedFile,
        removedFile,
        // An unreadable file names no session to revoke.
        ...revokeFields({ revoked: null }),
      });
    }
    return;
  }

  const names = file === null ? [] : profileNames(file);
  if (file === null || names.length === 0) {
    if (!args.all) refuseIfOnlyInProjectFile(args, authFilePath, activeProfile(args, file ?? emptyCredentialFile()), names);
    // An explicitly requested logout that finds nothing is worth an `i` line
    // (your command had no effect), not a dim incidental detail.
    info(`Not signed in (no credential at ${authFilePath}). Nothing to do.`);
    noteEnvCredential();
    if (isMachineOutput(args)) writeLogoutDocument(authFilePath, [], [], { alreadyGone: true });
    return;
  }

  // The global file is reused across every project, so clearing it here affects
  // every one of them — surface that before the irreversible delete. True for
  // both arms: a hand-authored global credential is just as widely shared.
  // Named by its real path ($XANO_GLOBAL_CONFIG moves it), and only once
  // something is about to be removed.
  const warnShared = (what: string): void => {
    if (targetsGlobal) {
      warn(`Clearing ${what} in the shared credential file ${authFilePath} — this affects every project that reuses it.`, "logout.shared-file");
    }
  };

  if (args.all) {
    const pin = pinnedBy(authFilePath, names);
    if (!(await confirmRemoveAll(args, authFilePath, names, pin))) {
      return declined(args, authFilePath, names, pin);
    }
    warnShared("every credential");
    // Concurrently: each revoke is an independent round trip to its own
    // authorization server, already best-effort, and serialising them makes one
    // slow or unreachable host stall every profile behind it.
    // A malformed entry has nothing revocable; removing it is the repair.
    // Re-read and revoke INSIDE the lock, then delete there too: an unlocked
    // delete lets a concurrent refresh — which writes back the whole map it read
    // under the lock — recreate the file afterwards, resurrecting profiles whose
    // sessions were just revoked.
    let revokes: Array<{ profile: string; outcome: RevokeOutcome }> = [];
    const removedFile = await clearCredentialUnderLock(authFilePath, async (current) => {
      revokes = await Promise.all(
        profileNames(current).flatMap((name) => {
          const record = revocableRecord(current, name, authFilePath);
          return record === undefined
            ? []
            : [revokeProfileSession(args, record, name).then((outcome) => ({ profile: name, outcome }))];
        }),
      );
    });
    // After the lock is released: the lock lives beside the file.
    if (removedFile) removeEmptyProjectCacheDir(authFilePath);
    success(`Signed out of ${names.length} ${names.length === 1 ? "profile" : "profiles"}.`);
    detail(`Removed ${authFilePath}`);
    // The same caveat a single token logout gives: removing the file ends no
    // meta API token, and "signed out" must not read as if it had.
    const tokens = names.filter((name) => (file.profiles[name] as { type?: unknown } | null)?.type === "token");
    if (tokens.length > 0) {
      detail(
        `${tokens.length === 1 ? `The meta API token behind "${safeText(tokens[0]!)}" is` : `The meta API tokens behind ${quotedNames(tokens)} are`} ` +
          `still valid — revoke ${tokens.length === 1 ? "it" : "them"} at the source if you need ${tokens.length === 1 ? "it" : "them"} dead.`,
      );
    }
    // The line a single-profile logout of the last one prints: nothing is left
    // in this file, and the sign-in that refills it has to name it.
    if (envCredentialVars().length === 0) {
      // The sign-in that refills it: the removed profile's name and server when
      // one was removed, the default's when several were.
      const again = names.length === 1 ? names[0]! : (file.default ?? names[0]!);
      detail(`No profiles are left — run \`${signInAgain(authFilePath, again, file.profiles[again])}\` to sign in again.`);
    }
    notePinLeft(pin, authFilePath, file.profiles[pin?.profile ?? ""]);
    noteEnvCredential();
    if (isMachineOutput(args)) {
      writeLogoutDocument(authFilePath, names, [], {
        clearedDefault: file.default !== undefined,
        removedFile,
        revoke: combineRevokes(revokes),
        pin,
      });
    }
    return;
  }

  const selection = activeProfile(args, file);
  let saved: CredentialRecord | null;
  try {
    saved = readProfile(file, selection.name, authFilePath);
  } catch {
    // Unreadable entry: there is nothing to revoke, and removing it is the fix.
    saved = null;
  }
  if (saved === null && !Object.prototype.hasOwnProperty.call(file.profiles, selection.name)) {
    refuseIfOnlyInProjectFile(args, authFilePath, selection, names);
    refuseNearMiss(args, authFilePath, file, selection, names);
    // Not stored and near no stored name: signed out either way, so exit 0.
    info(
      `Profile "${selection.name}" is not signed in at ${authFilePath}. Nothing to do. ` +
        `Signed in as: ${quotedNames(names)}.`,
    );
    noteEnvCredential();
    if (isMachineOutput(args)) writeLogoutDocument(authFilePath, [], names, { alreadyGone: true });
    return;
  }
  const pin = pinnedBy(authFilePath, [selection.name]);
  const orphansDefault = file.default === selection.name && names.length > 1 ? authFilePath : undefined;
  if (!(await confirmDanglingRemoval(args, "logout", selection.name, pin, orphansDefault))) {
    return declined(args, authFilePath, names, pin);
  }
  warnShared(`profile "${selection.name}"`);

  // Revoke INSIDE the lock, from the record re-read there: a refresh that lands
  // between an outside read and the delete rotates the token, and the one
  // revoked would then not be the one removed — leaving the live rotated token
  // valid on the authorization server. Same order `--all` and `profile add` use.
  let wasDefault = false;
  let removedFile = false;
  let revoke: RevokeOutcome = { revoked: null };
  const left = await withCredentialLock(authFilePath, async (current) => {
    // Read under the lock, from the file actually rewritten: the default the
    // drop below clears is the one this report has to name.
    wasDefault = current.default === selection.name;
    const revocable = revocableRecord(current, selection.name, authFilePath);
    if (revocable !== undefined) revoke = await revokeProfileSession(args, revocable, selection.name);
    // The last profile out takes the file with it — see writeOrRemoveCredentialFile.
    removedFile = writeOrRemoveCredentialFile(authFilePath, dropProfile(current, selection.name));
    return profileNames(current);
  });
  // After the lock is released: the lock lives beside the file.
  if (removedFile) removeEmptyProjectCacheDir(authFilePath);

  if (saved?.type === "token") {
    success(`Removed the meta API token credential "${selection.name}" (${hostLabel(saved.instance_base_url)})`);
    detail("The token itself is still valid — revoke it at its source if you need it dead.");
  } else if (saved === null) {
    success(`Removed the unreadable profile "${selection.name}".`);
  } else {
    success(`Signed out of profile "${selection.name}" (${hostLabel(saved.instance)})`);
  }
  reportWhatIsLeft(authFilePath, selection.name, left, wasDefault, file.profiles[selection.name]);
  notePinLeft(pin, authFilePath, file.profiles[selection.name]);
  if (isMachineOutput(args)) {
    writeLogoutDocument(authFilePath, [selection.name], left, { clearedDefault: wasDefault, removedFile, revoke, pin });
  }
}

/**
 * This project's `xano.profile.json`, when it pins one of `removing` in the file
 * this project resolves its credentials through — the check `profile delete`
 * makes. Signing out of it leaves every command here failing on a pinned name.
 */
function pinnedBy(authFilePath: string, removing: readonly string[]): ProjectPin | undefined {
  if (authFilePath !== resolve(projectAuthFilePath())) return undefined;
  const pin = findProjectPointer(process.cwd());
  return pin !== undefined && removing.includes(pin.profile) ? pin : undefined;
}

/**
 * The one rule `logout` and `profile delete` share for when removing a profile
 * asks first: when the removal leaves something NAMING it behind —
 *
 *   • the `xano.profile.json` pinning this project to it (committed, so it is
 *     KEPT by both verbs, and every command here fails until the name is
 *     signed in again or another profile is pinned), or
 *   • the file's `default`, while other profiles stay (the file is left with
 *     profiles and no default, so every bare command there fails).
 *
 * Removing the only profile orphans no default: the file goes with it. Off a
 * terminal the confirmation is `--yes`, and the refusal says what the yes costs.
 * (E2E pass 28: `profile delete` of the default needed `--yes` while `logout` of
 * it did not, and `profile delete --yes` removed the committed pointer.)
 */
export async function confirmDanglingRemoval(
  args: ParsedArgs,
  verb: "logout" | "delete",
  name: string,
  pin: ProjectPin | undefined,
  /** The credential file whose `default` this removal clears with others left in it. */
  orphansDefaultIn: string | undefined,
): Promise<boolean> {
  if (args.yes || (pin === undefined && orphansDefaultIn === undefined)) return true;
  const where =
    orphansDefaultIn === undefined ? "" : orphansDefaultIn === globalAuthFilePath() ? "this machine" : orphansDefaultIn;
  const is = [
    orphansDefaultIn === undefined ? undefined : where === "this machine" ? "this machine's default" : `the default in ${where}`,
    pin === undefined ? undefined : `the one ${pin.path} pins this project to`,
  ]
    .filter(Boolean)
    .join(" and ");
  const costs = [
    orphansDefaultIn === undefined ? undefined : `leaves ${where} with no default`,
    pin === undefined
      ? undefined
      : `keeps ${pin.path} naming it, so every command here fails until ${
          verb === "logout" ? "it is signed in again" : "it is stored again or another profile is pinned"
        }`,
  ]
    .filter(Boolean)
    .join(" and ");
  const doing = verb === "logout" ? "Signing out of it" : "Deleting it";
  const { rerun, note } = yesRerun(args, verb === "logout" ? "logout" : "profile delete");
  return confirm(
    `Profile "${pin?.profile ?? name}" is ${is}. ${doing} ${costs}. ${verb === "logout" ? "Sign out" : "Delete it"} anyway?`,
    { flag: "--yes", refusal: { details: { removed: false, profile: pin?.profile ?? name }, rerun, note } },
  );
}

/**
 * `--all` removes every stored credential — always asked, never only when a pin
 * would dangle: a script that meant one profile must not lose all of them for
 * want of a terminal. `--all` leaves no profile to lack a default, so the pin is
 * the one extra cost to name.
 */
async function confirmRemoveAll(
  args: ParsedArgs,
  path: string,
  names: readonly string[],
  pin: ProjectPin | undefined,
): Promise<boolean> {
  // A file this run would refuse to remove is refused before the question, not after a yes.
  assertCredentialFileRemovable(path);
  if (args.yes) return true;
  const which = names.length === 1 ? `the one profile ("${safeText(names[0]!)}")` : `all ${names.length} profiles (${quotedNames(names)})`;
  const pinCost =
    pin === undefined ? "" : ` ${pin.path} keeps pinning this project to "${pin.profile}", so every command here fails until it is signed in again.`;
  const { rerun, note } = yesRerun(args, "logout");
  return confirm(`Signing out of ${which} removes ${path}.${pinCost} Sign out of every profile?`, {
    flag: "--yes",
    refusal: { details: { removed: false, profiles: [...names] }, rerun, note },
  });
}

/**
 * A declined confirmation: nothing removed, said and (for `--json`) answered —
 * with the pin that asked, since it is WHY the run declined (E2E pass 26: the
 * document said `pinnedBy: null` on the one outcome a pin caused).
 */
function declined(args: ParsedArgs, authFilePath: string, names: readonly string[], pin: ProjectPin | undefined): void {
  info("Nothing was removed.");
  if (isMachineOutput(args)) writeLogoutDocument(authFilePath, [], names, { declined: true, ...(pin === undefined ? {} : { pin }) });
}

/** After a sign-out of the pinned profile: the pointer left naming it, and the two ways on. */
function notePinLeft(pin: ProjectPin | undefined, path: string, record: unknown): void {
  if (pin === undefined) return;
  warn(
    `${pin.path} still pins this project to "${pin.profile}", which is signed out now. Sign in again with ` +
      `\`${signInAgain(path, pin.profile, record)}\`, or pin another profile with \`xanosdk profile use <name>\`.`,
    "logout.pin-signed-out",
  );
}

/**
 * The `--json` answer: which profiles this run removed and which are still
 * signed in. A logout that found nothing to do answers with an empty `removed`
 * and `alreadyGone: true` — the field `profile delete`, `release delete` and
 * `ephemeral delete` carry — rather than a silent stdout, so a script can tell
 * "done" from "nothing there".
 */
function writeLogoutDocument(
  path: string,
  removed: readonly string[],
  remaining: readonly string[],
  outcome: {
    clearedDefault?: boolean;
    alreadyGone?: boolean;
    removedFile?: boolean;
    revoke?: RevokeOutcome;
    pin?: ProjectPin;
    declined?: boolean;
  } = {},
): void {
  // `environmentCredential`: the env variables still set — a script reading
  // `remaining: []` must not conclude nothing will authenticate. `removedFile`:
  // the last profile out takes the file with it, the key `profile delete` carries.
  writeJson({
    verb: "logout",
    path,
    removed,
    remaining,
    clearedDefault: outcome.clearedDefault ?? false,
    alreadyGone: outcome.alreadyGone ?? false,
    removedFile: outcome.removedFile ?? false,
    // A confirmation of a pinned profile's sign-out answered no.
    declined: outcome.declined ?? false,
    // The `xano.profile.json` still pinning a profile this run signed out of —
    // kept, since it is committed; null when none does.
    pinnedBy: outcome.pin?.path ?? null,
    environmentCredential: envCredentialVars(),
    // `revoked`: whether the removed session was ended on the server — null when
    // there was none to end (a meta API token, nothing removed). `false` means it
    // may still be live, with the reason in `revokeError`.
    ...revokeFields(outcome.revoke ?? { revoked: null }),
  });
}

/** Credential variables set in this environment, which outrank every stored profile. */
function envCredentialVars(): string[] {
  return environmentCredentialVars().vars;
}

/**
 * A logout clears stored profiles, never the environment — say so, or "signed
 * out" reads as true while every later command still authenticates.
 */
function noteEnvCredential(): void {
  const { vars, complete } = environmentCredentialVars();
  if (vars.length === 0) return;
  const them = vars.length === 1 ? "it" : "them";
  const set = `${vars.join(", ")} ${vars.length === 1 ? "is" : "are"} still set in this environment`;
  // Only a COMPLETE environment credential authenticates: the meta-token
  // triple, or a refresh token with its client id. Anything less makes every
  // command fail, so "keep authenticating" would misreport it — the words
  // `login` uses for the same partial set.
  warn(
    complete
      ? `${set} — commands keep authenticating with ${them}. Unset ${them} to sign out fully.`
      : `${set} — it is an incomplete credential, so commands fail on it rather than using a stored profile. ` +
          `Unset ${them}.`,
    "logout.env-still-set",
  );
}

/**
 * The profile asked for is not in the file this logout targets, but IS in the
 * project-local `./.xano/auth.json` — where `login --local` and a bare read put
 * it. There is still no fallback (a logout clears exactly the file it names),
 * but answering "nothing to do" (`alreadyGone`) would tell a script the session
 * is gone while `whoami` still acts as it. Refused as not found IN THIS FILE
 * (exit 8), naming the file that holds it and the command that clears it.
 */
function refuseIfOnlyInProjectFile(
  args: ParsedArgs,
  authFilePath: string,
  selection: ProfileSelection,
  names: readonly string[],
): void {
  if (args.local || authFilePath !== globalAuthFilePath()) return;
  const local = localAuthFilePath();
  if (local === authFilePath || !existsSync(local)) return;
  let held: CredentialFile | null;
  try {
    held = readCredentialFile(local);
  } catch {
    return;
  }
  if (held === null || !Object.prototype.hasOwnProperty.call(held.profiles, selection.name)) return;
  throw new ProfileNotFoundError(
    `Profile "${selection.name}" is not in ${authFilePath}, the file \`logout\` clears by default — ` +
      `it is stored in this project's ${local}. Run \`xanosdk logout --local -p ${selection.name}\` to sign out of it there.`,
    selection,
    names,
  );
}

/**
 * A profile one slip from a stored name is most likely that one mistyped, and
 * is answered as `profile delete` answers it: exit 8 with the suggestion(s),
 * nothing signed out — a script reading exit 0 took the typo for a done
 * sign-out. Each near name's logout is printed without `--yes` (a near name is
 * a different profile) and with `--json` and the file flag kept.
 */
function refuseNearMiss(
  args: ParsedArgs,
  authFilePath: string,
  file: CredentialFile,
  selection: ProfileSelection,
  names: readonly string[],
): void {
  const nearAll = suggestAll(selection.name, names);
  if (nearAll.length === 0) return;
  const again = `${args.json === true ? " --json" : ""}${
    authFilePath === resolve(projectAuthFilePath()) ? "" : credentialFileFlag(authFilePath)
  }`;
  // The rule `confirmDanglingRemoval` applies: the pinned profile, or the default with others left.
  const confirms = (n: string): boolean =>
    pinnedBy(authFilePath, [n]) !== undefined || (file.default === n && names.length > 1);
  const err = new ProfileNotFoundError(
    [
      `Profile "${selection.name}" is not signed in at ${authFilePath} — nothing was signed out. ` +
        `Signed in as: ${quotedNames(names)}.`,
      ...nearAll.map(
        (n) =>
          `Did you mean "${safeText(n)}"? \`xanosdk logout --profile ${shellQuote(n)}${again}\` signs it out` +
          `${confirms(n) ? ", after asking to confirm" : ""}.`,
      ),
    ].join("\n"),
    selection,
    names,
  );
  Object.defineProperty(err, "suggestion", { value: nearAll[0], enumerable: true });
  if (nearAll.length > 1) Object.defineProperty(err, "suggestions", { value: nearAll, enumerable: true });
  throw err;
}

/** Which profile `logout` acts on — the same ladder every other command resolves. */
function activeProfile(args: ParsedArgs, file: CredentialFile): ProfileSelection {
  return resolveActiveProfile({
    flag: args.profile,
    fileDefault: file.default,
    readPointer: () => resolveProjectProfile(process.cwd()),
  });
}

/**
 * Why a session is being revoked — the one thing the failure warning has to
 * get right, because each leaves something different behind:
 *   • `logout` — the local copy is removed anyway, which is the half that protects.
 *   • `replace` — `login --force` / `profile add --force` already overwrote the
 *     record, so the old session is unreachable and stays valid until it expires.
 *   • `minted` — a sign-in whose credential was never stored; the unused session
 *     stays valid until it expires.
 */
export type RevokeContext = "logout" | "replace" | "minted";

/** The sentence after a revoke that did not happen, for each context. */
function afterFailedRevoke(context: RevokeContext): string {
  switch (context) {
    case "logout":
      return "Removing the local copy anyway.";
    case "replace":
      return "It was replaced here anyway — the replaced session stays valid on the server until it expires.";
    case "minted":
      return "It was never stored, so nothing here holds it — the unused session stays valid on the server until it expires.";
  }
}

/**
 * Revoke one profile's refresh token at the authorization server it was minted
 * by. Best-effort: a network or AS failure must not strand the user signed in
 * locally, which is the half of a logout that actually protects them.
 *
 * Shared with `profile delete`, which must revoke identically — otherwise a
 * "deleted" profile leaves a live, replayable refresh token server-side while
 * the user believes it is dead — and with the replacing writers (`login
 * --force`, `profile add --force`) and a sign-in whose write failed, which is
 * why the failure warning is worded by `context`.
 */
export async function revokeProfileSession(
  args: ParsedArgs,
  saved: OAuthCredential,
  profile: string,
  context: RevokeContext = "logout",
): Promise<RevokeOutcome> {
  if (!saved.refresh_token) return { revoked: null };
  const whose =
    context === "logout"
      ? `profile "${profile}"'s refresh token`
      : context === "replace"
        ? `the session profile "${profile}" held before`
        : `the session this sign-in minted for profile "${profile}"`;
  // The revoke SENDS the refresh token to `auth_host`, so it gets the same
  // https-or-loopback rule a refresh does. A record whose host fails it is not
  // revoked — sending the token over cleartext is worse than leaving it — and
  // the local credential is still cleared, which is the half that protects.
  try {
    assertHttpsOrigin(saved.auth_host, "The stored sign-in server (`auth_host`)");
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    warn(`Did not revoke ${whose}: ${why} The token was not sent. ${afterFailedRevoke(context)}`, "logout.revoke-failed");
    return { revoked: false, error: oneLine(`The token was not sent: ${why}`) };
  }
  // Use the client that minted the token (we know its id, so no registration),
  // and revoke at the saved auth host.
  const provider = new OpenIdProvider({
    authHost: saved.auth_host,
    scope: saved.scope ?? resolveScope(args),
    clientId: saved.client_id,
  });
  try {
    await provider.revoke(saved.refresh_token);
    return { revoked: true };
  } catch (err) {
    return { revoked: false, error: await warnRevokeFailed(whose, saved.auth_host, err, context) };
  }
}

/**
 * What a revoke did, for the `--json` documents of `logout` and `profile
 * delete`: `revoked: null` when there was nothing to revoke (a meta API token
 * profile, or an OAuth record with no refresh token); `false` with the one-line
 * reason when the session may still be live on the server.
 */
export type RevokeOutcome = { revoked: true } | { revoked: false; error: string } | { revoked: null };

/** The `revoked` / `revokeError` keys a document carries for an outcome. */
export function revokeFields(outcome: RevokeOutcome): { revoked: boolean | null; revokeError: string | null } {
  return { revoked: outcome.revoked, revokeError: outcome.revoked === false ? outcome.error : null };
}

/**
 * Several revokes as one outcome (`logout --all`): `null` when none was
 * attempted, `false` when any failed — each failure named by its profile.
 */
export function combineRevokes(outcomes: ReadonlyArray<{ profile: string; outcome: RevokeOutcome }>): RevokeOutcome {
  const tried = outcomes.filter((o) => o.outcome.revoked !== null);
  if (tried.length === 0) return { revoked: null };
  const failed = tried.flatMap((o) => (o.outcome.revoked === false ? [`"${o.profile}": ${o.outcome.error}`] : []));
  return failed.length === 0 ? { revoked: true } : { revoked: false, error: failed.join("; ") };
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/**
 * The warning for a revoke the server did not complete, worded by `context`.
 * Shared with `login`'s revoke of a session it minted and could not use.
 * Returns the reason as one line, for a `--json` document's `revokeError`.
 */
export async function warnRevokeFailed(
  whose: string,
  authHost: string,
  err: unknown,
  context: RevokeContext,
): Promise<string> {
  // openid-client's own message for a non-conformant answer is the bare
  // "unexpected HTTP response status code": the status, and a page's title
  // (never its HTML), are what say what happened.
  const answer = await describeRefreshAnswer(err);
  const message = err instanceof Error ? err.message : String(err);
  warn(
    `Could not revoke ${whose} at ${hostLabel(authHost)} ` +
      (answer === undefined ? `(${message})` : `(the server answered ${answer})`) +
      `. ${afterFailedRevoke(context)}`,
    "logout.revoke-failed",
  );
  return oneLine(
    answer === undefined ? `${hostLabel(authHost)}: ${message}` : `${hostLabel(authHost)} answered ${answer}`,
  );
}

/**
 * The OAuth record for a profile, whether or not it fully validates.
 *
 * A malformed entry still counts: an entry that fails validation on some other
 * field can carry a perfectly good refresh token, and dropping it unrevoked
 * reports a clean sign-out while leaving a live, replayable session on the
 * authorization server.
 */
export function revocableRecord(file: CredentialFile, name: string, path: string): OAuthCredential | undefined {
  // `describeProfile` assumes the name is present — its callers iterate
  // `profileNames`. Here the name may be one that does not exist yet (`login`,
  // `profile add`, which revoke what they replace through this too).
  if (!Object.prototype.hasOwnProperty.call(file.profiles, name)) return undefined;
  const described = describeProfile(file, name, path);
  if ("record" in described) return described.record.type === "oauth" ? described.record : undefined;
  return salvageRevocable(file.profiles[name]);
}

/**
 * The three fields a revoke needs, read straight off an entry too broken to
 * parse. Returns undefined when any is missing — there is nothing to revoke.
 */
export function salvageRevocable(raw: unknown): OAuthCredential | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const has = (k: string): boolean => typeof r[k] === "string" && (r[k] as string) !== "";
  if (!has("refresh_token") || !has("client_id") || !has("auth_host")) return undefined;
  return {
    type: "oauth",
    refresh_token: r.refresh_token as string,
    client_id: r.client_id as string,
    auth_host: r.auth_host as string,
    scope: typeof r.scope === "string" ? r.scope : undefined,
  } as OAuthCredential;
}

/**
 * The command that puts a removed profile back: its name, its file, and — for
 * an OAuth profile — the sign-in server it was signed in at when that is not
 * the default. A bare `xanosdk login --config c8.json` recreated `default` on
 * app.xano.com, not the `staging` profile on the server it came from. A meta
 * API token profile is put back the way it was made, with `profile add`.
 * `record` is the raw entry: an unreadable one still names its server.
 */
export function signInAgain(path: string, name: string, record: unknown): string {
  const r = typeof record === "object" && record !== null ? (record as Record<string, unknown>) : {};
  if (r.type === "token" && typeof r.instance_base_url === "string" && typeof r.workspace_id === "number") {
    return (
      `xanosdk profile add ${shellQuote(name)}${credentialFileFlag(path)} ` +
      `--instance ${shellQuote(r.instance_base_url)} --workspace-id ${r.workspace_id}`
    );
  }
  return loginCommand(name, { path, origin: typeof r.auth_host === "string" ? r.auth_host : undefined });
}

/** What the next command will find — the question a partial logout raises. */
function reportWhatIsLeft(path: string, removed: string, left: string[], wasDefault: boolean, record: unknown): void {
  detail(`Removed profile "${removed}" from ${path}`);
  // The remedies below name THIS file: a bare `xanosdk login` after a
  // `logout --config` would sign into the shared one.
  const fileFlag = credentialFileFlag(path);
  if (left.length === 0) {
    detail(`It was the last profile, so ${path} was removed.`);
    if (envCredentialVars().length === 0) {
      detail(`No profiles are left — run \`${signInAgain(path, removed, record)}\` to sign in again.`);
    }
  } else if (wasDefault) {
    // The same words `profile delete` uses: a bare command after this has no
    // default to fall back on, and "still signed in" alone hides that.
    detail(
      `${path === globalAuthFilePath() ? "This machine has" : `${path} has`} no default now. ` +
        `Signed in as: ${quotedNames(left)} — ` +
        `set one with \`xanosdk profile set-default ${left.length === 1 ? left[0]! : "<name>"}${fileFlag}\`.`,
    );
  } else {
    detail(`Still signed in as: ${quotedNames(left)}.`);
  }
  // Whenever it is set, not only once no profile is left: the environment
  // credential outranks EVERY profile, so the next command acts as it either way.
  noteEnvCredential();
}
