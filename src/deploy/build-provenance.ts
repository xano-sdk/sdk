/**
 * Where a static build came from, written as the build's `description` so the
 * platform (and anything reading its builds, such as Xano Studio or the
 * dashboard) can tell a build published from code from one uploaded by hand:
 *
 *     Published from the CLI · commit a119141
 *     Published from Xano Studio · commit a119141 (uncommitted changes)
 *     Published from the CLI                       (outside a git repository)
 *
 * `<from>` is {@link PUBLISHED_FROM_ENV} when it is set (Xano Studio sets
 * "Xano Studio" on every process it starts), else "the CLI". The commit is
 * the checkout's `HEAD`, short; a tree whose TRACKED files differ from it
 * says so, because the build then holds code no commit does. Untracked and
 * ignored files never count (DEV-10045): a publisher's scratch copy carries
 * its own links and installed packages beside the commit (Xano Studio's has
 * `node_modules` and `.xano-studio/` links), and those are not code the
 * commit lacks.
 *
 * Node-only (it runs `git`). Never throws: a checkout git cannot read is
 * described as outside one.
 */
import { execFileSync } from "node:child_process";

/** The environment variable that names who published (`Xano Studio`). */
export const PUBLISHED_FROM_ENV = "XANO_PUBLISHED_FROM";

/** Who published, when {@link PUBLISHED_FROM_ENV} names no one. */
export const DEFAULT_PUBLISHED_FROM = "the CLI";

/** The commit a checkout is at, and whether its tree differs from it. */
export interface GitState {
  /** `HEAD`, abbreviated to seven characters. */
  sha7: string;
  /** Whether a tracked file differs from `HEAD` (staged or not); untracked files never count. */
  dirty: boolean;
}

/** Read `cwd`'s git state; `undefined` outside a repository, before a first commit, or without git. */
export function readGitState(cwd: string): GitState | undefined {
  const git = (...argv: string[]): string =>
    execFileSync("git", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
  try {
    const sha = git("rev-parse", "--verify", "HEAD");
    if (!/^[0-9a-f]{7,}$/.test(sha)) return undefined;
    // Tracked modifications only: an untracked or ignored file is not code the commit lacks.
    const status = git("status", "--porcelain", "--untracked-files=no");
    return { sha7: sha.slice(0, 7), dirty: status !== "" };
  } catch {
    return undefined;
  }
}

/**
 * The description a static build is uploaded with. Pure: the caller hands in
 * who published and the git state (see {@link staticBuildDescription}).
 */
export function describeProvenance(from: string, git: GitState | undefined): string {
  const who = from.trim() === "" ? DEFAULT_PUBLISHED_FROM : from.trim();
  if (git === undefined) return `Published from ${who}`;
  return `Published from ${who} · commit ${git.sha7}${git.dirty ? " (uncommitted changes)" : ""}`;
}

/** The description for a build published from the project at `cwd`, as this process sees it. */
export function staticBuildDescription(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return describeProvenance(env[PUBLISHED_FROM_ENV] ?? DEFAULT_PUBLISHED_FROM, readGitState(cwd));
}
