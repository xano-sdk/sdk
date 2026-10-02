/**
 * Keeping the credential file out of git, and saying so — or saying why not.
 *
 * The try/catch is the point, and it is why this is shared rather than written
 * at each call site: the credential is already durably on disk by the time
 * anyone asks, so a `.gitignore` failure must never fail the command (and thus
 * exit non-zero) on a sign-in that actually succeeded. Two commands write
 * credentials; one wording of that policy.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { addGitignoreRule, ensureGitignored, gitignoreRootFor, gitSaysIgnored, insideGitRepo } from "../auth/store.js";
import { UsageError, type HelpTarget } from "./errors.js";
import { workspaceEnvPathIn } from "./workspace-env.js";
import { detail, warn } from "./ui.js";
import { noteRunWarning } from "./output.js";
import { displayPath, relForwardSlash } from "../util/rel-path.js";
import { shellQuote } from "../util/shell-quote.js";

/**
 * What a credential write reports as `gitignored`: true when the rule was added
 * or was already there, false when it could not be written or git already
 * tracks the file (and a warning said so), and `"not-in-repo"` when the file sits outside every git
 * repository — nothing can commit it, so no `.gitignore` is created or touched.
 */
export type CredentialGitignored = boolean | "not-in-repo";

export function ensureGitignoredOrWarn(authFilePath: string): CredentialGitignored {
  // `ensureGitignored` falls back to the cwd as the root for project
  // scaffolding, which for a credential created `~/.gitignore` holding
  // `.xanosdk/` on a `login` or `profile add` run from a non-repo home directory.
  if (!insideGitRepo(authFilePath)) return "not-in-repo";
  try {
    if (ensureGitignored(authFilePath)) detail("Added the credential file to .gitignore");
  } catch (err) {
    warn(
      `Could not update .gitignore (${err instanceof Error ? err.message : String(err)}). ` +
        `Add ${authFilePath} to your ignore rules manually.`,
      "gitignore.update-failed",
    );
    return false;
  }
  // An ignore rule does nothing to a file git already tracks: the token just
  // written goes out with the next `git commit -a`.
  if (trackedByGit(authFilePath)) {
    warn(
      `${displayPath(authFilePath)} is tracked by git, so its ignore rule cannot keep the token just written ` +
        `out of the next commit. Untrack it (the file stays on disk): \`${untrackCommand(authFilePath)}\`.`,
      "gitignore.credential-tracked",
    );
    return false;
  }
  return true;
}

/** Whether git tracks `path`. No git, no repository, or untracked all answer false. */
function trackedByGit(path: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", path], {
      cwd: dirname(path),
      stdio: ["ignore", "ignore", "ignore"],
      timeout: GIT_PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * `git rm --cached` for `path`, runnable from the working directory: the path
 * as typed from here when the working directory is inside the file's
 * repository, else a `git -C <its directory>` form, since git outside the
 * repository cannot resolve it.
 */
function untrackCommand(path: string): string {
  // Resolved through symlinks, as the working directory is, so a path reached
  // through a symlinked ancestor (macOS `/var`) is still named relative to it.
  let real = resolve(path);
  try {
    real = realpathSync(real);
  } catch {
    /* keep the resolved path */
  }
  const top = gitToplevel(dirname(real));
  const here = gitToplevel(process.cwd());
  if (top !== undefined && top === here) return `git rm --cached ${shellQuote(secretPathLabel(real))}`;
  return `git -C ${shellQuote(displayPath(dirname(real)))} rm --cached ${shellQuote(basename(real))}`;
}

function gitToplevel(dir: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_PROBE_TIMEOUT_MS,
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Keep a secret-bearing export file out of git, and say so — or say why not.
 *
 * Asked of git, and acted on only when git answers "not ignored": outside a
 * repository, or with no git to ask, nothing is touched. The rule names the
 * file alone, never its directory — an export may sit in the author's own
 * `src/` or project root. Non-throwing, as the credential's: the file is
 * already written, so a `.gitignore` failure must not fail the export.
 */
export function ensureExportGitignored(path: string): void {
  if (gitSaysIgnored(path) !== false) return;
  const label = relForwardSlash(process.cwd(), path) || path;
  try {
    // The rule as written: a root-level file's is anchored (`/out.json`), and
    // "Added out.json" named a rule the file does not hold (E2E pass 27).
    const rule = addGitignoreRule(path, { fileOnly: true });
    if (rule !== undefined) {
      const added = `Added ${rule} to ${gitignoreLabel(path)} — ${label} holds secrets.`;
      detail(added);
      // A `--json` reader never sees stderr, and this edited a tracked file
      // (E2E pass 26: the export's warnings[] did not mention it).
      noteRunWarning("gitignore.added-export", added);
    }
  } catch (err) {
    warn(
      `Could not update .gitignore (${err instanceof Error ? err.message : String(err)}). ` +
        `Add ${label} to your ignore rules manually — it holds secrets.`,
      "gitignore.update-failed",
    );
  }
}

/**
 * Keep `xano/.env` out of git, and say so — or say why not.
 *
 * `ensureGitignoredOrWarn` above ignores the file's CONTAINING DIRECTORY when
 * that directory is the dedicated `.xano/` cache, and the directory form is
 * catastrophic for `xano/.env`: it would append
 * `xano/` and un-commit the entire generated backend — silently, since it
 * returns true and throws nothing, so the warning never fires. That directory is
 * the review surface this whole mechanism exists to protect.
 *
 * Same non-throwing posture: the file this covers is already on disk (or about
 * to be), so a `.gitignore` failure must not fail the command that wrote it.
 */
export function ensureWorkspaceEnvGitignored(dir: string): void {
  ensureSecretPathIgnored(workspaceEnvPathIn(dir), "warn");
}

/**
 * The same, for a caller that has ALREADY resolved the path — the warn-posture
 * twin of {@link requireSecretPathGitignored}, and taking a path for the reason
 * that one does.
 *
 * `pull` is the caller: it resolves the directory it is about to replace once,
 * at the top, and everything downstream is handed that answer rather than
 * re-deriving it. A `--backend-dir` this function could not see would leave the rule on
 * the discovered directory while the tree landed in the named one.
 */
export function ensureSecretPathGitignored(path: string, place?: IgnorePlacement): void {
  ensureSecretPathIgnored(path, "warn", undefined, place);
}

/**
 * Where a rule goes when the path's own layout cannot say: a project root other
 * than the backend directory's parent, and the name to call the file by.
 *
 * `generate --out` is the caller. Its tree may sit in a directory that is no
 * project at all, and there the parent is just the cwd — so the rule belongs
 * inside the tree it wrote, not in a `.gitignore` conjured in whatever
 * directory the command happened to run from.
 */
export interface IgnorePlacement {
  root: string;
  label: string;
}

/**
 * The same, as a PRE-CONDITION rather than a courtesy — and taking the RESOLVED
 * path, never a directory to re-resolve from.
 *
 * `init` and `pull` warn: the tree they wrote holds no secrets, so a failed
 * ignore is a thing to fix, not a reason to stop. The commands that reach here
 * write live secrets into the working tree, and for them "the file is ignored"
 * is part of the job — so they refuse rather than warn, the same posture
 * `refuseIfTracked` already takes against the same hazard.
 *
 * Taking the path is not a convenience. The callers that resolved a file from
 * the ENTRY the user named, and then handed this module a DIRECTORY to
 * re-resolve from, were asking two different resolvers the same question — and
 * the two can answer differently, because one reads the named entry and the
 * other discovers a backend from the project root. When they disagreed the rule
 * landed on one file while the secret landed in the other, and the command then
 * reported that secret as ignored. Passing the path makes that unrepresentable.
 *
 * Throws a {@link UsageError} when the rule could not be applied, or when git
 * can be asked and reports the path is still not ignored — which catches the
 * cases a line comparison cannot: a `!` negation later in the file, a nested
 * `.gitignore`, or a path segment carrying gitignore metacharacters that make
 * the appended entry match nothing.
 */
export function requireSecretPathGitignored(path: string, helpFor: HelpTarget, place?: IgnorePlacement): void {
  ensureSecretPathIgnored(path, "refuse", helpFor, place);
}

/**
 * A secret file as a printed command names it: relative to where the user
 * typed, since it is spelled into `git rm --cached <label>` and
 * `git check-ignore <label>`, which resolve against the working directory. A
 * nested backend's file from the repo root is `suites/alpha/xano/.env`, not the
 * root backend's `xano/.env`. Absolute when it is not under the working
 * directory.
 */
export function secretPathLabel(path: string): string {
  return relForwardSlash(process.cwd(), path) || resolve(path);
}

/**
 * The `.gitignore` a rule for `path` lands in, as the working directory names
 * it — `.gitignore` at the repo root, `suites/alpha/.gitignore` for a nested
 * backend outside any repository.
 */
function gitignoreLabel(path: string, root?: string): string {
  return displayPath(join(gitignoreRootFor(path, root === undefined ? {} : { root }), ".gitignore"));
}

/** Bounded, like every other git probe here: a hung git must not hang a command. */
const GIT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Refuse when git already TRACKS the file.
 *
 * An ignore rule adds a pattern, and a pattern does nothing to a file git
 * already tracks — so the whole ignore-and-verify dance below can succeed on a
 * file that is one `git add` from having a plaintext secret in history.
 * `gitSaysIgnored` does not catch it either: `check-ignore` answers about the
 * PATTERN, not about the index.
 *
 * Shared by both secret files. It was written for `xano/.env`, and the sidecar
 * has exactly the same exposure for exactly the same reason.
 *
 * Exported as well as called below, because `env pull` asks TWICE on purpose:
 * once up front so an already-tracked file fails before an authenticated export
 * runs, and once immediately before the write, since the window between them
 * spans that export and a confirmation prompt — and a `git add` landing inside
 * it would otherwise go unnoticed.
 */
export function refuseIfTracked(path: string, label: string, helpFor?: HelpTarget): void {
  // Not tracked, or not a repo, or no git — all three mean "nothing to refuse".
  if (!trackedByGit(path)) return;
  throw new UsageError(
    `${label} is TRACKED by git, and this command is about to write real secrets into it. ` +
      `Adding an ignore rule does nothing to a file git already tracks.\n` +
      `Untrack it first: \`git rm --cached ${label}\` — then re-run.`,
    { helpFor },
  );
}

/**
 * Does a `.gitignore` between the file and the project root carry a slash-free
 * rule naming it?
 *
 * Outside a repository git cannot be asked, and the line comparison behind
 * `ensureGitignored` sees only a rule spelling the path — never the bare
 * `.secrets.json` the scaffold writes, which matches at any depth. So each
 * `secrets fill` in a fresh scaffold appended a redundant `xano/.secrets.json`.
 *
 * Every directory from the file's own up to `root` is read, not only the root:
 * a tree `generate --out ws1` wrote outside a project carries its own
 * `ws1/.gitignore` with bare `.env` / `.secrets.json` rules, and those cover the
 * files just as well once the tree sits in a project — appending `ws1/.env` to
 * the parent's file then is noise that reads as if the tree had been exposed.
 *
 * Deliberately narrow, not a pattern matcher: the rule must be the file's own
 * basename, slash-free, which is exactly the gitignore case of a name matching
 * at every depth below it. Any `!` line mentioning the name makes this answer
 * no, and the append goes ahead as before.
 */
function bareRuleCovers(root: string, path: string): boolean {
  const name = basename(path);
  const top = resolve(root);
  for (let dir = resolve(dirname(path)); ; dir = dirname(dir)) {
    let text: string | undefined;
    try {
      text = readFileSync(join(dir, ".gitignore"), "utf8");
    } catch {
      text = undefined;
    }
    if (text !== undefined) {
      const lines = text.split(/\r?\n/).map((l) => l.trim());
      // A negation anywhere on the way up is a reason to let the append (and,
      // under the refuse posture, git itself) decide rather than to guess.
      if (lines.some((l) => l.startsWith("!") && l.includes(name))) return false;
      if (lines.some((l) => l === name)) return true;
      // The anchored form a root-level file is ignored with now (`/.env`),
      // which covers it only from its own directory's file.
      if (dir === resolve(dirname(path)) && lines.some((l) => l === `/${name}`)) return true;
    }
    if (dir === top || dirname(dir) === dir || !`${dir}/`.startsWith(`${top}/`)) return false;
  }
}

/**
 * Ignore-and-verify for one secret-bearing path.
 *
 * Takes the RESOLVED path and its display name rather than a directory and an
 * implied filename, because there are two such files and the rule that keeps
 * them safe is the same rule. `path` always comes from the same helper the
 * readers use, so the file that gets an ignore rule is necessarily the file a
 * later command will read; joining the name on separately is how those two drift
 * apart in a nested project.
 */
function ensureSecretPathIgnored(
  path: string,
  posture: "warn" | "refuse",
  helpFor?: HelpTarget,
  place?: IgnorePlacement,
): void {
  // The project root is the directory holding the backend, which is what `path`
  // was resolved against — unless the caller placed it (see IgnorePlacement).
  const projectRootOf = (p: string): string => place?.root ?? dirname(dirname(p));
  // DERIVED from the resolved path rather than taken as a constant. The label is
  // not decoration: it is spelled into `git rm --cached <label>` and "Add
  // `<label>` to your ignore rules yourself", so a label naming `xano/` for a
  // nested or sibling backend hands the reader a command that does nothing.
  const label = place?.label ?? secretPathLabel(path);
  // BEFORE the rule is added, because adding one to a tracked file succeeds and
  // proves nothing. Refuse-posture only: the warn callers write no secret.
  if (posture === "refuse") refuseIfTracked(path, label, helpFor);
  try {
    // The staging file too. `atomicWrite` writes `<path>.tmp-<pid>` and renames;
    // its cleanup runs only on a thrown error, so a SIGKILL or a power loss in
    // the rename window leaves a plaintext, git-VISIBLE copy of every secret at
    // a name neither the file's own rule nor a bare `.env` matches.
    const root = projectRootOf(path);
    if (!bareRuleCovers(root, `${path}.tmp-*`)) ensureGitignored(`${path}.tmp-*`, { fileOnly: true, root });
    const rule = bareRuleCovers(root, path) ? undefined : addGitignoreRule(path, { fileOnly: true, root });
    if (rule !== undefined) detail(`Added ${rule} to ${gitignoreLabel(path, root)}`);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (posture === "refuse") {
      throw new UsageError(
        `Refusing to write ${label}: could not add it to .gitignore (${why}).\n` +
          `That file is about to hold real secrets, and without an ignore rule the next ` +
          `\`git add\` commits them.\n` +
          `Add \`${label}\` to your ignore rules yourself, then re-run.`,
        { helpFor },
      );
    }
    warn(
      `Could not update .gitignore (${why}). ` +
        `Add ${label} to your ignore rules manually — it holds secrets.`,
      "gitignore.update-failed",
    );
    return;
  }
  // The POST-condition, asked of git rather than inferred from the append. A
  // rule can be written and still not match: a later `!` negation, a nested
  // `.gitignore`, or a metacharacter (`[`, `*`, a leading `!`) in an ancestor
  // path segment, which `relForwardSlash` emits verbatim as a glob.
  if (posture === "refuse" && gitSaysIgnored(path) === false) {
    throw new UsageError(
      `Refusing to write ${label}: git still does not ignore it after adding the ` +
        `rule.\nSomething later in your ignore rules overrides it (a \`!\` negation, or a nested ` +
        `.gitignore), or a directory in the path contains gitignore glob characters.\n` +
        `Make \`git check-ignore ${label}\` succeed, then re-run.`,
      { helpFor },
    );
  }
}
