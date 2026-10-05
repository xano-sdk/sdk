/**
 * `xanosdk profile <list|show|use|set-default|add|delete>` — manage the named
 * credential profiles stored in `auth.json`.
 *
 * The family exists because the file is no longer one record. Before profiles,
 * the documented way to get a meta API token credential was to hand-author
 * `auth.json`; nested inside a versioned envelope that is materially harder and
 * much easier to get wrong, so `add` replaces it.
 *
 * Two verbs differ only in SCOPE and sit one keystroke apart: `use` pins THIS
 * PROJECT (a committed `xano.profile.json`), `set-default` changes THIS MACHINE
 * (the credential file's `default` key). Each says which, in its summary and in
 * its output.
 *
 * `show` never prints token material, in either human or `--json` mode. The
 * command that displays credentials is the last place a token should leak into
 * shell history or a CI log.
 *
 * Node-only (fs + OAuth) and lazily imported like the other account commands.
 */
import { resolve } from "node:path";
import type { ParsedArgs } from "./cli.js";
import {
  readCredentialFile,
  readProfile,
  profileNames,
  describeProfile,
  writeCredentialFile,
  writeOrRemoveCredentialFile,
  withCredentialLock,
  dropProfile,
  emptyCredentialFile,
  buildTokenCredential,
  isSafeIdText,
  resolveAuthFilePath,
  projectAuthFilePath,
  globalAuthFilePath,
  credentialFileFlag,
  loginCommand,
  addProfileHint,
  assertCredentialFileWritable,
  removeEmptyProjectCacheDir,
  type CredentialFile,
  type TokenCredential,
} from "../auth/store.js";
import { fetchOrExplain, httpFailure, redirectedUnresolvedHost } from "../util/http.js";
import { readEnvVar } from "../util/env.js";
import { assertHttpsOrigin, assertInstanceOrigin } from "../auth/config.js";
import {
  resolveActiveProfile,
  assertValidProfileName,
  describeProfileSelection,
  DEFAULT_PROFILE,
  type ProfileSelection,
} from "../auth/profile-select.js";
import {
  resolveProjectProfile,
  findPointerFile,
  findProjectPointer,
  writePointerFile,
  projectRootFor,
  POINTER_FILE,
} from "../auth/profile-pointer.js";
import { ensureGitignoredOrWarn } from "./gitignore.js";
import { confirmDanglingRemoval, revokeProfileSession, revocableRecord, revokeFields, signInAgain, type RevokeOutcome } from "./logout-command.js";
import { readEphemeralState } from "../deploy/ephemeral-state.js";
import { projectDirFrom } from "./xanosdk-project.js";
import { isMachineOutput, writeJson } from "./output.js";
import { promptLine, readStdin } from "./prompt.js";
import { UsageError, unknownSubcommand, missingArgument } from "./errors.js";
import { suggest } from "./commands.js";
import { suggestAll } from "../util/suggest.js";
import { shellQuote } from "../util/shell-quote.js";
import { pipedYes, retryCommand } from "./retry-command.js";
import {
  credentialRejected,
  environmentCredentialVars,
  notSignedIn,
  ProfileNotFoundError,
  warnIfReadableByOthers,
} from "../auth/token.js";
import { step, success, info, warn, detail, formatFields, stdoutStyle, printHuman, quotedNames, safeText } from "./ui.js";

export async function runProfileCommand(args: ParsedArgs): Promise<void> {
  switch (args.subcommand) {
    case "list":
      return listProfiles(args);
    case "show":
      return showProfile(args);
    case "use":
      return useProfile(args);
    case "set-default":
      return setDefaultProfile(args);
    case "add":
      return addProfile(args);
    case "delete":
      return deleteProfile(args);
    default:
      throw unknownSubcommand("profile", args.subcommand);
  }
}

/**
 * The ONE credential file this family acts on.
 *
 * Read-mode resolution — a project-local `./.xano/auth.json` when it exists,
 * else the shared global one — for every verb, READS AND WRITES ALIKE. That is
 * deliberately different from `login`/`logout`, which target a definite cache so
 * a project-local file cannot capture a global sign-in: these verbs manage the
 * profiles a command in THIS directory will actually use, and `profile list`
 * showing one file while `profile delete` removed from another is the confusion
 * worth designing out. `--config` and `--local-auth` still override.
 */
function profileFilePath(args: ParsedArgs): string {
  return resolveAuthFilePath(args, "read");
}

/** The file a `profile` verb acts on, and whether anything is stored in it yet. */
function openFile(args: ParsedArgs): { path: string; file: CredentialFile } {
  const path = profileFilePath(args);
  const file = readCredentialFile(path);
  // `profile list`/`show` read the tokens as every signed-in command does, so a
  // file others can read is said here too — it was not, only on the others.
  if (file !== null) warnIfReadableByOthers(path);
  return { path, file: file ?? emptyCredentialFile() };
}

/**
 * Which profile the verbs report as ACTIVE — the same ladder `getAccessToken`
 * resolves, minus the environment-credential arms it has no business reading
 * here. Resolved from the same module, so `profile list`'s marker cannot
 * disagree with what the next command actually acts as.
 */
function activeSelection(args: ParsedArgs, file: CredentialFile, path: string): ProfileSelection {
  return resolveActiveProfile({
    flag: args.profile,
    fileDefault: file.default,
    defaultIn: path === globalAuthFilePath() ? undefined : path,
    readPointer: () => resolveProjectProfile(process.cwd()),
  });
}

/**
 * The profile a run with nothing else selecting falls back to: the file's
 * `default` key, or the literal `default` when the file names none — the rung
 * `whoami` reports as "(the default)". Keyed the same here, so `profile show`
 * cannot say "Default no" about the profile every bare command acts as.
 */
function isDefaultProfile(file: CredentialFile, name: string): boolean {
  return (file.default ?? DEFAULT_PROFILE) === name;
}

/** Tenants this project tracked under `profile`, across every workspace — each with the host and workspace it keys under. */
function environmentsFor(profile: string): { name: string; host: string; workspace: string }[] {
  // The project's records, from a subdirectory of it too.
  const state = readEphemeralState(projectDirFrom(process.cwd()) ?? process.cwd());
  return Object.entries(state.environments)
    .filter(([key]) => key.startsWith(`${profile}/`))
    .map(([key, record]) => {
      const [, host = "", workspace = ""] = key.split("/");
      return { name: record.name, host, workspace };
    });
}

/** The first stored profile addressing workspace `workspace` on instance host `host` — an ephemeral key's halves. */
function profileReaching(profiles: Record<string, unknown>, host: string, workspace: string): string | undefined {
  for (const [profile, raw] of Object.entries(profiles)) {
    const record = raw as { instance?: unknown; instance_base_url?: unknown; workspace_id?: unknown } | null;
    const instance = record?.instance ?? record?.instance_base_url;
    if (typeof instance !== "string" || String(record?.workspace_id) !== workspace) continue;
    try {
      if (new URL(instance).host === host) return profile;
    } catch {
      // An instance that is not a URL addresses nothing a key can name.
    }
  }
  return undefined;
}

/** The positional a verb requires, validated as a profile name. */
function requiredName(args: ParsedArgs, verb: string): string {
  const name = args.positionals[0];
  if (name === undefined) {
    throw missingArgument("name", { command: "profile", subcommand: verb });
  }
  validName(name, verb);
  return name;
}

/**
 * A name that could never be a profile is fixed by retyping it, so it is a
 * usage failure (`SDK_USAGE`). The validator throws a plain error because the
 * same rule also judges `XANO_PROFILE` and pointer files, which nobody typed.
 */
function validName(name: string, verb: string): void {
  try {
    assertValidProfileName(name, `xanosdk profile ${verb}`);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err), {
      hintFor: { command: "profile", subcommand: verb },
    });
  }
}

/**
 * Whose default a file's `default` key is: the machine's for the shared file,
 * that file's for a `--config`/`--local-auth` one — the words `login` uses.
 */
function defaultOf(path: string): string {
  return path === globalAuthFilePath() ? "this machine's default" : `the default profile in ${path}`;
}

/** "No profiles" is a state every verb can land in, and it has one remedy. */
function assertAnyProfiles(file: CredentialFile, path: string): void {
  if (profileNames(file).length > 0) return;
  throw new ProfileNotFoundError(`No credential profiles are stored in ${path}. ${signInLine(path)}`);
}

/**
 * A name that must already exist, with the available ones listed when it does not.
 *
 * No help block under it, nor under the other refusals in this file that name
 * their own remedy: the command was typed correctly and the stored state said
 * no, so the verb's usage lists nothing that would have worked.
 */
function existingName(file: CredentialFile, name: string, path: string, verb: "show" | "use" | "set-default"): void {
  if (hasProfile(file, name)) return;
  // The stored names say what else would work; the add line is how to make THIS
  // one work — the remedy `whoami -p <name>` gives for the same absence. A near
  // miss is named with this verb's command for it, as `profile delete` names
  // one (E2E pass 25): a typo is likelier than a profile never added.
  const have = profileNames(file);
  const near = suggest(name, have);
  const err = new ProfileNotFoundError(
    `No credential profile "${name}" in ${path}.` +
      (have.length === 0 ? "" : ` Stored profiles: ${quotedNames(have)}.`) +
      (near === undefined
        ? ""
        : ` Did you mean "${safeText(near)}"? \`xanosdk profile ${verb} ${shellQuote(near)}${credentialFileFlag(path)}\`.`) +
      ` Add it with ${addProfileHint(name, { path })}.`,
  );
  // The `--json` failure document's `suggestion`, as `whoami -p <typo>` carries it.
  if (near !== undefined) Object.defineProperty(err, "suggestion", { value: near, enumerable: true });
  throw err;
}

function hasProfile(file: CredentialFile, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(file.profiles, name);
}

/** What IS stored, or the sign-in that would store something. */
function storedNamesLine(file: CredentialFile, path: string): string {
  const have = profileNames(file);
  return have.length === 0 ? signInLine(path) : `Stored profiles: ${quotedNames(have)}.`;
}

/**
 * The two ways to store a first profile IN `path` — carrying `--config` or
 * `--local-auth` when it is not the shared file, since a bare `xanosdk login` would
 * sign into that one instead.
 */
function signInLine(path: string): string {
  const flag = credentialFileFlag(path);
  return (
    `Run \`xanosdk login${flag}\` to sign in, or \`xanosdk profile add <name>${flag}\` to store a meta API token.`
  );
}

/**
 * Refuse to make a profile no command could use the machine's default. The
 * write succeeds on its own, and then every later bare command fails — far from
 * the step that caused it. Same reading `profile show` does, plus the https rule
 * every resolve applies. (`use` is not gated: the pointer it writes is committed
 * and read on other machines, where that profile may be perfectly fine.)
 */
function usableName(file: CredentialFile, name: string, path: string, verb: "set-default"): void {
  const described = describeProfile(file, name, path);
  let problem = "error" in described ? described.error : undefined;
  if ("record" in described) {
    const r = described.record;
    try {
      assertHttpsOrigin(r.type === "token" ? r.instance_base_url : r.instance, "Its instance");
    } catch (err) {
      problem = (err as Error).message;
    }
  }
  if (problem === undefined) return;
  const raw = file.profiles[name] as { type?: unknown } | undefined;
  const fix =
    raw?.type === "token"
      ? `\`xanosdk profile add ${name}${credentialFileFlag(path)} --instance <url> --workspace-id <id> --force\``
      : `\`${loginCommand(name, { path }, ["--force"])}\``;
  throw new UsageError(
    `Profile "${name}" cannot be used, so it was not made ${defaultOf(path)}: ` +
      `${problem.replace(/\s+$/, "")}\nRepair it with ${fix}, or pick another from \`xanosdk profile list${credentialFileFlag(path)}\`.`,
    { hintFor: { command: "profile", subcommand: verb } },
  );
}

// ── list ──────────────────────────────────────────────────────────────────

/** One row of `profile list` — what it addresses, or why it could not be read. */
interface ProfileRow {
  name: string;
  /** Present unless the entry is malformed. */
  instance?: string;
  workspaceId?: number;
  credentialType?: "oauth" | "token";
  /** Why this entry could not be parsed. Rendered rather than thrown. */
  invalid?: string;
  isDefault: boolean;
  isActive: boolean;
}

/** `activeName` undefined marks no row active — an environment credential is in use. */
function rowsFor(file: CredentialFile, path: string, activeName: string | undefined): ProfileRow[] {
  return profileNames(file).map((name) => {
    const base = { name, isDefault: isDefaultProfile(file, name), isActive: activeName === name };
    const described = describeProfile(file, name, path);
    if ("error" in described) return { ...base, invalid: described.error };
    const record = described.record;
    return {
      ...base,
      instance: record.type === "token" ? record.instance_base_url : record.instance,
      workspaceId: record.workspace_id,
      credentialType: record.type,
    };
  });
}

async function listProfiles(args: ParsedArgs): Promise<void> {
  const { path, file } = openFile(args);
  // A complete environment credential outranks every stored profile: every
  // command here uses IT, so no row is active — reporting the file's default
  // as active described a profile nothing reads.
  const envCredential = environmentCredentialVars();
  const env = envCredential.complete ? envCredential.vars : undefined;
  const active = activeSelection(args, file, path);
  const rows = rowsFor(file, path, env === undefined ? active.name : undefined);

  if (isMachineOutput(args) && env !== undefined) {
    writeJson({
      path,
      default: file.default ?? null,
      active: null,
      source: "environment",
      environmentCredential: true,
      environmentVariables: env,
      profiles: rows,
    });
    return;
  }
  if (isMachineOutput(args)) {
    // `active` names a STORED profile, or is null: on a file with no default the
    // ladder answers the implicit `default`, and reporting that as active would
    // describe a profile that does not exist. One chosen by name (flag, pointer,
    // XANO_PROFILE) that is not stored is carried as `missing`, so the choice
    // is not lost with it.
    const stored = hasProfile(file, active.name);
    // The `!` line too, so the document's `warnings[]` carries it as text does.
    noteMissingSelection(file, active, path);
    writeJson({
      path,
      default: file.default ?? null,
      active: stored ? active.name : null,
      source: active.source,
      ...(stored || active.source === "implicit" ? {} : { missing: active.name }),
      profiles: rows,
    });
    return;
  }
  const envLine = (): void => {
    if (env !== undefined) {
      info(`The environment credential (${env.join(", ")}) is in use; stored profiles are ignored.`);
    }
  };
  if (rows.length === 0) {
    info(`No credential profiles are stored in ${path}.`);
    if (env !== undefined) return envLine();
    detail(signInLine(path));
    noteMissingSelection(file, active, path);
    return;
  }
  const s = stdoutStyle();
  // Columns padded to the widest row, so instances of different lengths still
  // line up the workspace and the marks after them. Padded BEFORE styling: the
  // escape codes would otherwise count toward the width.
  const meta = (row: (typeof rows)[number]): string => `workspace ${row.workspaceId} · ${row.credentialType}`;
  const valid = rows.filter((row) => row.invalid === undefined);
  const instanceWidth = Math.max(0, ...valid.map((row) => String(row.instance).length));
  const metaWidth = Math.max(0, ...valid.map((row) => meta(row).length));
  printHuman(
    "\n" +
      formatFields(
        rows.map((row) => {
          // Each piece styled on its own: every style ends in a full reset, so a
          // green "active" inside a dim "(…)" left ", default)" undimmed (E2E pass 28).
          const marks = [row.isActive ? s.green("active") : undefined, row.isDefault ? s.dim("default") : undefined]
            .filter(Boolean)
            .join(s.dim(", "));
          const body =
            row.invalid !== undefined
              ? s.yellow(`invalid — ${row.invalid}`)
              : marks === ""
                ? `${String(row.instance).padEnd(instanceWidth)}  ${s.dim(meta(row))}`
                : `${String(row.instance).padEnd(instanceWidth)}  ${s.dim(meta(row).padEnd(metaWidth))}`;
          return [row.name, marks === "" ? body : `${body} ${s.dim("(")}${marks}${s.dim(")")}`];
        }),
      ),
  );
  detail(`From ${path}`);
  if (env !== undefined) return envLine();
  noteMissingSelection(file, active, path);
}

/**
 * The line the `--json` document's `missing` carries. A pin, `--profile`,
 * `$XANO_PROFILE` or a stored default naming a profile that is not here marks
 * no row active — and a list with no active row reads as "nothing selected",
 * when in fact every bare command in this directory fails on that name.
 */
function noteMissingSelection(file: CredentialFile, active: ProfileSelection, path: string): void {
  if (active.source === "implicit" || hasProfile(file, active.name)) return;
  warn(
    `${describeProfileSelection(active)} is selected here but not stored in ${path}, so no profile is active — ` +
      `commands here fail until it is added or another is selected.`,
    "profile.missing",
  );
}

// ── show ──────────────────────────────────────────────────────────────────

async function showProfile(args: ParsedArgs): Promise<void> {
  const { path, file } = openFile(args);
  // A NAMED profile on an empty file is a missing named thing (exit 8); no name
  // falls to the resolver's own answer below — "not signed in" (exit 1) unless
  // a flag, variable or pin chose one — so this and `whoami` exit alike.
  if (args.positionals[0] !== undefined) assertAnyProfiles(file, path);
  // No name typed and a complete environment credential: that is what every
  // command here uses, so it is the answer — as `whoami` and `profile list` say.
  if (args.positionals[0] === undefined && environmentCredentialVars().complete) return showEnvironmentCredential(args);
  const active = activeSelection(args, file, path);
  const name = args.positionals[0] ?? active.name;
  validName(name, "show");
  // No name typed: the one missing is whatever the ladder chose, and its
  // remedy depends on the rung — a deleted default is fixed by
  // `profile set-default`, a pin by `profile use`. The resolver's own sentence,
  // so this and `whoami` say the same thing.
  if (args.positionals[0] === undefined && !hasProfile(file, name)) throw notSignedIn(path, file, active);
  existingName(file, name, path, "show");

  // Throws on a malformed entry: `show` is the verb that answers "what IS this",
  // so the parse error IS the answer. `list` is the one that must render it.
  const record = readProfile(file, name, path)!;
  const view = {
    name,
    path,
    // Deliberately no token field of any kind, in either mode. The command that
    // displays a credential is the last place one should reach a CI log.
    credentialType: record.type,
    instance: record.type === "token" ? record.instance_base_url : record.instance,
    workspaceId: record.workspace_id,
    isDefault: isDefaultProfile(file, name),
    isActive: active.name === name,
    ...(record.type === "oauth" ? { expiresAt: record.expires_at, scope: record.scope ?? null } : {}),
  };
  if (isMachineOutput(args)) {
    writeJson(view);
    return;
  }
  const s = stdoutStyle();
  printHuman(
    "\n" +
      formatFields([
        ["Profile", s.bold(name) + (view.isActive ? s.dim(" (active)") : "")],
        ["Instance", s.bold(s.cyan(view.instance))],
        ["Workspace", String(view.workspaceId)],
        ["Credential", record.type === "token" ? "meta API token" : "OAuth"],
        ["Default", view.isDefault ? "yes" : "no"],
      ]),
  );
  detail(`From ${path}`);
}

/** `profile show` with the environment credential in use: what it names, never the token. */
function showEnvironmentCredential(args: ParsedArgs): void {
  const { vars } = environmentCredentialVars();
  const instance = readEnvVar("XANO_INSTANCE_URL") ?? null;
  const workspace = readEnvVar("XANO_WORKSPACE_ID");
  const view = {
    name: null,
    source: "environment",
    environmentVariables: vars,
    credentialType: vars.includes("XANO_META_TOKEN") ? "token" : "oauth",
    instance,
    workspaceId: workspace === undefined || !isSafeIdText(workspace) ? (workspace ?? null) : Number(workspace),
    isActive: true,
  };
  if (isMachineOutput(args)) {
    writeJson(view);
    return;
  }
  const s = stdoutStyle();
  printHuman(
    "\n" +
      formatFields([
        ["Credential", `${view.credentialType === "token" ? "meta API token" : "OAuth"} ${s.dim("(environment, active)")}`],
        ...(instance === null ? [] : [["Instance", s.bold(s.cyan(instance))] as [string, string]]),
        ...(workspace === undefined ? [] : [["Workspace", workspace] as [string, string]]),
      ]),
  );
  detail(`From ${vars.join(", ")} — stored profiles are ignored while they are set.`);
}

// ── use / set-default ─────────────────────────────────────────────────────

async function useProfile(args: ParsedArgs): Promise<void> {
  const name = requiredName(args, "use");
  const { path, file } = openFile(args);
  existingName(file, name, path, "use");
  // A pointer pins a PROJECT. Written outside one it lands in the working
  // directory — `~/xano.profile.json` — and is then read from every
  // non-project directory beneath it, overriding the machine default.
  const root = projectRootFor(process.cwd());
  if (root === undefined) {
    throw new UsageError(
      `\`profile use\` pins a project, and ${process.cwd()} is not inside one — no package.json, .git or ` +
        `${POINTER_FILE} above it short of the home directory. Run it from the project's directory, or make ` +
        `"${name}" this machine's default with \`xanosdk profile set-default ${name}${credentialFileFlag(path)}\`.`,
    );
  }
  const written = writePointerFile(root, name);
  // The mutating verbs report on stdout too: an agent scripting this should not
  // have to run a second command to learn what changed.
  // The outcome on stderr either way: a piped run's reader sees what changed too.
  success(`This project now uses profile "${name}".`);
  // Says THIS PROJECT, against `set-default`'s THIS MACHINE: the two verbs are
  // one keystroke apart and the output is where that is settled.
  detail(`Wrote ${written} — commit it so the rest of the project uses it too.`);
  // The other verb, spelled for the same file: a bare `set-default` acts on
  // the shared file, where a profile only in this `--config` one is not found.
  detail(
    `It holds a profile name and no credentials. To change ${defaultOf(path)} instead, ` +
      `run \`xanosdk profile set-default ${name}${credentialFileFlag(path)}\`.`,
  );
  if (isMachineOutput(args)) writeJson({ verb: "use", profile: name, pointer: written });
}

async function setDefaultProfile(args: ParsedArgs): Promise<void> {
  const name = requiredName(args, "set-default");
  const path = profileFilePath(args);
  // Checked before the lock: taking it creates the file's directory, and a
  // name that is not stored writes nothing, so it must leave no trace either.
  existingName(readCredentialFile(path) ?? emptyCredentialFile(), name, path, "set-default");
  // Whether the key already named it: "is now the default" for a run that
  // changed nothing read as a change, and a script could not tell the two.
  let changed = false;
  await withCredentialLock(path, (file) => {
    existingName(file, name, path, "set-default");
    usableName(file, name, path, "set-default");
    changed = file.default !== name;
    if (!changed) return;
    file.default = name;
    writeCredentialFile(path, file);
  });
  const pointer = pinOtherThan(name);
  // The outcome on stderr either way: a piped run's reader sees what changed too.
  if (changed) {
    success(`Profile "${name}" is now ${defaultOf(path)}.`);
    // The path once: a non-machine file's headline already names it.
    if (path === globalAuthFilePath()) detail(`Set in ${path}.`);
  } else {
    info(`Profile "${name}" is already ${defaultOf(path)} — nothing changed.`);
  }
  // The pointer outranks the default, so a set-default that changes nothing
  // here would otherwise read as having taken effect.
  // The pin's `!` line rides in `warnings[]` beside `shadowedByPointer`.
  if (pointer !== undefined) warnPinWins(pointer, name, path);
  if (isMachineOutput(args)) {
    writeJson({ verb: "set-default", profile: name, path, changed, shadowedByPointer: pointer ?? null });
  }
}

/** `profile.project-pin-wins`: the project's pin, not the default just set, is what runs here. */
function warnPinWins(pointer: string, name: string, path: string): void {
  warn(
    `This project pins its own profile in ${pointer}, which still wins here. ` +
      `Run \`xanosdk profile use ${name}${credentialFileFlag(path)}\` to change the project too.`,
    "profile.project-pin-wins",
  );
}

/**
 * The pointer file that outranks the default AND names another profile, if
 * there is one. A pin naming `name` already acts as it, so warning would tell
 * the reader to run a `profile use` that changes nothing. An unreadable pointer
 * still counts: it fails every run here, whatever the default says.
 */
function pinOtherThan(name: string): string | undefined {
  try {
    const pin = findProjectPointer(process.cwd());
    return pin !== undefined && pin.profile !== name ? pin.path : undefined;
  } catch {
    return findPointerFile(process.cwd());
  }
}

// ── add ───────────────────────────────────────────────────────────────────

/**
 * Store a hand-held meta API token under a name.
 *
 * The token is read from piped stdin or the terminal, never from a flag, for
 * the same reason no command takes one: a secret on a command line lands in the
 * process list, the shell history, and the CI log. The instance and workspace
 * are flags — neither is a secret, and both are what a script would want to
 * pass. Both are checked before the token is read, and the token is checked
 * against the instance before anything is stored.
 */
async function addProfile(args: ParsedArgs): Promise<void> {
  const name = requiredName(args, "add");
  const path = profileFilePath(args);

  const credential = (token: string): TokenCredential =>
    buildTokenCredential(
      {
        instance: args.instance,
        // The raw string is passed through on a bad parse so the rejection quotes
        // what was typed rather than `NaN` — the env triple's reason, unchanged.
        workspaceId:
          args.workspaceId !== undefined && isSafeIdText(args.workspaceId)
            ? Number(args.workspaceId.trim())
            : args.workspaceId,
        token,
      },
      {
        at: `for \`xanosdk profile add ${name}\``,
        labels: { instance: "--instance", workspace: "--workspace-id", token: "the token" },
        fix:
          `Pipe the token alone, on one line: ` +
          `\`printf %s "$TOKEN" | ${retryCommand(args, { command: `profile add ${name}` }).command}\`.`,
      },
    );
  // The flags are checked FIRST — before the token is asked for, and before the
  // file is: a typo in either would otherwise surface only after someone had
  // gone and pasted a secret, or behind "already exists" for a command whose
  // --instance could never have worked. Every refusal here is fixed by retyping a
  // flag, so it is a usage failure.
  try {
    // An origin, like `login --origin`: a user name/password or a path was
    // stripped silently and the token verified against the bare host.
    if (typeof args.instance === "string") {
      assertInstanceOrigin(args.instance.trim(), `\`--instance\` for \`xanosdk profile add ${name}\``);
    }
    // A placeholder token: only the flags are checked here.
    credential("x");
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err), {
      hintFor: { command: "profile", subcommand: "add" },
    });
  }

  // Refuse to replace an existing profile silently. `--force` (not `--yes`)
  // because this OVERWRITES something that exists, which is what that flag
  // means everywhere else in this CLI.
  // Before the token is asked for: a file this user cannot write would
  // otherwise fail with a raw EACCES after the secret was pasted and checked.
  assertCredentialFileWritable(path);
  const existingFile = readCredentialFile(path) ?? emptyCredentialFile();
  const displaced = Object.prototype.hasOwnProperty.call(existingFile.profiles, name);
  if (displaced && !args.force) {
    throw new UsageError(
      `Profile "${name}" already exists in ${path}. Pass \`--force\` to replace it, or choose ` +
        `another name. Run \`xanosdk profile show ${name}${credentialFileFlag(path)}\` to see what it addresses.`,
    );
  }

  const record = credential(await readToken(name, args));
  // Checked against the instance before it is stored: a mistyped or revoked
  // token would otherwise sit in the file until the first real command failed.
  // The workspace too — a well-formed but wrong id is the same silent failure.
  await verifyToken(record, name);
  await verifyWorkspace(record, name);

  let isFirst = false;
  let isDefault = false;
  await withCredentialLock(path, async (file) => {
    // Revoke what we are about to overwrite, in the same order `delete` uses:
    // a replaced OAuth profile would otherwise leave a live, replayable refresh
    // token on the authorization server that the CLI can no longer reach.
    const replaced = revocableRecord(file, name, path);
    if (replaced !== undefined) {
      step(`Revoking the session that profile "${name}" held…`);
      await revokeProfileSession(args, replaced, name, "replace");
    }
    isFirst = profileNames(file).length === 0;
    file.profiles[name] = record;
    if (isFirst) file.default = name;
    // A --force replacing the default keeps it the default: report what the
    // file says, not whether this was the first profile.
    isDefault = isDefaultProfile(file, name);
    writeCredentialFile(path, file);
  });

  // BEFORE the output branch, on every path: the credential is on disk now, and
  // a piped or `--json` run (an agent, CI) is exactly the one that must not
  // leave a project-local token one `git add` from a commit. Its outcome goes
  // to stderr; the document carries it as `gitignored`.
  const gitignored = ensureGitignoredOrWarn(path);
  if (args.local) warnIfLocalShadowsPin(path, name);
  // The outcome on stderr either way: a piped run's reader sees what changed too.
  success(`Stored profile "${name}" — ${record.instance_base_url}, workspace ${record.workspace_id}.`);
  detail(`Saved to ${path}`);
  const fileFlag = credentialFileFlag(path);
  if (isFirst) detail(`It is ${defaultOf(path)}, since it is the only profile stored.`);
  else if (isDefault) detail(`It is still ${defaultOf(path)}.`);
  else {
    // `profile use` refuses outside a project, so it is offered only inside one.
    const pin = projectRootFor(process.cwd()) === undefined ? "" : `, or pin this project with \`xanosdk profile use ${name}${fileFlag}\``;
    detail(`Select it with \`--profile ${name}${fileFlag}\`${pin}.`);
  }
  if (isMachineOutput(args)) {
    writeJson({
      verb: "add",
      profile: name,
      path,
      instance: record.instance_base_url,
      workspaceId: record.workspace_id,
      isDefault,
      replaced: displaced,
      gitignored,
    });
  }
}

/**
 * A project-local file that holds any profile is read INSTEAD of the shared
 * one, so adding the first profile to it can strand the project's pin: the
 * pinned name lives in the shared file, and commands here stop finding it.
 * Said at the moment it happens, with the command that undoes it.
 */
function warnIfLocalShadowsPin(localPath: string, added: string): void {
  const pin = findProjectPointer(process.cwd());
  if (pin === undefined || pin.profile === added) return;
  const local = readCredentialFile(localPath);
  if (local === null || profileNames(local).includes(pin.profile)) return;
  const sharedPath = globalAuthFilePath();
  let shared: CredentialFile | null = null;
  try {
    shared = readCredentialFile(sharedPath);
  } catch {
    return;
  }
  if (shared === null || !profileNames(shared).includes(pin.profile)) return;
  warn(
    `This project pins profile "${pin.profile}" (${pin.path}), which is in ${sharedPath} but not in ${localPath}. ` +
      `Commands here now read ${localPath} instead, so "${pin.profile}" no longer resolves.`,
    "profile.local-shadows-pin",
    [
      `Undo with \`xanosdk profile delete ${added} --local-auth\`, or re-pin to the new profile with ` +
        `\`xanosdk profile use ${added} --local-auth\`.`,
    ],
  );
}

/**
 * The token for `profile add <name>`: piped on stdin when stdin is not a
 * terminal (`printf %s "$TOKEN" | xanosdk profile add ci …`), else asked for with
 * the echo masked. Never a flag — see {@link addProfile}.
 */
async function readToken(name: string, args: ParsedArgs): Promise<string> {
  const stdin = await readStdin();
  if (stdin !== undefined) {
    const piped = stdin.trim();
    if (piped === "") {
      throw new UsageError(
        `\`xanosdk profile add ${name}\` reads the meta API token from stdin when it is not a terminal, ` +
          `and stdin was empty. Pipe the token in (\`printf %s "$TOKEN" | ${retryCommand(args, { command: `profile add ${name}` }).command}\`), ` +
          `or run it in a terminal to be asked for it.`,
        { hintFor: { command: "profile", subcommand: "add" } },
      );
    }
    return piped;
  }
  return promptLine(`Meta API token for profile "${name}":`, {
    mask: true,
    noTtyHint:
      "A token must not be passed as a flag — it would land in the process list and the shell " +
      "history. Pipe it on stdin instead, or for automation set XANO_INSTANCE_URL / " +
      "XANO_WORKSPACE_ID / XANO_META_TOKEN.",
  });
}

/** Bound the token check so a stalled instance cannot hang `profile add`. */
const VERIFY_TIMEOUT_MS = 30_000;

/**
 * Ask the instance whether it accepts `record`'s token — the same `auth/me`
 * read `whoami` makes. A refusal throws and nothing is stored.
 */
async function verifyToken(record: TokenCredential, name: string): Promise<void> {
  const url = new URL("/api:meta/auth/me", record.instance_base_url).href;
  const res = await fetchOrExplain(
    url,
    {
      headers: { Authorization: `Bearer ${record.meta_api_token}` },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    },
    `profile add ${name}`,
    VERIFY_TIMEOUT_MS,
  ).catch((err: unknown) => {
    // A host name that does not resolve is the `--instance` value, not the
    // network: "Nothing was changed — retry" would retry the same typo forever.
    if (errorCodeIn(err) !== "ENOTFOUND" || redirectedUnresolvedHost(err, url) !== undefined) {
      return unansweredProfileRead(err, name).then((e) => Promise.reject(e));
    }
    throw new UsageError(
      `profile add ${name}: the host of ${record.instance_base_url} does not resolve (ENOTFOUND), so nothing ` +
        `was stored. Check the \`--instance\` URL — it is your instance's origin, e.g. https://x8ki-letl-twmt.n7.xano.io.`,
      { hintFor: { command: "profile", subcommand: "add" } },
    );
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    // SDK_CREDENTIAL_REJECTED, as every other refused credential is: the command
    // was typed right; the instance said no. No `signIn` — the fix is the same
    // command with a valid token, not a different one.
    throw credentialRejected(
      new Error(
        `${record.instance_base_url} rejected the token for profile "${name}" (HTTP ${res.status}), so ` +
          `nothing was stored. Check it is a meta API token issued by that instance and that it has not ` +
          `expired or been revoked.`,
      ),
      {
        profile: name,
        credentialType: "token",
        instance: record.instance_base_url,
        workspaceId: record.workspace_id,
        signIn: null,
      },
    );
  }
  if (!res.ok) throw await unansweredVerify(res, text, name);
}

/**
 * A verification the instance did not answer — a server error (5xx), its rate
 * limit (429) — or any other refusal, as the error `profile add` ends on.
 * The unanswered kinds exit 8 with this command as the rerun, as every other
 * account command's read does; nothing was stored either way.
 */
async function unansweredVerify(res: Response, text: string, name: string): Promise<Error> {
  const failed = Object.assign(new Error(httpFailure(`profile add ${name}`, res, text)), { status: res.status });
  return (await unansweredProfileRead(failed, name)) as Error;
}

/** `err` — a verification read that got no answer — as exit 8 with the rerun; anything else as it is. */
async function unansweredProfileRead(err: unknown, name: string): Promise<unknown> {
  const { isUnansweredLookup, LookupFailedError, unansweredCause } = await import("./source-resolve.js");
  if (!isUnansweredLookup(err)) {
    if (err instanceof Error && !(err instanceof UsageError) && !/Nothing was stored\.$/.test(err.message)) {
      err.message = `${err.message}\nNothing was stored.`;
    }
    return err;
  }
  const message = (err instanceof Error ? err.message : String(err)).trim();
  const head = (message.split("\n")[0] ?? message).trim().replace(/[.:]$/, "");
  const failed = new LookupFailedError(
    `Could not verify the token for profile "${name}" — ${head}. ${unansweredCause(err)} — nothing was stored`,
    "unreachable",
    "workspace",
  );
  failed.cause = err;
  return failed;
}

/** The first `code` down an error's cause chain — where a dropped fetch keeps its DNS answer. */
function errorCodeIn(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Ask the instance whether `record`'s token can see the workspace it names —
 * the same workspace list `status` reads to report "cannot see workspace". A
 * token that cannot is refused with the ids it can see, and nothing is stored.
 */
async function verifyWorkspace(record: TokenCredential, name: string): Promise<void> {
  const url = new URL("/api:meta/workspace", record.instance_base_url).href;
  const res = await fetchOrExplain(
    url,
    {
      headers: { Authorization: `Bearer ${record.meta_api_token}` },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    },
    `profile add ${name}`,
    VERIFY_TIMEOUT_MS,
  ).catch(async (err: unknown) => Promise.reject(await unansweredProfileRead(err, name)));
  const text = await res.text();
  if (!res.ok) throw await unansweredVerify(res, text, name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`profile add ${name}: could not parse the workspace list as JSON.\nNothing was stored.`);
  }
  const all = (Array.isArray(parsed) ? parsed : []) as Array<{ id?: unknown; name?: unknown }>;
  if (all.some((w) => w.id === record.workspace_id)) return;
  const visible = all
    .filter((w) => typeof w.id === "number")
    .map((w) => (typeof w.name === "string" ? `${String(w.id)} (${w.name})` : String(w.id)));
  throw new UsageError(
    `The token for profile "${name}" cannot see workspace ${record.workspace_id} on ` +
      `${record.instance_base_url}, so nothing was stored. ` +
      (visible.length === 0
        ? "It can see no workspace at all."
        : `The workspace ids it can see: ${visible.join(", ")}.`) +
      ` Re-run with one of them as \`--workspace-id\`.`,
    { hintFor: { command: "profile", subcommand: "add" } },
  );
}

// ── delete ────────────────────────────────────────────────────────────────

async function deleteProfile(args: ParsedArgs): Promise<void> {
  const name = requiredName(args, "delete");
  const path = profileFilePath(args);
  const file = readCredentialFile(path) ?? emptyCredentialFile();
  // Already gone is the outcome a delete asked for, so it succeeds (exit 0) with
  // `alreadyGone`, like `release delete` and `ephemeral delete`. The warning
  // names what IS stored. A name one slip from a stored profile is most likely
  // that one mistyped, and is answered as those deletes answer it: exit 8 with
  // the suggestion, nothing deleted — a script reading exit 0 took the typo for
  // a done delete.
  if (!hasProfile(file, name)) {
    const nearAll = suggestAll(name, profileNames(file));
    if (nearAll.length > 0) {
      // Each near name as its own delete — never with `--yes`: a near name is a
      // different profile. It confirms when it is the pinned profile, or the
      // default with others left (`confirmDanglingRemoval`'s rule) — said, so
      // the reader knows the command asks.
      const pinned = path === resolve(projectAuthFilePath()) ? findProjectPointer(process.cwd())?.profile : undefined;
      const confirms = (n: string): boolean => (file.default === n && profileNames(file).length > 1) || pinned === n;
      const again = `${args.json === true ? " --json" : ""}${credentialFileFlag(path)}`;
      const meant = nearAll.map(
        (n) => `Did you mean "${safeText(n)}"? \`xanosdk profile delete ${shellQuote(n)}${again}\` deletes it${confirms(n) ? ", after asking to confirm" : ""}.`,
      );
      const err = new ProfileNotFoundError(
        [`No credential profile "${name}" in ${path} — nothing was deleted. ${storedNamesLine(file, path)}`, ...meant].join("\n"),
      );
      Object.defineProperty(err, "suggestion", { value: nearAll[0], enumerable: true });
      if (nearAll.length > 1) Object.defineProperty(err, "suggestions", { value: nearAll, enumerable: true });
      throw err;
    }
    // On stderr whatever stdout is: piped, a miss exited 0 saying nothing a
    // person reading the terminal could see (E2E pass 25).
    warn(`No credential profile "${name}" in ${path} — nothing to delete. ${storedNamesLine(file, path)}`, "profile.not-found");
    if (isMachineOutput(args)) {
      // The same keys a real delete carries, so a script reads one shape.
      writeJson({
        verb: "delete",
        profile: name,
        path,
        deleted: false,
        alreadyGone: true,
        remaining: profileNames(file),
        clearedDefault: false,
        pinnedBy: null,
        orphanedEnvironments: [],
        removedFile: false,
        ...revokeFields({ revoked: null }),
      });
    }
    return;
  }

  // ONE walk: the path shown in the confirmation is provably the file the name
  // came from, which two independent walks could not promise.
  //
  // The pin and the tracked environments hang off the file this project
  // resolves its credentials through. Deleting the name from any OTHER file (a
  // `--config` copy) leaves the project's own profile in place, so the pin
  // stays and nothing is orphaned.
  const pointer = findProjectPointer(process.cwd());
  const isProjectFile = path === resolve(projectAuthFilePath());
  const isDefault = file.default === name;
  const isPinned = isProjectFile && pointer?.profile === name;
  const onMachineFile = path === resolve(globalAuthFilePath());

  // Confirmed when the delete leaves something naming the profile behind — the
  // pin, or the default with other profiles left — the rule `logout` applies.
  const orphansDefault = isDefault && profileNames(file).length > 1 ? path : undefined;
  if (!(await confirmDanglingRemoval(args, "delete", name, isPinned ? pointer : undefined, orphansDefault))) {
    info("Nothing was deleted.");
    return;
  }

  // Revoke BEFORE removing the record: a "deleted" profile that left a live,
  // replayable refresh token on the authorization server is worse than one that
  // is still listed, and the record is what carries the token to revoke.
  // Revoke INSIDE the lock, from the record re-read there, so the token revoked
  // is provably the token removed — a refresh landing in between would rotate
  // it and leave the live one valid. Clears the dangling `default` too: the
  // next command would otherwise fail on a name that is deliberately gone.
  //
  // Includes an entry too broken to parse that still carries a usable token —
  // dropping one unrevoked reports a clean delete over a live session.
  let removedFile = false;
  let revoke: RevokeOutcome = { revoked: null };
  let wasToken = false;
  // The raw entry, kept for the "sign in again" remedy: it names the profile's
  // server (or, for a token profile, its instance and workspace).
  let removedRecord: unknown;
  let remaining: Record<string, unknown> = {};
  const left = await withCredentialLock(path, async (current) => {
    const revocable = revocableRecord(current, name, path);
    removedRecord = current.profiles[name];
    wasToken = (current.profiles[name] as { type?: unknown } | null | undefined)?.type === "token";
    if (revocable !== undefined) {
      step(`Revoking the session for "${name}"…`);
      revoke = await revokeProfileSession(args, revocable, name);
    }
    // The last profile out takes the file with it: an empty project-local file
    // would otherwise sit in front of the shared one.
    removedFile = writeOrRemoveCredentialFile(path, dropProfile(current, name));
    remaining = { ...current.profiles };
    return profileNames(current);
  });
  // After the lock is released: the lock lives beside the file.
  if (removedFile) removeEmptyProjectCacheDir(path);
  // The pointer is KEPT, as `logout` keeps it: it is a committed file the rest
  // of the project (and every clone) reads, and deleting it silently changed
  // which profile a teammate's next command uses (E2E pass 28). Said, with the
  // two ways on.
  if (isPinned && pointer !== undefined) {
    warn(
      `${pointer.path} still pins this project to "${name}", which no longer exists. Pin another profile with ` +
        `\`xanosdk profile use <name>\`, or store "${name}" again with \`${signInAgain(path, name, removedRecord)}\`.`,
      "profile.pin-deleted",
    );
  }

  // A tracked environment keyed to the profile just deleted is now unreachable:
  // nothing will refresh it and nothing lists it, so it runs to its TTL. Said
  // here because this is the moment the user can still act on it.
  const orphaned = isProjectFile ? environmentsFor(name) : [];
  // Its record stays in .xano/ephemeral.json — the handle a delete needs — and
  // the delete clears it, under whichever profile reaches that workspace.
  const unreachable: string[] = [];
  for (const orphan of orphaned) {
    const reacher = profileReaching(remaining, orphan.host, orphan.workspace);
    if (reacher !== undefined) {
      info(
        `The environment "${orphan.name}" was deployed under "${name}"; "${reacher}" reaches the same workspace, ` +
          `so \`xanosdk ephemeral delete ${orphan.name} --profile ${reacher}${pipedYes()}\` still removes it.`,
      );
      continue;
    }
    unreachable.push(orphan.name);
    warn(
      `The environment "${orphan.name}" was deployed under "${name}", and no stored profile reaches it now. ` +
        `It expires on its own; \`xanosdk ephemeral delete ${orphan.name}${pipedYes()}\`, run under a profile for workspace ` +
        `${orphan.workspace} on ${orphan.host}, removes it and this project's record of it now.`,
      "profile.orphan-ephemeral",
    );
  }

  // The outcome on stderr either way: a piped run's reader sees what changed too.
  success(`Deleted profile "${name}".`);
  // Deleting a meta API token profile ends nothing server-side — the words
  // `logout` uses, so "deleted" does not read as "revoked".
  if (wasToken) detail("The meta API token itself is still valid — revoke it at its source if you need it dead.");
  const fileFlag = credentialFileFlag(path);
  if (removedFile) detail(`It was the last profile, so ${path} was removed.`);
  if (left.length === 0) {
    // The same command `logout` prints: this profile's name, file and server —
    // a bare `xanosdk login` recreated `default` on the default host.
    // A project file emptied: commands here fall back to the shared file, so
    // say what still resolves there rather than "nothing is left".
    const shared = isProjectFile ? readCredentialFile(globalAuthFilePath()) : null;
    const sharedNames = shared === null ? [] : profileNames(shared);
    detail(
      sharedNames.length > 0
        ? `No profiles are left in ${path} — commands here now read ${globalAuthFilePath()} ` +
            `(${quotedNames(sharedNames)}). To store one in this project again, run \`${signInAgain(path, name, removedRecord)}\`.`
        : `No profiles are left — run \`${signInAgain(path, name, removedRecord)}\` to sign in again.`,
    );
  } else if (isDefault) {
    detail(
      `${onMachineFile ? "This machine has" : `${path} has`} no default now. Signed in as: ${quotedNames(left)} — ` +
        `set one with \`xanosdk profile set-default ${left.length === 1 ? left[0]! : "<name>"}${fileFlag}\`.`,
    );
  }
  if (isMachineOutput(args)) {
    writeJson({
      verb: "delete",
      profile: name,
      path,
      deleted: true,
      alreadyGone: false,
      remaining: left,
      clearedDefault: isDefault,
      // The `xano.profile.json` still pinning the deleted name — kept, since it
      // is committed; null when none does. The key `logout` carries.
      pinnedBy: isPinned ? (pointer?.path ?? null) : null,
      // Only those no remaining profile reaches: the rest are still deletable as they are.
      orphanedEnvironments: unreachable,
      removedFile,
      ...revokeFields(revoke),
    });
  }
}
