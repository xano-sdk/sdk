/**
 * The `@xano/sdk` a project has installed, against the CLI that is running.
 *
 * The files a CLI renders into a project — `xano/.env.example`, the route
 * table, the agent guidance — are worded by the CLI that writes them, and the
 * project's own `xano:check` (which runs the INSTALLED CLI) compares against
 * that installed version's wording. Another version's CLI (a global or cached
 * one, older or newer) rewriting them in its own words makes the project's
 * check fail on files it did not otherwise change, so it leaves them to the
 * installed CLI.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathsShownFrom } from "../util/rel-path.js";
import { shellWord } from "./command-line.js";
import { installedCliAt } from "./invocation.js";
import { compareSemver, parseSemver } from "./semver.js";

const PACKAGE = "@xano/sdk";

/** The version of `@xano/sdk` resolvable from `dir`'s project, or undefined. */
export function projectSdkVersion(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(createRequire(join(dir, "package.json")).resolve(`${PACKAGE}/package.json`), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** The `@xano/sdk` a project installs: its version and the project root that holds it. */
export interface InstalledSdk {
  version: string;
  /** The directory whose `node_modules` holds it (or the SDK's own checkout). */
  root: string;
}

function versionAt(pkgJson: string): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `@xano/sdk` that code under `dir` imports, found the way Node resolves
 * it — the nearest `node_modules/@xano/sdk` walking up, or the SDK's own
 * package when `dir` is inside it. Pass the directory of the file the run is
 * ABOUT (an entry, an emit target), never the working directory: a command run
 * from a project's parent is still about that project.
 */
export function installedSdk(dir: string): InstalledSdk | undefined {
  let selfChecked = false;
  for (let d = resolve(dir); ; d = dirname(d)) {
    const own = join(d, "package.json");
    if (!selfChecked && existsSync(own)) {
      selfChecked = true;
      try {
        if ((JSON.parse(readFileSync(own, "utf8")) as { name?: unknown }).name === PACKAGE) {
          const version = versionAt(own);
          if (version !== undefined) return { version, root: d };
        }
      } catch {
        /* not JSON — not the SDK's own package */
      }
    }
    const installed = join(d, "node_modules", ...PACKAGE.split("/"), "package.json");
    if (existsSync(installed)) {
      const version = versionAt(installed);
      return version === undefined ? undefined : { version, root: d };
    }
    if (dirname(d) === d) return undefined;
  }
}

/**
 * The SDK installed for `dir`'s project when it is not the running CLI's
 * (`running`) — older or newer — else undefined, including whenever either
 * cannot be read.
 */
export function skewedProjectSdk(dir: string, running: string): InstalledSdk | undefined {
  const installed = installedSdk(dir);
  if (installed === undefined) return undefined;
  const a = parseSemver(installed.version);
  const b = parseSemver(running);
  return a && b && compareSemver(a, b) !== 0 ? installed : undefined;
}

/**
 * A command that runs the project's INSTALLED CLI, pasteable where the user
 * typed: `npx xanosdk …` from the project root (`npx --workspaces=false xanosdk …`
 * in a workspace member npx's workspace lookup misses), prefixed with a `cd` into it
 * when the user is elsewhere. `tail` spells the arguments; the `path` it is
 * handed quotes a path relative to that root.
 */
export function installedCliCommand(root: string, tail: (path: (p: string) => string) => string): string {
  // Compared through symlinks (macOS's /var is /private/var): the working
  // directory is reported resolved, a typed path is not.
  const home = real(root);
  const typed = real(pathsShownFrom() ?? process.cwd());
  const spelled = (from: string, to: string): string => shellWord(relative(from, to).split(sep).join("/") || ".");
  const command = `${installedCliAt(home)} ${tail((p) => spelled(home, real(p)))}`;
  return typed === home ? command : `cd ${spelled(typed, home)} && ${command}`;
}

/** `path` absolute with every symlink in its existing part resolved. */
function real(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(real(parent), basename(absolute));
  }
}

/**
 * The note a CLI of another version prints for a derived file it left alone:
 * which versions, and the command that renders it with the project's own CLI.
 */
export function skewNote(what: string, running: string, installed: string, command: string): string {
  return (
    `Left ${what} as it is: this CLI is @xano/sdk ${running} and the project has ${installed} installed, ` +
    `whose wording \`npm run xano:check\` compares against. Run \`${command}\` to render it with the installed CLI.`
  );
}
