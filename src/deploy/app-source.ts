/**
 * The app's source a static publish keeps with its build by default
 * (DEV-10124), so a later `site pull` or `init --from workspace` brings the
 * site down as code rather than as its built files.
 *
 * ── What goes in ────────────────────────────────────────────────────────────
 *
 * The published app's FOLDER only (`frontend/` or `frontend/<site>/`), never
 * the backend or the rest of the project: the archive is downloadable by
 * anyone who can read the workspace's sites, a project publishing N sites
 * would otherwise send its backend N times, and the backend is already in the
 * workspace. Beside the folder goes the project's root `package.json` alone,
 * so the archive reads as a project (`site-source.ts`): pulling maps
 * `frontend/<site>/` back to its folder, and a one-app frontend built by the
 * root `package.json` (the SDK's own scaffold: `frontend/index.html` loading
 * `src/main.tsx`) comes back as its code, not as files to serve as they are.
 * A project with no root `package.json` sends the folder's files at the top.
 *
 * Inside the folder: only the files git would commit (tracked, plus untracked
 * ones `.gitignore` does not exclude). `.gitignore` is what says which files
 * are safe to share, so a folder outside a git repository, or one git cannot
 * list (not installed, "dubious ownership", no answer in time), sends NO
 * source: nothing ever falls back to walking every file. Of git's list, never:
 * `node_modules`, `.git`, framework caches, the folder's build output (`dist`,
 * `build`, `out`, and the directory being published, except a built-files
 * app's `site/`, which is its code), a symlink, and any file named like a
 * secret ({@link isSecretName}: keys, certificates, `.env*`, `.npmrc`,
 * credentials and service-account JSON, anything under `.xano/`), committed or
 * not. Those are listed by name in `leftOut`, so the publish can say so.
 *
 * ── When it is not sent ─────────────────────────────────────────────────────
 *
 * Not in git, git failing, over the upload cap, more files or bytes than a
 * pull will unpack, nothing to send, or anything unreadable:
 * {@link packAppSource} says why and the build is published without it. A
 * default never fails a publish; an explicit `--static-source` keeps its own
 * strict checks (`static-source.ts`).
 *
 * Node-only; lazily imported by the publish.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_ARCHIVE_FILES, MAX_UNPACKED_BYTES } from "../util/archive-read.js";
import { ZipWriter } from "../util/zip.js";
import { STATIC_UPLOAD_MAX_BYTES } from "./static-source.js";

/** Folders never sent, wherever they sit: installs, VCS, and caches a build or framework writes. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".xano-studio",
  ".xano-ssr",
  ".svelte-kit",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".vite",
  ".cache",
  ".vercel",
  ".netlify",
  "__MACOSX",
]);

/** The folders a build writes to at an app's top: its output, never its source. */
const BUILD_OUTPUT_DIRS: readonly string[] = ["dist", "build", "out"];

/** Folders whose every file is a secret: the SDK's own credentials, SSH and cloud keys. */
const SECRET_DIRS: ReadonlySet<string> = new Set([".xano", ".ssh", ".aws", ".gnupg"]);

/** File names that usually hold a secret, matched case-insensitively on the name alone. */
const SECRET_NAMES: readonly RegExp[] = [
  /\.(?:pem|key|p12|pfx|jks|keystore|ppk|kdbx)$/,
  /^id_(?:rsa|dsa|ecdsa|ed25519)/,
  /^\.env/,
  /^\.(?:npmrc|yarnrc\.yml|yarnrc|netrc|envrc|pgpass|pypirc|htpasswd|git-credentials)$/,
  /^\.dev\.vars/,
  /\.secret/,
  /^\.?secrets?(?:\.[^.]+)?\.(?:json|ya?ml|toml|txt)$/,
  /^credentials.*\.json$/,
  /^service-account.*\.json$/,
  /^xano\.profile\.json$/,
];

/**
 * Whether a path (slash-separated, relative to the app folder) names a file
 * that usually holds a secret: never sent as source, even when committed.
 */
export function isSecretName(rel: string): boolean {
  const segs = rel.split("/");
  if (segs.slice(0, -1).some((s) => SECRET_DIRS.has(s))) return true;
  const name = segs.at(-1)!.toLowerCase();
  return SECRET_NAMES.some((re) => re.test(name));
}

/** An app's source packed for its build: the folder it came from, and what the archive holds. */
export interface AppSourcePack {
  /** The app folder, relative to the project root (`frontend/shop`). */
  dir: string;
  /** The `.zip` (a `Uint8Array`, so the published declarations name no Node type). */
  data: Uint8Array;
  files: number;
  leftOut: string[];
}

/** What {@link packAppSource} made, or why it made nothing. */
export type PackedAppSource =
  | {
      /** The `.zip`. */
      data: Buffer;
      /** How many of the app's files it holds (the root `package.json` not counted). */
      files: number;
      /** Files git listed that were left out for their secret-looking names, relative to the app folder. */
      leftOut: string[];
    }
  | { skipped: string; leftOut?: string[] };

export interface PackAppSourceOptions {
  /** Directories (relative to the project root, or absolute) left out: the build being published. */
  exclude?: readonly string[];
  /** The cap on the archive; the static upload's by default. */
  maxBytes?: number;
  /** The cap on the files' raw size, the root `package.json` included; what a pull unpacks by default. */
  maxUnpackedBytes?: number;
  /** The cap on the number of files, the root `package.json` included; what a pull reads by default. */
  maxFiles?: number;
  /** The git program to run (tests point it at one that fails). */
  git?: string;
}

/** The message for a folder whose files git cannot vouch for. */
const OPT_IN = "Put the project under git (its .gitignore says what is safe to share), or pass `--static-source <archive>`";

function isFileAt(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** POSIX form of a relative path. */
const posix = (p: string): string => p.split(sep).join("/");

/** Whether a `.git` (folder, or the file a worktree has) sits at `dir` or any folder above it. */
function inGitRepository(dir: string): boolean {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return true;
    if (dirname(at) === at) return false;
  }
}

/** Why git could not list the files, in one line. */
function gitFailure(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer; signal?: string };
  if (e.code === "ENOENT") return "git is not installed (or not on PATH)";
  if (e.code === "ETIMEDOUT" || e.signal === "SIGTERM") return "git did not answer within 20 s";
  const said = (e.stderr === undefined ? "" : String(e.stderr)).trim().split(/\r?\n/).find((l) => l.trim() !== "");
  return `git could not list its files (${said ?? e.message})`;
}

/** The app folder's files as git would commit them, relative to the folder, or why git could not say. */
function gitFiles(appAbs: string, git: string): { files: string[] } | { error: string } {
  try {
    const out = execFileSync(git, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: appAbs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
      maxBuffer: 256 * 1024 * 1024,
    });
    return { files: [...new Set(out.split("\0").filter((p) => p !== ""))] };
  } catch (err) {
    return { error: gitFailure(err) };
  }
}

/**
 * Archive the app at `appDir` (relative to `projectDir`, POSIX-separated, e.g.
 * `frontend/shop`) as the source its build keeps. Never throws: anything that
 * stops it is the `skipped` reason.
 */
export function packAppSource(projectDir: string, appDir: string, opts: PackAppSourceOptions = {}): PackedAppSource {
  const maxBytes = opts.maxBytes ?? STATIC_UPLOAD_MAX_BYTES;
  const maxUnpacked = opts.maxUnpackedBytes ?? MAX_UNPACKED_BYTES;
  const maxFiles = opts.maxFiles ?? MAX_ARCHIVE_FILES;
  const mb = (n: number): string => `${Number((n / (1024 * 1024)).toFixed(2))} MB`;
  try {
    const root = resolve(projectDir);
    const appAbs = resolve(root, ...appDir.split("/"));
    const appRel = posix(relative(root, appAbs));
    if (!lstatSync(appAbs).isDirectory()) return { skipped: `it could not be read: ${appRel} is not a folder` };

    // Only git says which files are safe to share: no repository, or a git that cannot answer, sends nothing.
    if (!inGitRepository(appAbs)) {
      return { skipped: `${appRel} is not in a git repository, so nothing says which of its files are safe to share. ${OPT_IN}` };
    }
    const listedByGit = gitFiles(appAbs, opts.git ?? "git");
    if ("error" in listedByGit) return { skipped: `${listedByGit.error}, so nothing says which files are safe to share` };

    // Each left-out directory, relative to the app folder, when it lies inside it (and is not the folder itself).
    // Xano Studio's built-files layout serves `site/` as it is: there `site/` IS the code, so it stays.
    const builtFiles = isFileAt(join(appAbs, "site.mjs"));
    const excluded = [...BUILD_OUTPUT_DIRS, ...(opts.exclude ?? []).map((d) => posix(relative(appAbs, isAbsolute(d) ? d : resolve(root, d))))].filter(
      (d) => d !== "" && d !== "." && !d.startsWith("../") && d !== ".." && !isAbsolute(d) && !(builtFiles && d === "site"),
    );
    const quietlyOut = (rel: string): boolean => {
      const segs = rel.split("/");
      if (segs.some((s) => s === ".." || s === "")) return true;
      if (segs.slice(0, -1).some((s) => SKIPPED_DIRS.has(s))) return true;
      if (segs.at(-1) === ".DS_Store") return true;
      return excluded.some((d) => rel === d || rel.startsWith(`${d}/`));
    };
    const listed = listedByGit.files.filter((p) => !quietlyOut(p)).sort();
    const leftOut = listed.filter(isSecretName);
    const kept = listed.filter((p) => !isSecretName(p));

    // A project's root `package.json` makes the archive read as a project, so a pull maps the folder back.
    // It counts against every cap a pull applies.
    let manifest: Buffer | undefined;
    if (appRel !== "" && appRel !== "." && isFileAt(join(root, "package.json"))) manifest = readFileSync(join(root, "package.json"));
    const prefix = manifest === undefined ? "" : `${appRel}/`;

    const zip = new ZipWriter();
    let count = 0;
    let raw = 0;
    const over = (): string | undefined => {
      if (count > maxFiles) return `${appRel} holds more than ${maxFiles} files (with the root package.json)`;
      if (raw > maxUnpacked) return `${appRel} holds more than ${mb(maxUnpacked)} of files (with the root package.json)`;
      // Checked as each file is added: the archive stops growing the moment it passes the cap.
      if (zip.size > maxBytes) return `its archive passes ${mb(maxBytes)}, the cap for a static upload`;
      return undefined;
    };
    if (manifest !== undefined) {
      count += 1;
      raw += manifest.length;
      zip.add({ name: "package.json", data: manifest });
    }
    let files = 0;
    for (const rel of kept) {
      const full = join(appAbs, ...rel.split("/"));
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue; // tracked, but deleted from the working tree
      }
      if (!st.isFile()) continue; // a symlink or anything else: never followed
      count += 1;
      raw += st.size;
      const before = over();
      if (before !== undefined) return { skipped: before, leftOut };
      zip.add({ name: `${prefix}${rel}`, data: readFileSync(full) });
      files += 1;
      const after = over();
      if (after !== undefined) return { skipped: after, leftOut };
    }
    if (files === 0) return { skipped: `${appRel} has no source files to send`, leftOut };
    const data = zip.finish();
    if (data.length > maxBytes) return { skipped: `its archive passes ${mb(maxBytes)}, the cap for a static upload`, leftOut };
    return { data, files, leftOut };
  } catch (err) {
    return { skipped: `it could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}
