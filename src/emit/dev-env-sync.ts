/**
 * Pointing a scaffolded project's DEV SERVER at the backend a deploy just made.
 *
 * A deploy that publishes no static site hands the developer a backend URL and
 * nothing that reads it: the frontend still runs locally, and locally the URL
 * comes from `VITE_XANO_HOST` in the project's dev env file. Copying it across
 * by hand after every deploy is a step nobody remembers, so the deploy does it.
 *
 * Both scaffolded frameworks are Vite-based, read that same variable, and the
 * scaffold already points Vite's `envDir` at the project root and lists
 * {@link DEV_ENV_FILE} in its `.gitignore` — so one write serves every scaffold
 * and there is nothing framework-specific here.
 *
 * Two rules shape the write, and neither is about secrecy — an engine URL is
 * not a secret:
 *
 *   • A MANAGED BLOCK, not a whole-file rewrite. That file is the developer's,
 *     and it is where they keep their own `VITE_*` values. A rewrite would take
 *     those with it; the block leaves every byte outside it alone, and a second
 *     deploy replaces the block rather than stacking another one under it.
 *   • A PROVABLY IGNORED PATH, or nothing. The same rule the credential files
 *     follow (`gitignore.ts`): a command that silently adds a tracked file to
 *     someone's project is the shape this repo has already decided against, and
 *     the file may hold a value they set deliberately.
 *
 * Node-only (`node:fs`), reached only through a lazy import from the deploy
 * command, so the browser-safe authoring bundle never pulls it in.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gitSaysIgnored } from "../auth/store.js";
import { assertWritable, atomicWrite } from "../util/atomic-write.js";
import { relForwardSlash } from "../util/rel-path.js";
import { projectRootFrom } from "./backend-dir.js";
import { readVersion } from "./cli.js";
import { UsageError } from "./errors.js";
import { composeBlock, findBlock, HASH_DIALECT, upsertBlock, type BlockSpec } from "./managed-blocks.js";
import { detectFrontendPreset } from "./project-detect.js";

/**
 * The dev env file, at the PROJECT ROOT.
 *
 * Where the scaffold's `.env.example` tells people to put it, where its
 * `.gitignore` already covers it, and — for a preset whose Vite root is
 * `frontend/` — where `envDir` points. Vite reads `.env.local` last and never
 * commits it, which is exactly the file a per-machine backend URL belongs in.
 */
export const DEV_ENV_FILE = ".env.local";

/** The variable the scaffolded frontends read their backend URL from. */
export const DEV_ENV_VAR = "VITE_XANO_HOST";

/** What was written, for the caller that announces it. */
export interface DevEnvSync {
  /** Absolute path written. */
  readonly path: string;
  /** Project-relative and forward-slashed — what the announcement names. */
  readonly label: string;
  /** The variable the block sets. */
  readonly variable: string;
  /** The URL it was set to. */
  readonly url: string;
  /** False when the file already said exactly this, so nothing was rewritten. */
  readonly changed: boolean;
}

/** The block identity, so every run replaces the one before it. */
function devEnvSpec(): BlockSpec {
  return { dialect: HASH_DIALECT, pkg: "@xano/sdk", file: DEV_ENV_FILE };
}

/**
 * Point the dev env file of the project containing `from` at `url`, and report what happened.
 *
 * Returns `undefined` for a project with no scaffolded frontend — there is no
 * dev server to point anywhere, and creating a `.env.local` in a repo that
 * never asked for one would be a file the developer has to go and delete.
 * Detection is the project's own (`project-detect.ts`), which declines rather
 * than guesses, and declining here costs nothing: the URL is on screen either
 * way.
 *
 * Throws a {@link UsageError} when git says the file is NOT ignored. The caller
 * runs this after the deploy has already happened, so it warns rather than
 * failing — see `syncDevEnvAfterDeploy`.
 */
export function syncDevEnv(from: string, url: string): DevEnvSync | undefined {
  // The ROOT, not the directory the deploy was typed in: `.env.example`, the
  // `package.json` detection reads, and Vite's `envDir` all name that one
  // place, so a deploy run from a subdirectory must not write a second file
  // beside itself that nothing loads. Same walk the lock and the env file use.
  const projectDir = projectRootFrom(from);
  if (detectFrontendPreset(projectDir) === undefined) return undefined;

  const path = join(projectDir, DEV_ENV_FILE);
  const label = relForwardSlash(projectDir, path) || DEV_ENV_FILE;

  // `false` is git's real answer, and the only one worth refusing on. `undefined`
  // means git could not be asked at all — no repo, no git, a probe that timed
  // out — and a project that is not under version control has nothing to leak
  // into a commit, so refusing there would block the common case to guard
  // against a hazard that cannot occur. Same reading `requireSecretPathGitignored`
  // takes of the same probe.
  if (gitSaysIgnored(path) === false) {
    throw new UsageError(
      `Not pointing your dev server at the deploy: git does not ignore ${label}, and this ` +
        `would put a per-machine backend URL into a file your repo commits.\n` +
        `Add \`${label}\` to your ignore rules (the scaffold's .gitignore lists it), then ` +
        `re-run — or pass \`--no-dev-env\` to skip this step for good.\n` +
        `The backend is deployed either way: set ${DEV_ENV_VAR}=${url} yourself to reach it.`,
      { helpFor: { command: "deploy" } },
    );
  }

  const before = readIfPresent(path);
  const block = composeBlock(
    devEnvSpec(),
    [
      `# Written by \`xanosdk deploy\`. Restart the dev server to pick this up.`,
      `${DEV_ENV_VAR}=${url}`,
    ],
    readVersion(),
  );
  const edit = upsertBlock(before, devEnvSpec(), block);

  // Unchanged means unwritten: bumping the mtime of a file in someone's project
  // on every deploy is how a tool earns a place in their `.gitignore` — and this
  // one is already there.
  if (edit.changed) {
    // The file is the DEVELOPER's, and `atomicWrite` renames over its target, so
    // a read-only file would be replaced without complaint. Ask first.
    assertWritable(path);
    atomicWrite(path, edit.text);
  }

  return { path, label, variable: DEV_ENV_VAR, url, changed: edit.changed };
}

/**
 * Move the dev env file of the project containing `from` from `oldUrl` to
 * `newUrl` — only when its managed block points at `oldUrl` now.
 *
 * For a backend that moved without a deploy (a restarted local engine binds a
 * fresh port): the file follows the backend it was already pointed at, and a
 * file pointed anywhere else — a hosted deploy since, or no block at all — is
 * not this move's to touch. Throws what {@link syncDevEnv} throws.
 */
export function repointDevEnv(from: string, oldUrl: string, newUrl: string): DevEnvSync | undefined {
  if (oldUrl === newUrl) return undefined;
  const text = readIfPresent(join(projectRootFrom(from), DEV_ENV_FILE));
  if (text === null) return undefined;
  const block = findBlock(text, devEnvSpec());
  if (block === null || !block.text.split("\n").some((line) => line.trim() === `${DEV_ENV_VAR}=${oldUrl}`)) {
    return undefined;
  }
  return syncDevEnv(from, newUrl);
}

/**
 * The URL the managed block of the project containing `from` points the dev
 * server at, when it is not `url` — for a deploy that leaves the file alone
 * (a published frontend) to say the file still names an older backend.
 * `undefined` when there is no block, or it already points at `url`.
 */
export function staleDevEnv(from: string, url: string): Pick<DevEnvSync, "label" | "variable" | "url"> | undefined {
  const projectDir = projectRootFrom(from);
  const path = join(projectDir, DEV_ENV_FILE);
  const text = readIfPresent(path);
  if (text === null) return undefined;
  const block = findBlock(text, devEnvSpec());
  if (block === null) return undefined;
  const prefix = `${DEV_ENV_VAR}=`;
  const line = block.text.split("\n").map((l) => l.trim()).find((l) => l.startsWith(prefix));
  const current = line?.slice(prefix.length);
  if (current === undefined || current === url) return undefined;
  return { label: relForwardSlash(projectDir, path) || DEV_ENV_FILE, variable: DEV_ENV_VAR, url: current };
}

/** The file's current contents, or null when it does not exist yet. */
function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
