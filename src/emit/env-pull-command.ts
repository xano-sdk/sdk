/**
 * `xanosdk env pull` — fill `xano/.env` from a backend that is RUNNING.
 *
 * This is the only command that writes `xano/.env`, and it exists so that
 * filling in twelve values is not twelve trips to the Xano UI.
 * Everything unusual about it follows from that one fact:
 *
 * - It REPLACES the file wholesale. A partial merge would leave the file in a
 *   state that is neither what the user wrote nor what the workspace holds, with
 *   no way to tell which value came from where.
 * - Because that destroys local edits, it confirms first — naming the SOURCE
 *   (kind and name) and what changes BY NAME: added, replaced, lost. A bare
 *   `env pull` resolves to whatever this project last deployed to, which is not
 *   always the backend the developer has in mind, and `--from` can name
 *   production; a developer expecting dev secrets would otherwise confirm a
 *   routine-looking diff and land live credentials on a laptop. The prompt is
 *   about the FILE, so it asks whatever the kind — a Xano Engine included.
 * - No value is ever printed — not in the prompt, not in the success output, not
 *   in an error. The terminal scrollback of every session that ran the command
 *   is exactly where a secret must not end up, which is also why the export
 *   failure path runs through the SAFE form that never echoes a response body.
 *
 * Node-only (fs + fetch); lazily imported by the dispatcher like its siblings.
 */
import { atomicWrite } from "../util/atomic-write.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ParsedArgs } from "./cli.js";
import { contextFlags } from "./context-flags.js";
import { getAccessToken } from "../auth/token.js";
import { UsageError } from "./errors.js";
import { confirm } from "./prompt.js";
import { detail, info, step, success, warn } from "./ui.js";
import { isMachineOutput, writeJson } from "./output.js";
import { resolveSource, type ResolveDeps, type ResolvedSource } from "./source-resolve.js";
import { requireBackendSlot } from "./backend-slot.js";
import { memoCredential, NothingTrackedError, refuseProfileForLocal, selectBackend } from "./tracked-backend.js";
import { exportWorkspaceBundle } from "../deploy/workspace-export.js";
import { envValuesOf } from "../deploy/live-diff.js";
import { refuseIfTracked, requireSecretPathGitignored } from "./gitignore.js";
import { resolveBackendDir } from "./backend-dir.js";
import { relForwardSlash } from "../util/rel-path.js";
import { shellQuote } from "../util/shell-quote.js";
import {
  isRepresentableName,
  namesInEnvExample,
  readWorkspaceEnvFile,
  renderWorkspaceEnvFile,
  safeNames,
  WORKSPACE_ENV_BASENAME,
  WORKSPACE_ENV_EXAMPLE_BASENAME,
  WORKSPACE_ENV_EXAMPLE_FILE,
  WORKSPACE_ENV_FILE,
} from "./workspace-env.js";

const HELP = { command: "env", subcommand: "pull" } as const;

/** What the overwrite changes, by NAME. Values are never compared aloud. */
function describeChange(
  before: Readonly<Record<string, string>> | undefined,
  after: Readonly<Record<string, string>>,
): { added: string[]; replaced: string[]; lost: string[] } {
  const had = before ?? {};
  const names = new Set(Object.keys(had));
  return {
    added: Object.keys(after).filter((n) => !names.has(n)),
    // A name whose value is the same on both sides is not "replaced" — saying
    // so turned an identical pull into a confirmation about nothing.
    replaced: Object.keys(after).filter((n) => names.has(n) && had[n] !== after[n]),
    lost: Object.keys(had).filter((n) => !Object.hasOwn(after, n)),
  };
}

/** Seams the tests replace; production callers pass nothing. */
export interface EnvPullCommandOptions {
  /** The resolver's seams (hosted lookups, the engine enumeration, where records live). */
  deps?: ResolveDeps;
}

export async function runEnvPullCommand(args: ParsedArgs, opts: EnvPullCommandOptions = {}): Promise<void> {
  const cwd = opts.deps?.cwd ?? process.cwd();
  const deps = { ...opts.deps, cwd };
  // `--from`, else what this project last deployed to. Any running backend: a
  // value is something a backend HOLDS, so the slot takes no bundle path — a
  // bundle's env is whatever it was built with, the stale set this command
  // exists to replace. A credential is fetched only for a hosted kind; a local
  // engine is read with its own bearer, so a signed-out developer can still
  // fill `xano/.env` from the engine they deployed to.
  const slot = requireBackendSlot("env", "pull", "from");
  const credential = memoCredential(() => getAccessToken(args));
  const source = await selectBackend(slot, args.from, { credential, deps }).catch((err: unknown) => {
    // The fresh-clone path — which is exactly where the deploy refusal sends
    // people, so it must not answer them with a second dead end.
    if (err instanceof NothingTrackedError) {
      throw new UsageError(
        `${err.message} Or fill in ${WORKSPACE_ENV_FILE} by hand from ${WORKSPACE_ENV_EXAMPLE_FILE}.`,
        { hintFor: err.hintFor },
      );
    }
    throw err;
  });
  if (source.kind === "file") {
    // The slot does not accept a file, so `parseSlot` has already refused one.
    throw new Error("Internal: `env pull` resolved a bundle file as its source.");
  }
  refuseProfileForLocal(args.profile, [source.kind], slot);
  // Resolved once, up here, because the refusals below fire long before the
  // write and have to name the same file the write will touch. `--backend-dir`
  // is honored for the reason `pull` honors it: discovery declines on a project
  // carrying two backend-shaped directories, and finds nothing on one that has
  // never exported — and this command writes a LIVE SECRET, so "I cannot tell
  // which directory" is not an answer it can act on.
  const backendDir = resolveBackendDir(cwd, args.backendDir, (m) => new UsageError(
    `${m} \`env pull\` writes backend values into the directory it is given.`,
    { hintFor: HELP },
  ));
  const path = join(cwd, backendDir, WORKSPACE_ENV_BASENAME);
  const rel = relForwardSlash(cwd, path) || WORKSPACE_ENV_FILE;

  // BEFORE the network call and before anything is written: a refusal that
  // arrives after the export has already read the secrets is a refusal that
  // cost something.
  if (!existsSync(dirname(path))) {
    // Deliberately not an mkdir: a `xano/` holding nothing but a secrets file
    // is a worse outcome than a refusal, and this is what running from the
    // wrong directory looks like.
    throw new UsageError(
      `No ${backendDir}/ directory, so there is nowhere to put ${rel}. Run this from a ` +
        `project that has one — \`xanosdk init\` writes it, \`xanosdk pull${contextFlags()}\` refreshes it, and ` +
        `\`--backend-dir <path>\` names it when this project keeps its backend somewhere ` +
        `discovery cannot find it.`,
      { hintFor: HELP },
    );
  }

  // UP FRONT, before an authenticated export runs: a file git already tracks
  // cannot be made safe by an ignore rule, so there is no point doing the work.
  refuseIfTracked(path, rel, HELP);

  const resolved: ResolvedSource = await resolveSource(source, credential, deps);
  step(`Reading env from ${resolved.target.label}`);
  const bundle = await exportWorkspaceBundle(resolved.bearer, {
    ...resolved.target,
    label: `Reading env from ${resolved.target.label}`,
    // The no-leak guarantee has to hold on the failure path too.
    safeErrors: true,
  }).catch(async (err: unknown) => {
    const { unansweredRead, actualKind } = await import("./source-resolve.js");
    throw unansweredRead(err, `read the env of ${resolved.target.label}`, actualKind(resolved));
  });

  // `envValuesOf`, not a local reader: this is the one caller that reads a REAL
  // engine archive rather than bytes this SDK wrote, and that shared extractor
  // is where the spellings an engine has actually been seen to use are recorded
  // — env on the workspace object, and bare `NAME=value` strings.
  const values = Object.fromEntries(envValuesOf(bundle));
  // Read only for the by-name summary, so an unparseable file is "unknown
  // previous contents", not a refusal: `env pull` REPLACES the file wholesale,
  // and the one command that would repair a corrupt one must not be the command
  // that refuses to run against it.
  let existing: Record<string, string> | undefined;
  let unreadable = false;
  try {
    existing = readWorkspaceEnvFile(path);
  } catch {
    unreadable = true;
  }
  const change = describeChange(existing, values);
  // The names this project declares that the source holds no value for (E2E
  // pass 29: "Wrote 0 env values" and nothing else, while the next deploy
  // refused a declared name with no value). Read off the config's text, so
  // nothing of the project is evaluated for it; `.env.example` — which a
  // deploy does not rewrite, so it can still list a name the config dropped —
  // only when the config's env cannot be read off the text.
  const { declaredEnvNames, readableDeclaredEnvNames } = await import("./pull-command.js");
  const declared = readableDeclaredEnvNames(dirname(path)) ?? [
    ...new Set([...declaredEnvNames(dirname(path)), ...namesInEnvExample(join(dirname(path), WORKSPACE_ENV_EXAMPLE_BASENAME))]),
  ];
  // Absent only: a value stored empty is written as `NAME=` and deploys as the
  // empty value it is, so it is not "nothing to send".
  const valueless = declared.filter((n) => isRepresentableName(n) && !Object.hasOwn(values, n));
  const sayValueless = (): void => {
    if (valueless.length === 0) return;
    const one = valueless.length === 1;
    const to = args.from !== undefined ? ` --to ${shellQuote(args.from)}` : "";
    warn(
      `${sentenceLabel(resolved)} holds no value for ${safeNames(valueless)}, which this project declares — ` +
        `so ${rel} has none for ${one ? "it" : "them"} either, and a deploy has nothing to send.`,
      "env-pull.declared-missing",
      [
        ...valueless.map(
          (n) => `Set it on the backend (the value on stdin), then pull again: \`xanosdk env set ${n}${to}${contextFlags(args)}\``,
        ),
        `Or add ${one ? "it" : "them"} to ${rel} by hand.`,
      ],
    );
  };

  // The file already holds exactly these values: there is nothing to confirm
  // and nothing to write, `--yes` or not.
  if (
    existing !== undefined &&
    existsSync(path) &&
    change.added.length === 0 &&
    change.replaced.length === 0 &&
    change.lost.length === 0
  ) {
    success(`${rel} is already up to date with ${sourceLabel(resolved)} — nothing to write.`);
    sayValueless();
    if (isMachineOutput(args)) {
      writeJson({
        path: rel,
        source: resolved.provenance,
        written: false,
        upToDate: true,
        names: Object.keys(values),
        omitted: [],
        dropped: [],
      });
    }
    return;
  }

  // Creating a file replaces nothing, so it needs no confirmation.
  if (args.yes !== true && existsSync(path)) {
    info(`${rel} will be REPLACED with the env of ${sourceLabel(resolved)}:`);
    if (unreadable) detail(`the current ${rel} could not be parsed; it will be replaced wholesale`);
    if (change.added.length > 0) detail(`added: ${safeNames(change.added)}`);
    if (change.replaced.length > 0) detail(`value replaced: ${safeNames(change.replaced)}`);
    // Omitted rather than rendered empty when there is nothing to lose.
    if (change.lost.length > 0) detail(`present locally and will be LOST: ${safeNames(change.lost)}`);
    if (Object.keys(values).length === 0) {
      detail(`${sentenceLabel(resolved)} declares no env vars — the file will be written empty.`);
    }
    // Off a terminal: the needs-confirmation refusal, with the exact rerun.
    const { yesRerun } = await import("./retry-command.js");
    const { rerun, note } = yesRerun(args, "env pull");
    const ok = await confirm(`Overwrite ${rel}?`, {
      flag: "--yes",
      refusal: { details: { path: rel, written: false, wouldLose: change.lost.length }, rerun, note },
    });
    if (!ok) {
      // A declined confirmation is not a failure.
      info("Nothing was written.");
      if (isMachineOutput(args)) {
        writeJson({ path: rel, source: resolved.provenance, written: false, upToDate: false, names: [], omitted: [], dropped: [] });
      }
      return;
    }
  }

  // BEFORE the write — the one ordering where a failed ignore is discovered
  // while the file does not yet exist — and as a REFUSAL, not a warning: this
  // is the command that puts live secrets in the working tree.
  // `path`, already resolved at the top of this function. Re-deriving it here
  // would run the whole project walk a second time to reach the same answer.
  requireSecretPathGitignored(path, HELP);
  // Re-checked here, not only up front: the window between the tracked check
  // and the write spans an authenticated export and a confirmation prompt, and
  // a `git add` landing in it would otherwise go unnoticed.
  refuseIfTracked(path, rel, HELP);

  const { content, omitted } = renderWorkspaceEnvFile(
    values,
    { source: sourceLabel(resolved), at: new Date().toISOString() },
    backendDir,
    existsSync(join(dirname(path), WORKSPACE_ENV_EXAMPLE_BASENAME)),
  );
  // Atomic, and 0600 at CREATION. The shared helper stages into a temp file and
  // renames, so a crash can never leave a half-written secrets file — the same
  // reason the credential cache uses it. A write-then-chmod would additionally
  // leave a window in which the file exists at whatever the umask allows.
  atomicWrite(path, content, { mode: 0o600 });

  const written = Object.keys(values).length - omitted.length;
  success(`Wrote ${written} env value${written === 1 ? "" : "s"} to ${rel} from ${sourceLabel(resolved)}.`);
  sayValueless();
  // Said AFTER the write too, and under `--yes` above all: the preview that
  // names them is skipped there, so a local-only key vanished with no word.
  // Not a name `env-pull.declared-missing` just said: that warning names it,
  // with the fix, and a second one here read as the source not declaring it.
  const dropped = change.lost.filter((n) => !valueless.includes(n));
  if (dropped.length > 0) {
    const one = dropped.length === 1;
    warn(
      `Dropped ${dropped.length} key${one ? "" : "s"} that ${one ? "was" : "were"} only in the local ${rel}: ${safeNames(dropped)}. ` +
        `${sentenceLabel(resolved)} holds no value for ${one ? "it" : "them"}.`,
      "env-pull.dropped-keys",
    );
  }
  // A NAME no env var can have is said as the name's fault: it was blamed on
  // the value ("no newlines or edge whitespace"), sending the reader to a value
  // that was fine and to an `--env-var` that now refuses the name.
  const badNames = omitted.filter((n) => !isRepresentableName(n));
  const badValues = omitted.filter((n) => isRepresentableName(n));
  if (badValues.length > 0) {
    warn(
      `${safeNames(badValues)} could not be written: the dotenv format carries no newlines or ` +
        `edge whitespace in a value. Pass ${badValues.length === 1 ? "it" : "each"} at deploy time with ` +
        `\`--env-var NAME=...\` — the value is still in the backend.`,
      "env-pull.unwritable-value",
    );
  }
  if (badNames.length > 0) {
    const one = badNames.length === 1;
    const to = args.from !== undefined ? ` --to ${shellQuote(args.from)}` : "";
    // A name carrying a control character cannot be typed back, and printing it
    // raw is the terminal forgery `safeNames` exists to stop — no command for it.
    // eslint-disable-next-line no-control-regex
    const typeable = badNames.every((n) => !/[\u0000-\u001F\u007F]/.test(n));
    const unset = typeable
      ? ` with ${badNames.map((n) => `\`xanosdk env unset ${shellQuote(n)}${to}${contextFlags(args)}\``).join(", ")}`
      : "";
    warn(
      `${badNames.map((n) => `"${safeNames([n])}"`).join(", ")} could not be written: ${one ? "it is not a usable env var name" : "they are not usable env var names"} ` +
        `— a name is letters, digits and \`_\`, and does not start with a digit. No deploy can supply ` +
        `${one ? "it" : "them"} either. Remove ${one ? "it" : "them"} from ${sourceLabel(resolved)}${unset}, ` +
        `and set the value again under a usable name with \`printf %s "$VALUE" | xanosdk env set NAME${to}${contextFlags(args)}\`.`,
      "env-pull.invalid-name",
    );
  }
  // NAMES only — this document is the one place a value would reach a pipe.
  if (isMachineOutput(args)) {
    const skipped = new Set(omitted);
    writeJson({
      path: rel,
      source: resolved.provenance,
      written: true,
      // Always present, so a reader tests one key rather than its absence.
      upToDate: false,
      names: Object.keys(values).filter((n) => !skipped.has(n)),
      omitted,
      // Keys the file held that the source does not declare, now gone from it.
      dropped: change.lost,
    });
  }
}

/**
 * `tenant:prod-eu`, `local:xanosdk-3f1c`, `your workspace`, `your local
 * engine` — the kind AND the name, never a bare kind. The two credential- and
 * directory-scoped forms read as possessives, since their provenance is a bare
 * kind with no name to add.
 */
export function sourceLabel(resolved: ResolvedSource): string {
  if (resolved.provenance === "workspace") return "your workspace";
  if (resolved.provenance === "local") return "your Xano Engine";
  return resolved.provenance;
}

/**
 * {@link sourceLabel} opening a sentence: `Your workspace …`. A selector
 * (`tenant:prod-eu`) is an identifier and keeps its case.
 */
export function sentenceLabel(resolved: ResolvedSource): string {
  const label = sourceLabel(resolved);
  return label.startsWith("your ") ? `Y${label.slice(1)}` : label;
}
