/**
 * Keeps the blocks the SDK owns in a project matching the `@xano/sdk` it has
 * installed: the `AGENTS.md` brief, and the README's `## Built with` footer.
 *
 * ## Why this exists
 *
 * The guidance written at scaffold time names the grounding docs and how to read
 * them. Upgrade the package and that pointer is frozen at whatever shipped the
 * day the project was created — which defeats the reason the docs ship inside
 * the package at all. Version-matched documentation that stops being
 * version-matched is just documentation. The README footer rides along for a
 * different reason: its markers promise a refresh rewrites it, and a marker
 * nothing honours is one an editor learns to ignore.
 *
 * ## What it will not do
 *
 * It refreshes a managed block that is ALREADY there and does nothing otherwise.
 * It never creates a file and never adds a block to a file that lacks one: a
 * project without a managed block is one whose owner passed `--no-agents-md`,
 * deleted the file or the block, or wrote their own, and a courtesy refresh
 * overriding any of those is a write nobody asked for.
 *
 * Three further gates, cheapest first: CI, then agent detection, then staleness.
 * An unrecognized environment counts as "no agent", so the failure mode is a
 * stale block rather than a surprise write in someone's build.
 *
 * Node-only (node:fs); imported lazily by the command modules so the
 * browser-safe authoring bundle never pulls it in.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AGENTS_MD_PATH,
  managedBlockVersion,
  renderAgentsMd,
  upsertManagedBlock,
  type FrontendGuidance,
  type GuidanceMode,
} from "./init-ai-presets.js";
import {
  README_PATH,
  readmeBuiltWithVersion,
  refreshReadmeBuiltWith,
} from "./init-templates.js";
import { detectFrontendGuidance } from "./project-detect.js";
import { CODEGEN_MARKER } from "./scaffold.js";
import { warn } from "./ui.js";
import { projectFileCli, projectSdkDir } from "./invocation.js";
import { detectPackageManager } from "./package-manager.js";

/**
 * Environment variables coding agents set. Keyed on presence, not value.
 *
 * Deliberately a short list of things we are confident about. A miss costs a
 * stale block until the next scaffold; a false positive writes files during
 * someone's build, which is the worse direction — so an environment we do not
 * recognize is treated as "no agent".
 */
const AGENT_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CURSOR_TRACE_ID",
  "CURSOR_AGENT",
  "CODEX_SANDBOX",
  "AIDER_MODEL",
  "GITHUB_COPILOT_AGENT",
] as const;

/** Whether a coding agent appears to be driving this process. */
export function codingAgentDetected(env: NodeJS.ProcessEnv = process.env): boolean {
  return AGENT_ENV_VARS.some((name) => (env[name] ?? "") !== "");
}

/**
 * Environment variables that mean "this is CI". `CI` is the near-universal
 * signal; the rest are providers that historically have not set it.
 *
 * Exported because a test that drives a real command inherits the ambient
 * environment, so it has to neutralize this exact set to exercise the
 * non-CI path — and a hand-copied list would silently stop matching.
 */
export const CI_ENV_VARS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "TEAMCITY_VERSION",
] as const;

/** Whether this looks like CI. */
export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  return CI_ENV_VARS.some((name) => (env[name] ?? "") !== "");
}

export interface RefreshOptions {
  /** Project root to look in. */
  readonly projectDir: string;
  /** The installed `@xano/sdk` version — what a current block should be stamped with. */
  readonly sdkVersion: string;
  readonly appName?: string;
  readonly mode?: GuidanceMode;
  /**
   * The frontend the brief should describe. Defaults to whatever
   * {@link detectFrontendGuidance} can read off `projectDir`.
   *
   * A refresh runs in a process that never saw the `init` flags, and nothing
   * records them, so rendering the DEFAULT frontend would write "React" and
   * "Neutral" into a SvelteKit project themed Mist Red — a current-looking
   * falsehood in the file agents are told to trust, which no hand-fix survives
   * because the next refresh overwrites it again.
   */
  readonly frontend?: FrontendGuidance;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The user asked for this refresh by name (`xanosdk upgrade`), rather than
   * getting it as a courtesy on the compile path.
   *
   * Skips the CI and agent-detection gates, and ONLY those. Both exist because a
   * background courtesy must never surprise someone's build — a reason that
   * evaporates when the refresh is the thing that was typed. The gates that
   * protect the user's TREE are not part of this bypass: a file is still never
   * created, and a block is still never added to a file that lacks one, because
   * either would override an owner who opted out of the brief.
   */
  readonly explicit?: boolean;
  /** False: only report the paths a refresh would rewrite, writing nothing. */
  readonly write?: boolean;
}

/**
 * The guidance variant this project should carry. A pulled tree's `xano/` is
 * machine-written, and the guidance that says so is the highest-leverage line
 * in the file — refreshing it into the wrong variant would quietly delete that
 * warning from a generated project.
 */
function guidanceModeFor(projectDir: string): GuidanceMode {
  return existsSync(join(projectDir, CODEGEN_MARKER)) ? "generated" : "authored";
}

/** The project's own name, for the file's heading. Falls back to the directory. */
function appNameFor(projectDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as {
      name?: string;
    };
    if (typeof pkg.name === "string" && pkg.name.length > 0) return pkg.name;
  } catch {
    /* no package.json, or not JSON — the directory name is a fine fallback */
  }
  return basename(projectDir);
}

/** Repo-relative paths whose managed block was rewritten. */
export type RefreshResult = readonly string[];

/** One file the SDK owns a block in: where it is, whether it carries the block, and what the block should now say. */
interface ManagedFile {
  readonly path: string;
  /** The version stamped into the file's block, or null when it carries none. */
  readonly stampedVersion: (text: string) => string | null;
  /** The file with its block brought current and everything outside it untouched. */
  readonly refreshed: (existing: string) => string;
}

/** The two files, in the order their paths are reported. */
function managedFiles(opts: RefreshOptions): readonly ManagedFile[] {
  return [
    {
      path: AGENTS_MD_PATH,
      stampedVersion: managedBlockVersion,
      refreshed: (existing) => {
        const manager = detectPackageManager(opts.projectDir);
        return upsertManagedBlock(
          existing,
          renderAgentsMd(opts.appName ?? appNameFor(opts.projectDir), opts.mode ?? guidanceModeFor(opts.projectDir), {
            version: opts.sdkVersion,
            frontend: opts.frontend ?? detectFrontendGuidance(opts.projectDir),
            cli: projectFileCli(opts.projectDir, manager),
            sdkDir: projectSdkDir(opts.projectDir, manager),
          }),
        );
      },
    },
    {
      path: README_PATH,
      stampedVersion: readmeBuiltWithVersion,
      refreshed: (existing) => refreshReadmeBuiltWith(existing, opts.sdkVersion),
    },
  ];
}

/**
 * Refresh `AGENTS.md` and the README's footer where the managed block differs
 * from what this version renders. Returns the paths it rewrote — empty when a
 * gate closed, when no file carries a block, or when every block is current.
 */
export function refreshAgentFiles(opts: RefreshOptions): RefreshResult {
  const env = opts.env ?? process.env;
  if (opts.explicit !== true && (isCI(env) || !codingAgentDetected(env))) return [];
  return managedFiles(opts)
    .filter((file) => refreshFile(opts, file))
    .map((file) => file.path);
}

/** Whether `file` was (or, under `write: false`, would be) rewritten. */
function refreshFile(opts: RefreshOptions, file: ManagedFile): boolean {
  const absolute = join(opts.projectDir, file.path);
  if (!existsSync(absolute)) return false;
  try {
    const existing = readFileSync(absolute, "utf8");
    if (file.stampedVersion(existing) === null) return false;
    // Stale by CONTENT, not only by stamp: a block stamped with this version can
    // still carry another version's text — the CLI that ran an upgrade rendered
    // it with its own, older templates before stamping the new version on it.
    const updated = file.refreshed(existing);
    if (updated === existing) return false;
    if (opts.write !== false) writeFileSync(absolute, updated);
    return true;
  } catch (err) {
    // A refresh is a courtesy. It must never be the reason a compile fails.
    warn(`could not refresh ${file.path}: ${err instanceof Error ? err.message : String(err)}`, "agents.refresh-failed");
    return false;
  }
}
