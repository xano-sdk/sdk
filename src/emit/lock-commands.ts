/**
 * `xanosdk lock <rename|prune|import>` — xano.lock maintenance.
 *
 * First-class fix-up flows so lock surgery never REQUIRES hand-editing (though
 * hand-editing the JSON stays supported):
 *
 *   rename <kind> <old> <new>  — move an entry keeping its identity, so the
 *                                next export renames the engine object in place
 *   prune <entry-file> [keys…] — drop orphaned entries (all, or just the named
 *                                ones); requires --yes since a pruned
 *                                canonical's URL is unrecoverable
 *   prune --identity-only [entry-file] <keys…> — drop the NAMED entries without
 *                                evaluating any workspace source: identity work
 *                                only, and no orphan check to go with it (an entry
 *                                file only locates the lock)
 *   import <bundle.json>       — seed/update the lock from a live backend's
 *                                exported bundle (`workspace export`), so an
 *                                existing workspace can be taken over by code
 *                                without a delete+create sync
 *
 * `prune` takes an entry file, so it defaults the lock beside it (matching
 * `export --lock`). `rename` and `import` take none, and `prune --identity-only`
 * may omit it, so they default to the lock beside the project's backend entry
 * (`xano/xano.lock`), or `xano.lock` at the root — pass `--entry=<path>` to get
 * the beside-the-entry answer for any entry (see {@link commandLockPath}).
 *
 * Only ONE of these evaluates anything: `prune` without `--identity-only` runs the
 * workspace source, because an orphan is defined by what the source no longer
 * exports. Everything else here is identity work on a JSON file, and none of it
 * requires the entry file's module-scope environment to be satisfiable.
 * `--lock=<path>` names the file directly and overrides all three. Results print to stdout (no bundle ever
 * streams from these commands); warnings still go to stderr. Under machine output
 * (`--json`, or a piped stdout) the result is ONE JSON document instead and the
 * prose moves to stderr — see {@link humanOut}.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { checkStandInTokens, loadDefault, renameCandidatesFor, type ParsedArgs } from "./cli.js";
import { CliError, missingArgument, unknownSubcommand, UsageError } from "./errors.js";
import { allLandings } from "../deploy/ephemeral-state.js";
import { suggest } from "./commands.js";
import { LocalFileNotFoundError } from "./bundle-input.js";
import { contextFlags } from "./context-flags.js";
import { Xano } from "../workspace/xano.js";
import { setDiagnosticSink } from "../workspace/diagnostics.js";
import {
  adoptFromBundle,
  createLockContext,
  emptyLock,
  renameLockEntry,
  checkRenameTarget,
  resolvePayloadKey,
  normalizeLockKey,
  displayLockKey,
  sdkKindName,
  UnknownLockKindError,
  LockEntryNotFoundError,
  NotABundleError,
  LockImportConflictError,
  LockRenameConflictError,
  acceptedLockKinds,
  type ImportClash,
  toolsetKindsFromPayload,
  toolsetKindsFromLock,
  LOCK_PAYLOAD_KEYS,
  WORKSPACE_KEY,
  withObjects,
  type LockEntry,
  type LockFile,
} from "../lock/lock.js";
import { readLockFile, writeLockFile } from "../lock/io.js";
import { backendDirIn } from "./backend-dir.js";
import { XANO_DIR } from "./scaffold.js";
import { relForwardSlash } from "../util/rel-path.js";
import { resetLockOverrides, seedLockOverrides } from "../lock/store.js";
import { isMachineOutput, writeJson } from "./output.js";
import { shellWord } from "./command-line.js";
import { pastePath } from "./typed-cwd.js";
import { rawDeriveGuid } from "../refs/guid.js";
import { displayPath } from "../util/rel-path.js";
import { detail, info, safeText, warn } from "./ui.js";

/**
 * Read the lock a subcommand operates on, refusing a missing one by what to do
 * about it rather than with the filesystem's ENOENT. Every lock subcommand
 * edits an EXISTING lock (only `import` creates one, and it does not come
 * through here), so a missing file means the command was pointed at the wrong
 * place — fixed by retyping, which makes it a usage error.
 */
function readExistingLock(
  lockPath: string,
  subcommand: string,
  /** Read a lock whose entries share a guid: `rename` and `prune --identity-only` are how one is fixed. */
  tolerateDuplicates = false,
): LockFile {
  if (!existsSync(lockPath)) {
    throw new UsageError(
      `lock ${subcommand}: no lock file at ${displayPath(lockPath)}. The first \`xanosdk export\` ` +
        `writes xano.lock beside the entry file; point at an existing one with \`--lock=<path>\` ` +
        `or \`--entry=<entry-file>\`.`,
      { hintFor: { command: "lock", subcommand } },
    );
  }
  return readLockFile(lockPath, { tolerateDuplicates });
}

/**
 * After a write to a lock read with duplicates tolerated: the duplicates the
 * write did not remove, said with the lock's own refusal (which names the
 * prune for each side), so a fix taken one key at a time knows it is not done.
 */
function warnRemainingDuplicates(lockPath: string): void {
  try {
    readLockFile(lockPath);
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err), "lock.duplicate-identity");
  }
}

/** `resolvePayloadKey`, with an unknown kind reported as the usage error it is. */
function payloadKeyFor(kind: string, subcommand: string): string {
  try {
    return resolvePayloadKey(kind);
  } catch (err) {
    if (err instanceof UnknownLockKindError) {
      // `lock rename tabel …` (E2E pass 26): the near kind, as a typo'd name gets.
      const meant = suggest(kind, acceptedLockKinds());
      throw new UsageError(meant === undefined ? err.message : `${err.message} Did you mean "${safeText(meant)}"?`, {
        hintFor: { command: "lock", subcommand },
      });
    }
    throw err;
  }
}

/**
 * Where the human result lines go: stdout at a terminal, where they ARE the
 * result, and stderr under machine output, where stdout is reserved for the one
 * document — including on a refusal, whose failure document follows.
 */
function humanOut(args: ParsedArgs): NodeJS.WriteStream {
  return isMachineOutput(args) ? process.stderr : process.stdout;
}

/** A lock entry as data: the identity fields it actually carries. */
function entryDoc(entry: LockEntry): { guid?: string; canonical?: string } {
  return {
    ...(entry.guid !== undefined ? { guid: entry.guid } : {}),
    ...(entry.canonical !== undefined ? { canonical: entry.canonical } : {}),
  };
}

export async function runLockCommand(args: ParsedArgs): Promise<void> {
  const [sub] = args.positionals;
  switch (sub) {
    case "rename":
      return lockRename(args);
    case "prune":
      return lockPrune(args);
    case "import":
      return await lockAdopt(args);
    default:
      // `lock` is the one family whose verb is positionals[0], not
      // `args.subcommand` — it predates NOUN_COMMANDS and never joined it. The
      // error is shaped identically regardless.
      throw unknownSubcommand("lock", sub);
  }
}

function describeEntry(entry: LockEntry): string {
  const parts: string[] = [];
  if (entry.guid !== undefined) parts.push(`guid ${entry.guid}`);
  if (entry.canonical !== undefined) parts.push(`canonical ${entry.canonical}`);
  return parts.join(", ");
}

/**
 * `xano.lock` beside a workspace entry — the one rule `export --lock`,
 * `compile`, `paths --emit` and `lock prune` all resolve by. Spelled once here
 * so the four call sites cannot drift into three different answers.
 */
function lockBesideEntry(entryFile: string): string {
  return join(dirname(resolve(entryFile)), "xano.lock");
}

/**
 * The lock `rename`/`import`/`prune --identity-only` operate on when neither
 * `--lock` nor `--entry` names it: the lock the project's own `export` writes.
 *
 * These commands take no entry file, so the path is found rather than derived —
 * but only from ARTIFACTS, never guessed. The run is at the project root (the
 * CLI moves there, see `atProjectRoot`), and a project whose backend entry sits
 * one directory down (`xano/index.ts`, or the backend {@link backendDirIn}
 * finds) keeps its lock beside that entry, because that is where `export`
 * writes it. Defaulting to `./xano.lock` there made a FIRST `lock import` write
 * a lock nothing reads: the export after it wrote a fresh `xano/xano.lock` and
 * minted new canonicals, so every adopted public URL diverged (E2E pass 24).
 *
 * An entry at the root itself (`index.ts` here) keeps the lock here. A stray
 * `./xano.lock` beside a nested entry is reported, never used — export will not
 * read it. A nested lock with no entry beside it is only reported, as before:
 * nothing says it is the backend's.
 */
function commandLockPath(args: ParsedArgs, subcommand: string): string {
  if (args.lockPath !== undefined) return resolve(args.lockPath);
  // `--entry` names the workspace entry, so the lock beside it is DERIVED from
  // something the caller supplied rather than discovered — the file
  // `export --lock` and `prune` resolve.
  if (args.entryPath !== undefined) return lockBesideEntry(args.entryPath);
  const found = defaultLockPath();
  const cwdLock = resolve("xano.lock");
  if (found !== cwdLock && existsSync(cwdLock)) {
    const shown = displayPath(found);
    warn(
      `A xano.lock also sits at the project root, but \`xanosdk export\` reads ${shown} (beside ` +
        `${displayPath(entryBesideLock(found) ?? found)}), so ${subcommand === "import" ? "this import writes" : "this uses"} ` +
        `${shown}. If the root one holds identities you adopted, move it there before exporting ` +
        `(\`mv ${pasteShown(cwdLock)} ${pasteShown(found)}\`); otherwise delete it.`,
      "lock.root-shadowed",
    );
  }
  if (found === cwdLock && !existsSync(cwdLock)) {
    const backendDir = relForwardSlash(process.cwd(), backendDirIn(process.cwd())) || XANO_DIR;
    const nested = resolve(backendDir, "xano.lock");
    if (existsSync(nested)) {
      const where = pastePath(".") === "." ? "in this directory" : "at the project root";
      throw new UsageError(
        `lock ${subcommand}: no xano.lock ${where}, but one exists at ` +
          `${pasteShown(nested)} — the lock sits beside the entry file, in this project's ` +
          `backend directory. Re-run with \`--entry=${pasteShown(resolve(backendDir, "index.ts"))}\` ` +
          `(or \`--lock=${pasteShown(nested)}\`).`,
      );
    }
  }
  return found;
}

/**
 * The lock the bare command resolves (see {@link commandLockPath}), with no
 * report: `./xano.lock` when an entry sits here or no backend entry is found,
 * and the backend directory's lock when its `index.ts` exists.
 */
function defaultLockPath(): string {
  const cwd = process.cwd();
  const cwdLock = resolve("xano.lock");
  if (entryBesideLock(cwdLock) !== undefined) return cwdLock;
  const backendDir = backendDirIn(cwd);
  if (resolve(backendDir) === resolve(cwd)) return cwdLock;
  const nestedLock = join(backendDir, "xano.lock");
  return entryBesideLock(nestedLock) !== undefined ? nestedLock : cwdLock;
}

/**
 * The flags a printed `lock …` command needs to reach `lockPath` again: none
 * when the bare command resolves it, else `--entry` as the caller typed it or
 * `--lock`, spelled from where the command was typed.
 */
function lockFlags(args: ParsedArgs, lockPath: string): string {
  if (args.entryPath !== undefined) return ` --entry=${pasteShown(resolve(args.entryPath))}`;
  return resolve(lockPath) === defaultLockPath() ? "" : ` --lock=${pasteShown(lockPath)}`;
}

/**
 * For each tenant or ephemeral landing record named, the delete that clears it
 * once the backend is gone — printed without `--yes`, so it asks before
 * deleting a backend that is still there, and clears the record without asking
 * when the name is not found. A workspace's record has no such command.
 */
function staleRecordRemedies(destKeys: readonly string[], flags: string, tenantLock: string): string[] {
  const out: string[] = [];
  for (const key of destKeys) {
    const m = /\/(tenant|ephemeral)\/([^/]+)$/.exec(key);
    if (m === null) continue;
    out.push(`\`xanosdk ${m[1]} delete ${shellWord(m[2]!)}${m[1] === "tenant" ? tenantLock : ""}${flags}\``);
  }
  return out;
}

/**
 * Why an adopted entry is not pruned like any other orphan: `lock import` took
 * it from a live backend, and this code never declared it.
 */
const ADOPTED_NOTE =
  "They pin objects still serving on the backend they were adopted from, so pruning them would hand the " +
  "engine back its own objects as strangers.";

/** A path as a printed command must spell it: relative to where the command was typed, shell-quoted. */
function pasteShown(path: string): string {
  return shellWord(displayPath(path));
}

/**
 * `rename` is identity work on a JSON file and normally evaluates nothing. The
 * one exception is a name-derived entry already under the new key: that is
 * either the fresh entry an export appended after the code rename, or a live
 * object that was always called that, and only the source can say which (see
 * {@link renameLockEntry}). The source is the entry `--entry` names and nothing
 * else: an `index.ts` found beside the lock may be a stale file in a project
 * whose real entry lives elsewhere, and a rename judged by it answers about the
 * wrong workspace. Without `--entry` that case is refused.
 */
async function lockRename(args: ParsedArgs): Promise<void> {
  const [, kind, oldName, newName] = args.positionals;
  if (!kind || !oldName || !newName) {
    throw missingArgument(!kind ? "kind" : !oldName ? "old" : "new", { command: "lock", subcommand: "rename" });
  }
  // The kind and the target name are checked BEFORE the lock is read: both are
  // fixed by retyping the command, and neither needs the file to answer.
  const payloadKey = payloadKeyFor(kind, "rename");
  try {
    checkRenameTarget(payloadKey, oldName, newName);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err), {
      hintFor: { command: "lock", subcommand: "rename" },
    });
  }
  const lockPath = commandLockPath(args, "rename");
  const lock = readExistingLock(lockPath, "rename", true);
  // Named the way the reader typed it for a toolset (an `agent` stays an
  // agent), and in the SDK's spelling otherwise — never the lock file's `dbo`.
  const shownKind =
    payloadKey === "toolset" ? (kind === "agent" ? "agent" : "mcpServer") : sdkKindName(payloadKey);
  const newKey = `${payloadKey}:${newName}`;
  const shownNew = `${shownKind}:${newName}`;
  const shownOld = `${shownKind}:${oldName}`;
  // Run twice: the old entry is gone and the new one carries an identity that
  // was the OLD name's — the move is done, and doing it again is no error. Only
  // with evidence the identity was that name's: its own name-derived guid, a
  // landing that recorded it under the old name, or a committed lock that held
  // the old key. An adopted guid alone says nothing about a name that never
  // existed (`lock rename table stray x` reported "already renamed", E2E pass 25).
  const oldKey = `${payloadKey}:${oldName}`;
  const moved = lock.objects[newKey];
  const wasOld = (guid: string): boolean =>
    guid === rawDeriveGuid(oldKey) ||
    Object.values(lock.landed ?? {}).some((record) => record[oldKey]?.guid === guid) ||
    lockHistory(lockPath)?.(oldKey) === true;
  if (!(oldKey in lock.objects) && moved?.guid !== undefined && moved.guid !== rawDeriveGuid(newKey) && wasOld(moved.guid)) {
    humanOut(args).write(
      `Lock entry "${shownOld}" is already renamed: "${shownNew}" carries its identity (${describeEntry(moved)}). Nothing to do.\n`,
    );
    if (isMachineOutput(args)) {
      writeJson({ verb: "rename", lock: lockPath, from: shownOld, to: shownNew, entry: entryDoc(moved), discardedCanonical: null, movedChildren: [], alreadyRenamed: true });
    }
    return;
  }
  if (!(oldKey in lock.objects)) {
    // Before any source is evaluated: a key the lock lacks is answered by the
    // lock alone, as the not-found failure it is — with the near name of the
    // same kind, when there is one.
    const sameKind = Object.keys(lock.objects)
      .filter((k) => k.startsWith(`${payloadKey}:`))
      .map((k) => k.slice(payloadKey.length + 1));
    const meant = suggest(oldName, sameKind);
    throw new LockEntryNotFoundError(
      `No lock entry "${shownOld}" in ${displayPath(lockPath)}` +
        (meant === undefined ? "." : ` — did you mean "${shownKind}:${meant}"?`) +
        ` \`lock rename\` moves an existing entry — check the kind and the old name (kinds: ${acceptedKinds()}).`,
      // Kind-qualified, as `lock prune`'s suggestions are (E2E pass 26).
      meant === undefined ? {} : { suggestion: `${shownKind}:${meant}` },
    );
  }
  // An entry already under the new name whose guid LANDED somewhere is a live
  // object of its own there, never the fresh entry an export appended after a
  // code rename: replacing it hands that backend a second identity under one
  // name, and its next deploy refuses (E2E pass 27, on an ephemeral — only
  // `--reset` recovered). Refused before any source is evaluated: no source
  // can make a landed identity a newcomer.
  //
  // Nor a name a landing record holds with NO entry in `objects`: a `pull
  // release:` drops the entry and keeps the landing (E2E pass 28 — accepted,
  // exit 0, and the next deploy refused). Any identity other than the one
  // being moved, landed under the new name anywhere, is that live object.
  const moving = lock.objects[oldKey]!.guid;
  const heldAt = allLandings(process.cwd(), lock).filter(
    ([, record]) => record[newKey] !== undefined && record[newKey]!.guid !== moving,
  );
  const target = heldAt[0]?.[1][newKey]!.guid;
  const landedAt = heldAt.map(([dest]) => dest);
  if (landedAt.length > 0) {
    const prune = `\`xanosdk lock prune --identity-only ${shellWord(shownOld)} --yes${lockFlags(args, lockPath)}\``;
    // A record can outlive its backend — deleted from another copy of the
    // project, the record here stays (E2E pass 29: the tenant was gone, and the
    // only remedy offered discarded a valid identity). Clearing the stale record
    // comes first, because it keeps the identity: the backend's own delete
    // clears it when the name is gone, and asks before deleting one still there
    // (no `--yes`, so a backend that IS live is never deleted by pasting it).
    // A tenant's record lives in this lock, so its delete must find the same
    // one: named when it is not where a command run here looks.
    const landingDefault = join(backendDirIn(process.cwd()), "xano.lock");
    const tenantLock = resolve(lockPath) === resolve(landingDefault) ? "" : ` --lock=${pasteShown(lockPath)}`;
    const stale = staleRecordRemedies(landedAt, contextFlags(args), tenantLock);
    throw new CliError(
      "SDK_IDENTITY_CONFLICT",
      `${newKey in lock.objects ? "Lock entry " : ""}"${shownNew}" (guid ${target}) is live: this project landed it on ${landedAt.join(", ")}, so it is ` +
        `an object of its own there, not "${shownOld}" renamed. Moving "${shownOld}"'s identity onto it would give ` +
        `that backend two identities under one name, and its next deploy would refuse.` +
        (stale.length === 0
          ? ""
          : ` If ${stale.length === 1 ? "that backend no longer exists" : "a backend named there no longer exists"}, clear ` +
            `this project's stale record of it — ${stale.join(", ")} — and run this rename again.`) +
        ` If "${shownOld}" was deleted (or a deploy already recreated it as "${shownNew}"), drop its entry: ${prune}.`,
      { exitCode: 2, details: { from: shownOld, to: shownNew, guid: target, landedOn: landedAt } },
    );
  }
  // An entry under the new name whose guid `lock import` took from a live
  // backend is that backend's object, never the fresh entry an export appended
  // after a code rename — even when its guid is the one the name derives (a
  // backend deployed from code). E2E pass 30: offered by export as a rename
  // target, followed as printed, and the live guid was "replaced". Refused
  // before any source is evaluated: no source makes a live identity a newcomer.
  const held = lock.objects[newKey];
  if (held !== undefined && (held.imported === true || held.adopted === true) && held.guid !== moving) {
    const prune = `\`xanosdk lock prune --identity-only ${shellWord(shownOld)} --yes${lockFlags(args, lockPath)}\``;
    throw new CliError(
      "SDK_IDENTITY_CONFLICT",
      `Lock entry "${shownNew}" (${describeEntry(held)}) holds the identity \`lock import\` took from a live backend: ` +
        `it is that backend's object, not "${shownOld}" renamed. Moving "${shownOld}"'s identity onto it would replace ` +
        `the live object's guid, and the next deploy there would recreate it. Nothing was written. ` +
        `If "${shownOld}" was deleted (or folded into "${shownNew}"), drop its entry: ${prune}.`,
      { exitCode: 2, details: { from: shownOld, to: shownNew, guid: held.guid ?? null, imported: true } },
    );
  }
  // The workspace source the rename is judged against: the one `--entry`
  // names, or the entry file beside the lock — the same pairing `export`
  // writes the lock by, and what the documented recipe (rename in code →
  // export → `lock rename`) always reaches. The source is REQUIRED when the lock
  // already holds an entry under the new name (only it can tell the fresh entry
  // an export appended from a live object); otherwise it is a check, and a
  // beside-the-lock entry that cannot be evaluated only skips the check.
  const sourceRequired = newKey in lock.objects;
  const implicitEntry = args.entryPath === undefined ? entryBesideLock(lockPath) : undefined;
  const entryPath = args.entryPath ?? implicitEntry;
  if (implicitEntry !== undefined) {
    humanOut(args).write(`Reading the workspace from ${displayPath(implicitEntry)} (beside the lock) to check the rename.\n`);
  }
  let observed: Set<string> | undefined;
  let observedEntries: Record<string, LockEntry> | undefined;
  // With the source named, the target is checked against it: an entry moved to
  // a key the workspace does not export matches nothing, and the identity it
  // carried is lost at the next export as surely as a prune would lose it.
  if (entryPath !== undefined) {
    try {
      observedEntries = await observedRenameEntries(entryPath, lock, `${payloadKey}:${oldName}`);
      observed = new Set(Object.keys(observedEntries));
    } catch (err) {
      if (args.entryPath !== undefined || sourceRequired) throw err;
      warn(
        `Could not evaluate ${displayPath(entryPath)} to check this rename, so nothing confirms ` +
          `"${shownOld}" was renamed in code. Pass \`--entry=<path>\` to check against the workspace.`,
        "lock.rename-unchecked",
      );
    }
  }
  if (observed !== undefined && entryPath !== undefined) {
    // The old name still exported means the object was not renamed: moving its
    // entry hands its identity to a name the code does not use yet, and the
    // next export mints a fresh one for the old name — two objects, one guid
    // moved. Refused before the target check, which would say something vaguer.
    if (observed.has(`${payloadKey}:${oldName}`) && !sourceRequired) {
      throw new UsageError(
        `"${displayPath(entryPath)}" still exports ${shownKind} "${oldName}", so this is not a rename: moving ` +
          `"${shownOld}" to "${shownNew}" would take its identity away from an object that still uses it. ` +
          `Rename the object in code first, then re-run \`lock rename\`.`,
        { hintFor: { command: "lock", subcommand: "rename" } },
      );
    }
    if (!observed.has(newKey)) {
      const unpinned = [...observed]
        .filter((k) => k.startsWith(`${payloadKey}:`) && !(k in lock.objects))
        .map((k) => JSON.stringify(k.slice(payloadKey.length + 1)));
      throw new UsageError(
        `"${entryPath}" exports no ${shownKind} "${newName}", so an entry moved to ` +
          `"${shownNew}" would match nothing. ` +
          (unpinned.length > 0
            ? `${shownKind} names it exports that the lock does not pin yet: ${unpinned.join(", ")}.`
            : `Rename the object in code first, then re-run \`lock rename\`.`),
      );
    }
    // A def that pins its own guid takes it from the code, not the lock: the
    // next export re-pins the entry to it, and the identity this rename moved
    // is dropped with everything the object held.
    // The export marks a def's own guid (`guid_source`), even one an earlier
    // export already wrote into this lock under the new name.
    const pins = observedEntries?.[newKey]?.guid;
    const inCode =
      observedEntries?.[newKey]?.guid_source === "code" || pins !== (lock.objects[newKey]?.guid ?? rawDeriveGuid(newKey));
    if (pins !== undefined && moving !== undefined && pins !== moving && inCode) {
      throw new CliError(
        "SDK_IDENTITY_CONFLICT",
        `${shownKind} "${newName}" pins its own guid in its def (${pins}), and a def's guid replaces any lock entry: ` +
          `the next export would re-pin "${shownNew}" to it, and a deploy would drop "${oldName}" (guid ${moving}) ` +
          `with everything it holds. Nothing was written. If "${newName}" is "${oldName}" renamed, set its def to ` +
          `\`guid: "${moving}"\` — the identity then moves with no \`lock rename\`. If it is a new object, ` +
          `"${shownOld}" was deleted: \`xanosdk lock prune --identity-only ${shellWord(shownOld)} --yes${lockFlags(args, lockPath)}\`.`,
        { exitCode: 2, details: { from: shownOld, to: shownNew, guid: moving, pins } },
      );
    }
  }
  let result: ReturnType<typeof renameLockEntry>;
  try {
    result = renameLockEntry(lock, payloadKey, oldName, newName, observed, shownKind);
  } catch (err) {
    if (!(err instanceof LockRenameConflictError)) throw err;
    const flags = lockFlags(args, lockPath);
    const prune = (key: string): string => `\`xanosdk lock prune --identity-only ${shellWord(key)} --yes${flags}\``;
    throw new LockRenameConflictError(
      `${err.message} If "${shownOld}" was deleted and "${shownNew}" is the object to keep, drop the old ` +
        `entry: ${prune(shownOld)}. If "${shownNew}" is the renamed "${shownOld}" and its own entry is stale, ` +
        `drop that one first — ${prune(shownNew)} — then re-run this rename.`,
      err.keys,
    );
  }
  const { lock: renamed, discardedNewcomer } = result;
  // Each moved child in the SDK's words — kind and key alike, as the headline
  // spells the renamed entry: `realtimeMessage "realtimeMessage:chat|lobby|hi"`,
  // never the kind in one vocabulary and the key in the lock file's.
  const movedChildren = result.movedChildren.map((c) => ({
    kind: sdkKindName(c.kind),
    from: displayLockKey(c.from),
    to: displayLockKey(c.to),
  }));
  writeLockFile(lockPath, renamed);
  warnRemainingDuplicates(lockPath);
  humanOut(args).write(
    `Renamed lock entry "${shownOld}" → "${shownNew}" ` +
      `(${describeEntry(renamed.objects[`${payloadKey}:${newName}`]!)}).\n`,
  );
  // Queries (api group) and channels/messages (realtime server, channel) are keyed by their parent's name, and moved with it.
  for (const c of movedChildren) humanOut(args).write(`  and its ${c.kind} "${c.from}" → "${c.to}".\n`);
  // A canonical the code pins (`canonical: "stuff"`) is not minted and is not
  // discarded: the rename keeps it, since the code would emit it anyway.
  const codeCanonical = discardedNewcomer?.canonical_source === "code" ? discardedNewcomer.canonical : undefined;
  const discardedCanonical = codeCanonical === undefined ? discardedNewcomer?.canonical : undefined;
  if (discardedNewcomer) {
    // Worded by what the entry WAS, which the lock can say, and not by when it
    // was written, which it cannot: the name-derived entry is the same whether
    // the last export appended it or it has sat there since the first one.
    //
    // A DETAIL line under the rename, even when it cost a minted canonical. The
    // first rename after a plain export always finds one of these — the export
    // appended it — so a headline for it read as a problem on the normal path.
    const said =
      `replaced the name-derived entry "${shownNew}" held` +
      (discardedNewcomer.guid !== undefined ? ` (guid ${discardedNewcomer.guid})` : "") +
      ` — it was never the renamed object's identity` +
      (codeCanonical !== undefined
        ? `; kept the canonical ${codeCanonical} your code pins`
        : discardedCanonical !== undefined
          ? `; its minted canonical ${discardedCanonical} was discarded`
          : "") +
      `.`;
    // Always the indented detail line: a discarded canonical is named inside it,
    // and a capitalised headline for one case read as a different kind of output.
    humanOut(args).write(`  ${said}\n`);
  }
  // Spelled so it runs as printed: a bare `xanosdk export` refuses for want of
  // its entry file (E2E pass 25), and a lock not beside the entry is named.
  const exportEntry = entryPath === undefined ? undefined : resolve(entryPath);
  const exportLock =
    exportEntry !== undefined && lockBesideEntry(exportEntry) === resolve(lockPath) ? "" : ` --lock=${pasteShown(lockPath)}`;
  // Optional (E2E pass 26): a keep-data deploy right after the rename kept its
  // rows without it — the next export or deploy records the move either way.
  humanOut(args).write(
    `The next export or deploy emits the original guid under the new name — ` +
      `\`xanosdk export ${exportEntry === undefined ? "<entry-file>" : pasteShown(exportEntry)}${exportLock} --out ` +
      `${process.platform === "win32" ? "NUL" : "/dev/null"}\` records it now, if you want the lock settled first.\n`,
  );
  if (isMachineOutput(args)) {
    writeJson({
      verb: "rename",
      lock: lockPath,
      from: shownOld,
      to: shownNew,
      entry: entryDoc(renamed.objects[`${payloadKey}:${newName}`]!),
      discardedCanonical: discardedCanonical ?? null,
      movedChildren,
      alreadyRenamed: false,
    });
  }
}

/**
 * {@link observedLockKeys} for a rename of `oldKey`, evaluated WITHOUT that
 * entry seeded — the state the rename leaves.
 *
 * The entry being moved can be exactly what stops the source exporting: a
 * legacy name-only `query:<name>` claimed by a new verb pair puts both queries
 * on its one guid, so every locked export refuses — and `lock rename` is the fix
 * that refusal prints. Judged by an export with the entry seeded, the rename
 * refused with the error it fixes (E2E pass 24). The judgment needs only the
 * NAMES the source exports, which no pinned guid changes, so leaving the one
 * entry out costs nothing; guids are baked at module load, so it has to be left
 * out of the one evaluation rather than retried.
 */
async function observedRenameEntries(entryFile: string, lock: LockFile, oldKey: string): Promise<Record<string, LockEntry>> {
  const objects = { ...lock.objects };
  delete objects[oldKey];
  return observedLockEntries(entryFile, withObjects(lock, objects), "lock rename");
}

/**
 * Learn which lock keys the workspace still claims, by exporting it in memory.
 *
 * This is the whole reason `prune` takes an entry file: an orphan is defined by
 * what the current source does NOT export, and only running the source answers
 * that. Same sequence as a locked export — seed BEFORE the module loads — and
 * nothing is written except the pruned lock.
 *
 * Which also means a prune inherits everything the entry file does at module
 * scope. A workspace that validates required env there (a reasonable fail-fast:
 * it stops a deploy shipping a container that boots and rejects every call)
 * makes lock maintenance need production secrets in the shell. That is a real
 * constraint of "find the orphans", not of pruning, so the failure says so and
 * names the identity-only form rather than leaving someone staring at a missing
 * variable they cannot see the relevance of.
 */
async function observedLockKeys(entryFile: string, lock: LockFile, verb = "lock prune"): Promise<Set<string>> {
  return new Set(Object.keys(await observedLockEntries(entryFile, lock, verb)));
}

/** {@link observedLockKeys}, with the identity each key exported. */
async function observedLockEntries(
  entryFile: string,
  lock: LockFile,
  verb: string,
): Promise<Record<string, LockEntry>> {
  resetLockOverrides();
  seedLockOverrides(lock);
  let def: unknown;
  try {
    def = await loadDefault(entryFile);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${verb} evaluated "${entryFile}" to find out which lock entries are still live, and ` +
        `loading it failed:\n  ${reason}\n` +
        `Finding orphans requires running your workspace source — anything the entry file does at ` +
        `module scope (asserting env vars, reading config) runs too. To drop entries you can name ` +
        `yourself, no evaluation is needed: \`xanosdk lock prune --identity-only --yes <key>…\` (e.g. \`table:users\`) ` +
        `with \`--lock=<path>\` or \`--entry=<path>\` to locate the lock.`,
      { cause: err },
    );
  }
  if (!Xano.isXano(def)) {
    throw new UsageError(`Module "${entryFile}" must default-export a Xano registry for \`${verb}\`.`);
  }
  const ctx = createLockContext(lock);
  // Every documentation gate gets a stand-in value: this export is read for its
  // keys and thrown away, so a token changes nothing it answers, and lock
  // maintenance must not need the project's doc-site secrets. A stand-in, not
  // an opt-out to empty — an emptied gate reads to the guards as docs about to
  // go PUBLIC, and muting that is not enough on its own: the sink below is this
  // CLI's, and a workspace that imports its own copy of the SDK (a global or
  // npx CLI over a project install) reports through that copy's sink instead.
  // The remaining warnings are muted because they describe a bundle nobody ships.
  const previousSink = setDiagnosticSink(() => {});
  try {
    def.export({ lock: ctx, documentationTokens: checkStandInTokens(def).values });
  } finally {
    setDiagnosticSink(previousSink);
  }
  return ctx.observed;
}

/**
 * Workspace-record keys only the engine writes: instance crypto material and
 * instance state. A live export's workspace record carries them; a bundle
 * `xanosdk export` compiled carries authored settings (and a name-derived guid)
 * only, never any of these.
 */
const ENGINE_WORKSPACE_KEYS = ["salt", "iv", "checksum", "domain_prefix", "sql_schema_name", "installed_services"];

/**
 * Whether a bundle is one `xanosdk export` compiled rather than one a live
 * backend exported — told apart by the workspace record, which in a compiled
 * bundle carries none of {@link ENGINE_WORKSPACE_KEYS}. A bundle with no
 * workspace record at all is not judged (nothing says which it is).
 */
export function isCompiledBundle(bundle: unknown): boolean {
  if (bundle === null || typeof bundle !== "object") return false;
  const payload = (bundle as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== "object") return false;
  const ws = (payload as { workspace?: unknown }).workspace;
  if (ws === null || typeof ws !== "object" || Array.isArray(ws)) return false;
  return !ENGINE_WORKSPACE_KEYS.some((key) => key in (ws as Record<string, unknown>));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

async function lockPrune(args: ParsedArgs): Promise<void> {
  const [, ...rest] = args.positionals;
  // The mode is chosen by an explicit flag rather than inferred from the shape
  // of the first argument: a lock key and a path are not reliably
  // distinguishable (a Windows path carries a colon too), and guessing wrong
  // here deletes the wrong thing. Under `--identity-only` the entry file is
  // optional, and never loaded — it only locates the lock, as `--entry` does.
  // It is recognised by what is ON DISK, not by its shape: a first positional
  // naming an existing file is the entry the usage line puts there, and every
  // other positional is a key. With `--entry` given, the entry is already
  // named, so every positional is a key — one that is not in the lock is
  // refused by name rather than silently taken for a second entry.
  if (args.identityOnly) {
    const [first, ...others] = rest;
    if (args.entryPath === undefined && first !== undefined && isFile(first)) {
      return lockPruneNamed({ ...args, entryPath: first }, others, false);
    }
    return lockPruneNamed(args, rest, args.entryPath !== undefined);
  }

  // The entry is named ONE way or the other, and both forms mean the same
  // thing — the same rule `--identity-only` follows: `--entry=<path>` names it,
  // so every positional is a key (a file there is refused by name as a key the
  // lock lacks, never silently read as a second entry), and without the flag
  // the first positional is it.
  let entryFile: string | undefined;
  let typedKeys: string[];
  if (args.entryPath !== undefined) {
    entryFile = args.entryPath;
    typedKeys = rest;
  } else {
    [entryFile, ...typedKeys] = rest;
  }
  if (!entryFile) {
    throw missingArgument("entry-file", { command: "lock", subcommand: "prune" });
  }
  if (!isFile(entryFile)) {
    throw new UsageError(`lock prune: no entry file at ${entryFile}.`, {
      hintFor: { command: "lock", subcommand: "prune" },
    });
  }
  // A key may be typed with the SDK's kind name (`table:users`); the lock
  // stores it as `dbo:users`, and both address the same entry.
  const keys = typedKeys.map(normalizeLockKey);
  const lockPath =
    args.lockPath !== undefined ? resolve(args.lockPath) : lockBesideEntry(entryFile);
  const lock = readExistingLock(lockPath, "prune");
  const kinds = typedToolsetKinds(typedKeys, lock);
  const observed = await observedLockKeys(entryFile, lock);

  const orphans = Object.keys(lock.objects).filter((key) => !observed.has(key));
  let targets: string[];
  let gone: string[] = [];
  let unproven: string[] = [];
  let adopted: string[] = [];
  if (keys.length > 0) {
    ({ present: targets, gone, unproven } = splitGone(lock, lockPath, keys, args.entryPath !== undefined, kinds));
    for (const key of targets) {
      if (!orphans.includes(key)) {
        throw new UsageError(`Lock entry "${displayLockKey(key, kinds)}" still matches an exported object — not pruning it.`);
      }
    }
  } else {
    // An entry `lock import` adopted and this code never ported is an orphan to
    // the export, but it pins an object still serving on the backend it came
    // from: pruning it hands the engine back its own object as a stranger.
    // A bare prune keeps it (E2E pass 28 dropped one silently); naming its key
    // is the confirmation.
    targets = orphans.filter((key) => lock.objects[key]!.adopted !== true);
    adopted = orphans.filter((key) => lock.objects[key]!.adopted === true);
    if (adopted.length > 0) {
      const shown = adopted.map((key) => displayLockKey(key, kinds));
      warn(
        `Kept ${entries(adopted.length)} \`lock import\` adopted that this code does not declare: ` +
          `${shown.join(", ")}. ${ADOPTED_NOTE} To drop them anyway, name them:`,
        "lock.prune-adopted-kept",
        [
          `xanosdk lock prune ${pasteShown(entryFile)} ${shown.map(shellWord).join(" ")}` +
            `${args.lockPath === undefined ? "" : ` --lock=${pasteShown(lockPath)}`} --yes`,
        ],
      );
    }
  }
  if (targets.length === 0 && gone.length === 0) {
    humanOut(args).write(
      adopted.length === 0
        ? "Nothing to prune — every lock entry matches an exported object.\n"
        : "Nothing else to prune — every other lock entry matches an exported object.\n",
    );
    if (isMachineOutput(args)) {
      writeJson({
        verb: "prune",
        lock: lockPath,
        pruned: [],
        alreadyGone: [],
        ...(adopted.length === 0 ? {} : { keptAdopted: adopted.map((key) => displayLockKey(key, kinds)) }),
        discardedCanonicals: 0,
      });
    }
    return;
  }
  // A preview names the rename an orphan may really be, with the command that
  // keeps its identity instead of pruning it — the candidates `export` offers
  // for the same orphan (E2E pass 28: prune named only a table's, export a
  // query's too), by the same rules.
  const candidates = renameCandidatesFor(
    targets,
    lock,
    Object.fromEntries([...observed].map((k) => [k, true])),
    kinds,
  );
  const renames = new Map<string, string>();
  for (const key of targets) {
    const c = candidates.get(key);
    if (c === undefined || (c.only === undefined && c.hint === "")) continue;
    const sep = key.indexOf(":");
    const shownKey = displayLockKey(key, kinds);
    const kind = shownKey.slice(0, shownKey.indexOf(":"));
    const placeholder = key.slice(0, sep) === "query" ? `'<group>|<VERB>|<name>'` : "<new-name>";
    const command =
      `\`xanosdk lock rename ${kind} ${shellWord(key.slice(sep + 1))} ${c.only === undefined ? placeholder : shellWord(c.only)}` +
      `${args.lockPath === undefined ? "" : ` --lock=${pasteShown(lockPath)}`} --entry=${pasteShown(entryFile)}\``;
    renames.set(
      key,
      c.only === undefined
        ? `renamed? ${command} keeps its identity${c.hint}`
        : `renamed to "${c.only}"? ${command} keeps its identity`,
    );
  }
  // A near miss is offered only among what this prune could drop: an entry
  // the code still exports is refused by name, so offering it prints a prune
  // that fails as pasted (E2E pass 30).
  await applyPrune(args, lockPath, lock, targets, kinds, gone, unproven, renames, adopted, entryFile, new Set(orphans));
}

/**
 * The named keys the lock holds, and the ones it no longer does. A key already
 * pruned is not a failure: pruning is idempotent, so a retried cleanup (or one
 * run twice in CI) exits 0 and says so — including after the pruned lock was
 * committed. A key that was never there IS one — the not-found failure, with
 * the key it most likely meant (E2E pass 22: `table:nope` was "Already gone",
 * exit 0). What tells them apart is the lock's history: ANY commit of the lock
 * that held the key (not only HEAD — E2E pass 23: a re-run after committing the
 * prune exited 8), or a landing record naming it. A key of a known kind that
 * nothing proves was there is still the idempotent answer — exit 0, worded as
 * only what is known (`unproven`), with its near miss named as the prune that
 * runs it — as a delete of a name that is not there answers (E2E pass 29: an
 * entry adopted and pruned before any commit held it exited 8 on the rerun).
 * Only a key no lock could hold — an unknown kind, or a file — is refused.
 */
function splitGone(
  lock: LockFile,
  lockPath: string,
  keys: readonly string[],
  entryFlag: boolean,
  kinds?: ReadonlyMap<string, string>,
): { present: string[]; gone: string[]; unproven: string[] } {
  const present: string[] = [];
  const gone: string[] = [];
  const unproven: string[] = [];
  let history: ((key: string) => boolean) | null | undefined = null;
  for (const key of keys) {
    if (key in lock.objects) {
      present.push(key);
      continue;
    }
    const colon = key.indexOf(":");
    const knownKind = key === "workspace" || (colon > 0 && LOCK_PAYLOAD_KEYS.has(key.slice(0, colon)));
    if (!knownKind || isFile(key)) throw noLockEntry(lock, key, entryFlag, kinds, lockPath);
    gone.push(key);
    if (Object.values(lock.landed ?? {}).some((record) => key in record)) continue;
    if (history === null) history = lockHistory(lockPath);
    if (history === undefined || !history(key)) unproven.push(key);
  }
  return { present, gone, unproven };
}

/**
 * Whether any commit of the lock held a key, or `undefined` when there is no
 * history to ask: not a repository, no git, a lock never committed, or a
 * shallow clone (whose oldest commit would read as never holding anything).
 */
function lockHistory(lockPath: string): ((key: string) => boolean) | undefined {
  const git = (...argv: string[]): string =>
    execFileSync("git", argv, {
      cwd: dirname(resolve(lockPath)),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      encoding: "utf8",
    }).trim();
  const file = `./${basename(lockPath)}`;
  try {
    if (git("rev-parse", "--is-shallow-repository") === "true") return undefined;
    if (git("log", "-1", "--format=%H", "--", file) === "") return undefined;
  } catch {
    return undefined;
  }
  // `-S` finds the commits that changed how often the string occurs — one that
  // added the key exists exactly when some commit held it. The key is quoted as
  // the lock's JSON writes it, so `dbo:note` does not match `"dbo:notes"`.
  return (key) => {
    try {
      return git("log", "-1", "--format=%H", `-S${JSON.stringify(key)}`, "--", file) !== "";
    } catch {
      return false;
    }
  };
}

/**
 * `lock prune --identity-only <key>…` — drop the named entries without
 * evaluating any workspace source.
 *
 * Pruning a key you can name is pure identity work: it deletes a row from a JSON
 * file. Requiring the entry file for it meant lock maintenance inherited the
 * entry's module scope, so a workspace that asserts its production env at import
 * time could not be pruned without those secrets in the shell.
 *
 * What is given up is the check, and only that: nothing here confirms the key is
 * an orphan, so a key the workspace still exports can be dropped and re-minted
 * with a fresh identity by the next export. That is why every key must be named
 * explicitly — there is no "prune everything unverified" — and why `--yes` is
 * still required.
 */
async function lockPruneNamed(args: ParsedArgs, keys: string[], entryFlag: boolean): Promise<void> {
  if (keys.length === 0) {
    throw new UsageError(
      "`lock prune --identity-only` prunes the entries you name, so it needs at least one key " +
        "(`table:users`). Without keys there is nothing to prune, because finding orphans is " +
        "exactly the step --identity-only skips — drop the flag and pass the entry file to do that.",
      { helpFor: { command: "lock", subcommand: "prune" } },
    );
  }
  const lockPath = commandLockPath(args, "prune");
  const lock = readExistingLock(lockPath, "prune", true);
  const kinds = typedToolsetKinds(keys, lock);
  const { present, gone, unproven } = splitGone(lock, lockPath, keys.map(normalizeLockKey), entryFlag, kinds);
  keys = present;
  if (keys.length > 0) {
    warn(
      `--identity-only — nothing was evaluated, so nothing confirms ${keys.length === 1 ? "this key is" : "these keys are"} ` +
        `orphaned. A key the workspace still exports gets a NEW identity at the next export.`,
      "lock.identity-only",
    );
  }
  await applyPrune(args, lockPath, lock, keys, kinds, gone, unproven);
}

/**
 * The toolset kinds the reader TYPED (`agent:helper` → helper is an agent).
 * The lock stores agents and MCP servers under one `toolset:` key, so without a
 * bundle to ask, the key the reader typed is the only thing that says which —
 * and echoing `agent:helper` back as `mcpServer:helper` names the wrong kind.
 */
function typedToolsetKinds(typed: readonly string[], lock: LockFile): Map<string, string> {
  // What the lock recorded first; what the reader typed wins for their own echo.
  const kinds = toolsetKindsFromLock(lock.objects);
  for (const key of typed) {
    const colon = key.indexOf(":");
    const kind = key.slice(0, colon);
    if (kind === "agent" || kind === "mcpServer" || kind === "mcp_server") {
      kinds.set(key.slice(colon + 1), kind === "agent" ? "agent" : "mcpServer");
    }
  }
  return kinds;
}

/**
 * A key the lock does not carry — the not-found failure (exit 8). Keys are
 * printed in the SDK's spelling (`table:users`); the lock file's own
 * (`dbo:users`) is accepted too and normalized before this is reached.
 *
 * A key that names a FILE was meant as the entry: said by how the entry was
 * given, since with `--entry` every positional is a key, and without it only
 * the first positional is the entry.
 */
function noLockEntry(
  lock: LockFile,
  key: string,
  entryFlag: boolean,
  kinds: ReadonlyMap<string, string> | undefined,
  lockPath: string,
): Error {
  const known = Object.keys(lock.objects);
  const meant = isFile(key) ? undefined : closestKey(lock, key, kinds);
  const entry = entryBesideLock(lockPath);
  return new LockEntryNotFoundError(
    `No lock entry "${displayLockKey(key, kinds)}" to prune${meant === undefined ? "." : ` — did you mean "${meant}"?`}` +
      (isFile(key)
        ? entryFlag
          ? ` It is a file: with \`--entry\` given, every positional is a lock key.`
          : ` It is a file: only the first positional is the entry file, and every one after it is a lock key.`
        : "") +
      (known.length === 0
        ? " The lock is empty."
        : ` Keys look like ${JSON.stringify(displayLockKey(known[0]!))} — run \`xanosdk lock prune ${entry === undefined ? "<entry-file>" : pasteShown(entry)}\` without keys to list the orphans.`),
    meant === undefined ? {} : { suggestion: meant },
  );
}

/** The lock key `key` most likely meant, in the SDK's spelling — or undefined. */
function closestKey(lock: LockFile, key: string, kinds?: ReadonlyMap<string, string>): string | undefined {
  return suggest(displayLockKey(key, kinds), Object.keys(lock.objects).map((k) => displayLockKey(k, kinds)));
}

/** `n` entries, spelled for a sentence. */
function entries(n: number): string {
  return `${n} lock ${n === 1 ? "entry" : "entries"}`;
}

/** The kinds a rename takes, for a not-found message. */
function acceptedKinds(): string {
  return acceptedLockKinds().join(", ");
}

/** `index.ts` beside a lock, when there is one — the entry `export` pairs that lock with. */
function entryBesideLock(lockPath: string): string | undefined {
  const dir = dirname(lockPath);
  for (const name of ["index.ts", "index.mts", "index.js", "index.mjs"]) {
    const candidate = join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

/** Preview-or-write, shared by both prune modes so they cannot report differently. */
async function applyPrune(
  args: ParsedArgs,
  lockPath: string,
  lock: LockFile,
  targets: string[],
  kinds?: ReadonlyMap<string, string>,
  gone: readonly string[] = [],
  /** The gone keys nothing proves were ever in the lock: a typo, or a prune nothing recorded. */
  unproven: readonly string[] = [],
  /** Per target, the rename it may really be (a preview says it; see `lockPrune`). */
  renames: ReadonlyMap<string, string> = new Map(),
  /** Adopted orphans a bare prune kept (see `lockPrune`), for `--json`. */
  keptAdopted: readonly string[] = [],
  /** The entry file a prune that evaluates was given, for the near miss's printed prune. */
  entryFile?: string,
  /**
   * The keys a near miss may name: with an entry evaluated, only the orphans
   * — an entry still exported is refused by name, so it is no fix for a typo.
   * Without one (`--identity-only`), every key.
   */
  prunable?: ReadonlySet<string>,
): Promise<void> {
  const proven = unproven.length === 0;
  const kept = keptAdopted.length === 0 ? {} : { keptAdopted: keptAdopted.map((key) => displayLockKey(key, kinds)) };
  // Named, so confirmed — but still said: the entry pins a live object.
  const namedAdopted = targets.filter((key) => lock.objects[key]?.adopted === true);
  if (namedAdopted.length > 0) {
    warn(
      `${namedAdopted.map((key) => `"${displayLockKey(key, kinds)}"`).join(", ")} ` +
        `${namedAdopted.length === 1 ? "was" : "were"} adopted by \`lock import\`. ${ADOPTED_NOTE}`,
      "lock.prune-adopted",
    );
  }
  const goneShown = gone.map((key) => displayLockKey(key, kinds));
  // Each gone key's near miss, as the prose names it — so a `--json` caller
  // sees the typo the text points at (E2E pass 25). Only when no history
  // proved the key was pruned: a proven one is no typo.
  // Never an entry `lock import` adopted (E2E pass 29: the rerun of a finished
  // prune of one adopted entry offered the next): it pins a live object, and a
  // printed prune of it would be pasted as the fix for a typo it is not.
  const nearMisses: Record<string, string> = {};
  for (const key of unproven) {
    const meant = suggest(
      displayLockKey(key, kinds),
      Object.keys(lock.objects)
        .filter((k) => lock.objects[k]!.adopted !== true && (prunable === undefined || prunable.has(k)))
        .map((k) => displayLockKey(k, kinds)),
    );
    if (meant !== undefined) nearMisses[displayLockKey(key, kinds)] = meant;
  }
  const meants = [...new Set(Object.values(nearMisses))];
  // As every did-you-mean in a document: `suggestion`, and `suggestions` (a
  // string array) when there is more than one; which typed key each answers
  // rides in `nearMisses`.
  const suggested =
    meants.length > 0
      ? { suggestion: meants[0], ...(meants.length > 1 ? { suggestions: meants } : {}), nearMisses }
      : {};
  // Exit 0 by design (idempotent, as a delete of a name that is not there),
  // but the near miss is said on stderr too (E2E pass 26), where a script that
  // reads stdout's result as data still sees it — with the prune that runs it.
  const entryWord =
    args.identityOnly === true ? " --identity-only" : entryFile === undefined ? "" : ` ${pasteShown(resolve(entryFile))}`;
  const lockWord = args.identityOnly === true ? lockFlags(args, lockPath) : ` --lock=${pasteShown(lockPath)}`;
  for (const [shown, meant] of Object.entries(nearMisses)) {
    warn(`"${shown}" is not in ${displayPath(lockPath)}.`, "lock.prune-near-miss", [
      `Did you mean "${safeText(meant)}"? \`xanosdk lock prune${entryWord} ${shellWord(meant)}${lockWord}\` prunes it, after asking to confirm.`,
    ]);
  }
  // Only what is known: a key the lock's history names was pruned before; one
  // that no history could be asked about may never have been there.
  const goneNote =
    gone.length > 0
      ? proven
        ? `Already pruned (not in ${displayPath(lockPath)}): ${goneShown.join(", ")}.\n`
        : // No history to tell a typo from a finished prune, so the answer
          // stays the idempotent one; a near miss is named once, by the
          // warning that prints the prune running it (E2E pass 30).
          `Not in ${displayPath(lockPath)} — already pruned, or never there: ${goneShown.join(", ")}.\n`
      : "";
  if (targets.length === 0) {
    humanOut(args).write(`Nothing to prune. ${goneNote}`);
    if (isMachineOutput(args)) {
      writeJson({ verb: "prune", lock: lockPath, pruned: [], alreadyGone: goneShown, ...suggested, ...kept, discardedCanonicals: 0 });
    }
    return;
  }
  const lines = targets
    .sort()
    .map((key) => `  ${displayLockKey(key, kinds)} (${describeEntry(lock.objects[key]!)})`)
    .join("\n");
  const renameLines = targets
    .filter((key) => renames.has(key))
    .map((key) => `  ${displayLockKey(key, kinds)}: ${renames.get(key)!} instead.\n`)
    .join("");
  const discarded = targets.filter((key) => lock.objects[key]!.canonical !== undefined);
  // Tensed by what has happened: the preview WOULD discard, the prune DID.
  const canonicalNote = (done: boolean): string =>
    discarded.length > 0
      ? `${done ? "Discarded" : "Would discard"} ${discarded.length} ${discarded.length === 1 ? "canonical" : "canonicals"} — a pruned canonical's public URL is unrecoverable.\n`
      : "";
  if (!args.yes) {
    humanOut(args).write(`Would prune ${entries(targets.length)}:\n${lines}\n${renameLines}${canonicalNote(false)}${goneNote}`);
    // A terminal is asked; a run with no one to answer is refused with the
    // needs-confirmation failure, its listing riding on the document so a
    // `--json` caller reads what `--yes` would drop.
    const { confirm } = await import("./prompt.js");
    const { yesRerun } = await import("./retry-command.js");
    const { rerun, note } = yesRerun(args, `lock prune${entryWord}${targets.map((k) => ` ${shellWord(displayLockKey(k, kinds))}`).join("")}${lockWord}`);
    const refusal = {
      details: {
        wouldPrune: targets.map((key) => displayLockKey(key, kinds)),
        alreadyGone: goneShown,
        ...suggested,
        ...kept,
        wouldDiscardCanonicals: discarded.length,
      },
      rerun,
      note,
    };
    if (!(await confirm(`Prune ${targets.length === 1 ? "it" : "them"} from ${displayPath(lockPath)}?`, { flag: "--yes", refusal }))) {
      info(`Lock prune cancelled. Nothing was written to ${displayPath(lockPath)}.`);
      if (isMachineOutput(args)) {
        writeJson({ verb: "prune", lock: lockPath, declined: true, pruned: [], alreadyGone: goneShown, ...suggested, ...kept, discardedCanonicals: 0 });
      }
      return;
    }
  }
  const objects = { ...lock.objects };
  for (const key of targets) delete objects[key];
  writeLockFile(lockPath, withObjects(lock, objects));
  warnRemainingDuplicates(lockPath);
  humanOut(args).write(`Pruned ${entries(targets.length)}:\n${lines}\n${canonicalNote(true)}${goneNote}`);
  if (isMachineOutput(args)) {
    writeJson({
      verb: "prune",
      lock: lockPath,
      pruned: targets.map((key) => displayLockKey(key, kinds)),
      alreadyGone: goneShown,
      ...suggested,
      ...kept,
      discardedCanonicals: discarded.length,
    });
  }
}

async function lockAdopt(args: ParsedArgs): Promise<void> {
  const [, bundlePath] = args.positionals;
  if (!bundlePath) {
    throw missingArgument("bundle.json", { command: "lock", subcommand: "import" });
  }
  if (!isFile(bundlePath)) {
    throw new (existsSync(bundlePath) ? UsageError : LocalFileNotFoundError)(
      `lock import: no file at ${bundlePath}. It takes a live backend's exported bundle — ` +
        `\`xanosdk workspace export --path <file>${contextFlags()}\` writes one.`,
      { hintFor: { command: "lock", subcommand: "import" } },
    );
  }
  const lockPath = commandLockPath(args, "import");
  const lock: LockFile = existsSync(lockPath) ? readLockFile(lockPath) : emptyLock();
  let bundle: unknown;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  } catch (err) {
    throw new UsageError(
      `lock import: ${bundlePath} is not JSON (${err instanceof Error ? err.message : String(err)}). ` +
        `It takes a live backend's exported bundle — \`xanosdk workspace export --path <file>${contextFlags()}\` writes one.`,
    );
  }
  if (isCompiledBundle(bundle)) {
    throw new UsageError(
      `lock import: ${bundlePath} is a bundle this CLI compiled (\`xanosdk export\`), not an export ` +
        `of a live backend. Its identities are the ones your code already derives, so importing it ` +
        `would adopt nothing the backend actually holds. Export the live backend with ` +
        `\`xanosdk workspace export --path <file>${contextFlags()}\` and import that.`,
      { hintFor: { command: "lock", subcommand: "import" } },
    );
  }
  let result: ReturnType<typeof adoptFromBundle>;
  try {
    result = adoptFromBundle(lock, bundle, bundlePath);
  } catch (err) {
    // Pointed at the wrong file: fixed by retyping, so a usage error — worded
    // the way `init --from` words the same file.
    if (err instanceof LockImportConflictError) {
      const message = err.clash !== undefined ? await clashMessage(args, lockPath, lock, bundlePath, err.clash) : err.message;
      throw new LockImportConflictError(`lock import: nothing was written. ${message}`);
    }
    if (err instanceof NotABundleError) {
      throw new UsageError(
        `lock import: ${err.message} It takes a live backend's exported bundle — ` +
          `\`xanosdk workspace export --path <file>${contextFlags()}\` writes one.`,
        { hintFor: { command: "lock", subcommand: "import" } },
      );
    }
    throw err;
  }
  const { added, changed, canonicalsSeen, vaultCount, privateVaultCount } = result;
  // Every key this import ADDS is marked as adopted rather than declared: the
  // project's source never had it, so a later prune must not say "this project
  // no longer declares it". An export that declares the key clears the mark. A
  // key the lock already had keeps whatever it was — its guid moving to the
  // live one does not change who declared it.
  // An added key is `adopted` (which an export turns into `imported`); one the
  // lock already had is `imported` now — its guid is the live object's.
  const adopted = markImported(markAdopted(result.lock, added), result.seen.filter((key) => !added.includes(key)));
  // A live bundle says which toolsets are agents, so its keys print as such.
  const kinds = toolsetKindsFromPayload((bundle as { payload?: unknown }).payload, lock.objects);

  if (changed.length > 0 && !args.yes) {
    const lines = changed
      .map((c) => `  ${displayLockKey(c.key, kinds)}: ${describeEntry(c.before)} → ${describeEntry(c.after)}`)
      .join("\n");
    humanOut(args).write(`Adoption would overwrite ${changed.length} existing ${changed.length === 1 ? "lock entry" : "lock entries"}:\n${lines}\n`);
    // A terminal is asked, as every other confirmation is; only a run with no
    // one to answer is refused — the needs-confirmation failure, naming this
    // import with `--yes` as the command that answers it (E2E pass 30).
    const { confirm } = await import("./prompt.js");
    const { yesRerun } = await import("./retry-command.js");
    const { rerun, note } = yesRerun(args, `lock import ${shellWord(bundlePath)}`);
    const question = `Overwrite ${changed.length === 1 ? "it" : "them"} with what ${bundlePath} holds?`;
    const refusal = {
      details: { verb: "import", written: false, wouldUpdate: changed.map((c) => displayLockKey(c.key, kinds)) },
      rerun,
      note,
    };
    if (!(await confirm(question, { flag: "--yes", refusal }))) {
      info(`Lock import cancelled. Nothing was written to ${lockPath}.`);
      if (isMachineOutput(args)) {
        writeJson({
          verb: "import",
          lock: lockPath,
          bundle: resolve(bundlePath),
          declined: true,
          added: [],
          updated: [],
          canonicalsSeen,
          vaultEntries: vaultCount,
        });
      }
      return;
    }
  }

  if (privateVaultCount > 0) {
    warn(
      `${bundlePath} contains ${privateVaultCount} private stored ${privateVaultCount === 1 ? "file entry" : "file entries"}. ` +
        `Do NOT commit the bundle file; delete it once the import is done.`,
      "secrets.vault-in-bundle",
    );
  }
  if (!canonicalsSeen) {
    warn(
      // NOT a safety guarantee. A public URL
      // slug is unique across the whole INSTANCE, and an import resolves a
      // clash by inventing an identity rather than refusing it — it keeps
      // whatever the object already stored and substitutes a random token when
      // another workspace owns the one asked for, reporting neither. What is
      // true is narrower: the slugs this workspace serves today are not in this
      // file, so adoption cannot have changed them.
      `No canonicals found in ${bundlePath} — a configuration-only export strips them, so ` +
        `only guids were adopted. Nothing here changed the public URLs this workspace serves, but ` +
        `the lock does not know them either: until an export records one, a release treats every ` +
        `slug as a preference and accepts whatever the workspace already serves. Pin the ones your ` +
        `frontend is built from in code (\`canonical: "..."\`) and re-export — a pinned slug a ` +
        `release cannot serve fails the release instead of 404-ing your routes.`,
      "lock.no-canonicals",
    );
  }

  // A def's own `guid:` wins over the lock: the live guid is not adopted there
  // (E2E pass 41: it was, and the next export silently put the def's back).
  for (const p of result.codePinned) {
    const shown = displayLockKey(p.key, kinds);
    warn(
      `${shown} was not adopted: its def pins \`guid: "${p.guid}"\` in code, which wins over xano.lock, so the live ` +
        `guid ${p.live} would be replaced again at the next export. If the live object is this one, set its def to ` +
        `\`guid: "${p.live}"\` and export; otherwise nothing to do — the def declares another object than the live one.`,
      "lock.import-code-pinned",
    );
  }
  writeLockFile(lockPath, adopted);
  humanOut(args).write(
    // A re-import of a bundle already adopted: "Adopted …: 0 added, 0 updated"
    // read as something done (E2E pass 16).
    added.length === 0 && changed.length === 0
      ? `${lockPath} is already up to date with ${bundlePath} — nothing to adopt.\n`
      : `Adopted ${bundlePath} into ${lockPath}: ${added.length} added, ${changed.length} updated.\n`,
  );
  // Filled as the run knows them (E2E pass 26: `<entry-file>` was printed
  // though `--entry` named it), with the lock when it is not the entry's own.
  const entry = args.entryPath ?? entryBesideLock(lockPath);
  const shownEntry = entry === undefined ? "<entry-file>" : pasteShown(entry);
  const lockFlag =
    entry !== undefined && lockBesideEntry(entry) === resolve(lockPath) ? "" : ` --lock=${pasteShown(lockPath)}`;
  // Not for the workspace key alone: its canonical names no object a prune deletes.
  if (added.some((key) => key !== WORKSPACE_KEY) || changed.length > 0) {
    // Said plainly, because the scope is the whole file: adoption is what
    // makes these objects this project's, and `--prune` deletes what a project
    // owns once it has landed it — a release from ANY source that matches the
    // lock records them as landed.
    detail(
      `Every identity in ${bundlePath} is now this project's: once a deploy or release lands them on a ` +
        `destination, a \`--prune\` from this project can delete those objects there. If you meant to take over ` +
        `only some, remove the rest before anything lands: \`xanosdk lock prune ${shownEntry} <kind>:<name>…${lockFlag} --yes\`.`,
    );
  }
  // The lock now holds what the backend serves, not yet what this code emits
  // against it: until an export records that, `export --check` reports every
  // adopted entry as a change (E2E pass 21).
  if (added.length > 0 || changed.length > 0) {
    detail(
      `Next: \`xanosdk export ${shownEntry}${lockFlag} --out ` +
        `${process.platform === "win32" ? "NUL" : "/dev/null"}\` records what this code emits against it, so ` +
        `\`export --check\` and \`--frozen-lock\` pass — with \`--allow-lock-orphans\` while this code ports only part ` +
        `of what was adopted: an adopted entry it does not declare is an orphan to them, one still serving live.`,
    );
  }
  if (isMachineOutput(args)) {
    writeJson({
      verb: "import",
      lock: lockPath,
      bundle: resolve(bundlePath),
      declined: false,
      added: added.map((key) => displayLockKey(key, kinds)),
      updated: changed.map((c) => displayLockKey(c.key, kinds)),
      codePinned: result.codePinned.map((p) => ({ key: displayLockKey(p.key, kinds), guid: p.guid, live: p.live })),
      canonicalsSeen,
      vaultEntries: vaultCount,
    });
  }
}

/**
 * The lock with each of `keys` marked `imported` (see {@link LockEntry.imported}):
 * every identity the live bundle carried, added or already matching, is that
 * backend's object — the mark keeps it from ever being taken for a rename's
 * fresh newcomer once the code declares it.
 */
function markImported(lock: LockFile, keys: readonly string[]): LockFile {
  const objects = { ...lock.objects };
  for (const key of keys) {
    const entry = objects[key];
    // An entry still only `adopted` says it already (an export turns it into this).
    if (key !== WORKSPACE_KEY && entry?.guid !== undefined && entry.adopted !== true) objects[key] = { ...entry, imported: true };
  }
  return withObjects(lock, objects);
}

/** The lock with each of `keys` marked `adopted` (see {@link LockEntry.adopted}). */
function markAdopted(lock: LockFile, keys: readonly string[]): LockFile {
  if (keys.length === 0) return lock;
  const objects = { ...lock.objects };
  // Not the workspace key: its canonical names no object a prune could delete.
  for (const key of keys) if (key !== WORKSPACE_KEY) objects[key] = { ...objects[key]!, adopted: true };
  return withObjects(lock, objects);
}

/**
 * The refusal for a guid the bundle holds under one name and the lock pins to
 * another, worded by which side renamed it.
 *
 * The bundle and the lock alone cannot say: the workspace may have renamed the
 * object (the lock must follow), or the source may have, with the lock already
 * following it and the workspace not deployed yet (moving the entry back would
 * be refused as "not a rename", rightly). The workspace source answers, so it is
 * evaluated — the entry `--entry` names, or the one beside the lock — and every
 * command named carries the flags that reach this same lock and source.
 */
async function clashMessage(
  args: ParsedArgs,
  lockPath: string,
  lock: LockFile,
  bundlePath: string,
  clash: ImportClash,
): Promise<string> {
  const { kind, kindWord, workspaceName, lockName, workspaceKey, lockKey: pinnedKey, guid } = clash;
  const entryPath = args.entryPath ?? entryBesideLock(lockPath);
  const flags = lockFlags(args, lockPath);
  const rename = `\`xanosdk lock rename ${kindWord} ${lockName} ${workspaceName}${flags}\``;
  const head = `${bundlePath} holds guid ${guid} under "${workspaceKey}", but the lock already pins it to "${pinnedKey}".`;
  let observed: Set<string> | undefined;
  if (entryPath !== undefined) {
    try {
      observed = await observedLockKeys(entryPath, lock, "lock import");
    } catch {
      observed = undefined;
    } finally {
      resetLockOverrides();
    }
  }
  if (observed === undefined) {
    return (
      `${head} One side renamed it. If the workspace did, rename it in code to "${workspaceName}" too, then ` +
      `${rename} and re-run the import. If your source did, the lock already follows it: deploy the rename, ` +
      `then export the workspace again and re-import.`
    );
  }
  const exportsPinned = observed.has(`${kind}:${lockName}`);
  const exportsWorkspace = observed.has(`${kind}:${workspaceName}`);
  if (exportsPinned && !exportsWorkspace) {
    return (
      `${head} Your source renamed it — it exports "${lockName}", which the lock already follows — and the ` +
      `workspace has not received the rename yet. Deploy it, then export the workspace again and re-run the ` +
      `import. To keep the workspace's name instead, rename it back to "${workspaceName}" in code, then ${rename}.`
    );
  }
  if (exportsWorkspace && !exportsPinned) {
    return `${head} It was renamed on both sides; move the lock entry to match — ${rename} — then re-run the import.`;
  }
  if (!exportsPinned) {
    return (
      `${head} The workspace renamed it. Rename it to "${workspaceName}" in code too, then ${rename} ` +
      `and re-run the import.`
    );
  }
  return (
    `${head} Your source exports both "${lockName}" and "${workspaceName}", so this is not a rename: the ` +
    `workspace's "${workspaceName}" carries the identity your "${lockName}" is pinned to. Export the workspace ` +
    `again after deploying, and re-import.`
  );
}
