/**
 * Where an export writes — the one `--path`/`--name` precedence rule, shared by
 * every command that produces a file.
 *
 * Lives on its own rather than beside any one exporter because the rule is the
 * user-facing contract (`--path -` is stdout, a directory takes the derived
 * basename, anything else is the file itself) and two commands that disagreed
 * about it would be two commands whose `--path` means different things.
 *
 * Pure aside from one directory-existence probe, so the precedence is testable
 * without a network call or a compile.
 */
import { accessSync, chmodSync, constants, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { UsageError } from "./errors.js";
import { warn } from "./ui.js";
import { ensureExportGitignored } from "./gitignore.js";
import { andList } from "../util/and-list.js";

/** Where the export should land: the stdout data channel, or an absolute file path. */
export type OutputTarget = { kind: "stdout" } | { kind: "file"; path: string };

/**
 * Resolve where an export writes, from the `--path`/`--name` flags and the
 * format's extension.
 *
 * Precedence:
 *   • `path === "-"`         → stdout.
 *   • no `path`              → `./<name>.<ext>` (cwd).
 *   • `path` is an existing dir, or ends in a path separator → `<path>/<name>.<ext>`.
 *   • otherwise              → `path` treated as a full file path, returned verbatim.
 *
 * `name` is required: every caller has a meaningful default for its own command
 * (the workspace, the environment being exported), and a fallback invented here
 * would be one command's word appearing in another command's output.
 */
export function resolveOutputTarget(opts: {
  path?: string;
  name: string;
  ext: "json" | "xs";
}): OutputTarget {
  const { path, name, ext } = opts;
  if (path === "-") return { kind: "stdout" };

  if (path === undefined || path === "") {
    return { kind: "file", path: resolve(deriveExportBasename(name, ext)) };
  }

  // A trailing separator, or a path that already exists as a directory, means
  // "into this directory" — join the derived basename. Otherwise the path is a
  // full file target and is used verbatim (its own extension respected as-is).
  const endsWithSep = path.endsWith("/") || path.endsWith("\\");
  const isDir = statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
  if (endsWithSep || isDir) {
    return { kind: "file", path: resolve(join(path, deriveExportBasename(name, ext))) };
  }
  return { kind: "file", path: resolve(path) };
}

/**
 * `<name>.<ext>`, with `name` held to being an actual basename.
 *
 * Named for what it does rather than `basename`, which would read as
 * `node:path`'s helper one import line away — and this is that function's
 * opposite. `path.basename()` SANITISES, quietly turning `../../x` into `x`;
 * this refuses.
 *
 * `resolve()` has the same problem: it normalises a traversal away and hands
 * back a path outside the cwd, which the caller then writes to and reports as
 * an ordinary success. That is how a release named `../../escaped-name`
 * exported two directories up. The name is a DERIVED BASENAME in every
 * caller (the release, the tenant, `workspace export --name`), so refusing
 * costs nothing legitimate and is what makes "no `--path` means the cwd" true
 * rather than merely usual.
 *
 * Refusing rather than sanitising is the deliberate half. Rewriting `../../x`
 * into `x` would write a file under a name the user did not ask for, and for
 * `release export` that name is the release's identity.
 *
 * This is the EXPORT-side half of the release-name rule, and it is the one that
 * has to hold: the create-side `assertUsableReleaseName` never runs for a
 * client exporting a release it did not name. So the two refuse on the same
 * terms — a leading dot included — rather than this one being the looser of the
 * pair.
 *
 * Only reached when the basename is actually used. An explicit `--path` naming
 * a file is the user choosing the destination themselves, and stays unrestricted.
 */
function deriveExportBasename(name: string, ext: "json" | "xs"): string {
  if (name.trim() === "") {
    throw new UsageError(
      `An export derives its filename from the name it was given, and this one is empty.\n` +
        `The file would be written as \`.${ext}\` — a dotfile with no name at all, in a ` +
        `directory the reader is not looking at it in.\n` +
        `Name the export, or pass \`--path <file>\` to write to a filename of your choosing.`,
    );
  }
  if (name.includes("/") || name.includes("\\") || name.includes(":")) {
    throw new UsageError(
      `"${name}" is a path, not a name — an export derives its filename from it.\n` +
        `\`/\`, \`\\\` and \`:\` each address a LOCATION rather than name a file, so writing this ` +
        `as given would land the file somewhere the command was never pointed at: outside the ` +
        `invocation directory when the name traverses up, and on another drive entirely when it ` +
        `begins \`C:\` on Windows.\n` +
        `To write somewhere else on purpose, pass \`--path <file>\` naming the file. A \`--path\` ` +
        `that names a DIRECTORY derives this same basename inside it, so it does not sidestep this.`,
    );
  }
  if (name.startsWith(".")) {
    throw new UsageError(
      `"${name}" begins with a dot, so an export would derive a filename from it that ` +
        `addresses a directory (\`.\`, \`..\`) or hides the file from the reader who asked ` +
        `for it.\n` +
        `Pass \`--path <file>\` to write to a dotted filename on purpose.`,
    );
  }
  const file = `${name}.${ext}`;
  // A filesystem's limit on ONE path component, in bytes. Past it the write
  // failed with a raw ENAMETOOLONG after the whole export had been fetched.
  if (Buffer.byteLength(file, "utf8") > MAX_BASENAME_BYTES) {
    throw new UsageError(
      `"${name.length > 40 ? `${name.slice(0, 40)}…` : name}" is too long to be a filename ` +
        `(${Buffer.byteLength(file, "utf8")} bytes; a filesystem allows ${MAX_BASENAME_BYTES}).\n` +
        `Pass \`--path <file>\` to write it under a shorter name.`,
    );
  }
  return file;
}

/** The longest single path component the common filesystems accept, in bytes. */
const MAX_BASENAME_BYTES = 255;

/**
 * Write an export to the file {@link resolveOutputTarget} chose.
 *
 * `secrets` is what the content carries in cleartext (`secretsCarriedBy` for a
 * bundle): when any, the file is written owner-only (0600) and the one-line
 * notice every bundle writer prints says so — `export --out`, `ephemeral
 * export`, and the workspace and release exports. The mode is applied to a
 * REGULAR file only: `--path /dev/null` is a place to discard output, not a
 * file whose mode is this command's to change.
 *
 * The filesystem's refusals are answered as what they are — a path that cannot
 * be written as given — rather than as a raw `EEXIST: file already exists,
 * mkdir` naming a directory the reader never typed.
 */
export function writeExportFile(
  path: string,
  content: string,
  secrets: readonly string[] = [],
  flag = "--path",
  written = "Nothing was written",
): void {
  let regular = true;
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (secrets.length > 0) {
      writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
      // `mode` applies only when the file is created; an existing one keeps its
      // own. A device (`/dev/null`, a pipe) is not a file anyone commits.
      regular = statSync(path).isFile();
      if (regular) chmodSync(path, 0o600);
    } else {
      writeFileSync(path, content, "utf8");
    }
  } catch (err) {
    throw unwritable(path, err, flag, written);
  }
  if (secrets.length > 0 && regular) {
    const notice = `${path} carries ${secretsPhrase(secrets)} in cleartext — written owner-only (0600); do not commit it.`;
    // A `--json` reader never sees stderr: the document's `warnings[]` carries it too.
    warn(notice, "secrets.cleartext-export");
    // Owner-only keeps other users out; it does nothing against `git add .`.
    ensureExportGitignored(path);
  }
}

/**
 * The secret labels (`secretsCarriedBy`, `secretsInMultidoc`) as a sentence
 * names them: the one singular label takes its article — "carries a
 * documentation token", never "carries documentation token".
 */
export function secretsPhrase(secrets: readonly string[]): string {
  return andList(secrets.map((s) => (s === "documentation token" ? "a documentation token" : s)));
}

/**
 * Refuse, before anything is written, a `path` {@link writeExportFile} could not
 * write — so a command that writes something else first (export's `xano.lock`)
 * does not report that write and then fail on this one.
 *
 * Checks the path itself when it exists (not a directory, writable), and
 * otherwise its nearest existing ancestor (a directory, writable). A device such
 * as `/dev/null` passes. What slips past (a disk filling up mid-write) is still
 * answered by the writer.
 */
export function assertWritableTarget(path: string, flag = "--path"): void {
  // NOT `resolve()`: that folds `..` textually, while the write lets the OS walk
  // it through symlinks — `/tmp/../x` is `/private/x` on macOS, not `/x`. Each
  // ancestor is stat'ed as spelled, so the check sees the directory the write will.
  const target = isAbsolute(path) ? path : process.cwd() + sep + path;
  try {
    const existing = statOrUndefined(target);
    if (existing !== undefined) {
      if (existing.isDirectory()) throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
      accessSync(target, constants.W_OK);
      return;
    }
    let dir = dirname(target);
    for (;;) {
      const st = statOrUndefined(dir);
      if (st !== undefined) {
        if (!st.isDirectory()) throw Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" });
        accessSync(dir, constants.W_OK);
        return;
      }
      const parent = dirname(dir);
      if (parent === dir) return;
      dir = parent;
    }
  } catch (err) {
    throw unwritable(path, err, flag);
  }
}

function statOrUndefined(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** A filesystem refusal of `path`, in words — or the error itself when it is not one of those. */
function unwritable(path: string, err: unknown, flag: string, written = "Nothing was written"): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const why =
    code === "EEXIST" || code === "ENOTDIR"
      ? "a FILE sits where one of its parent directories would have to be"
      : code === "EISDIR"
        ? "it is a directory"
        : code === "ENAMETOOLONG"
          ? "the path is longer than the filesystem allows"
          : code === "EACCES" || code === "EPERM"
            ? "this user may not write there"
            : code === "EROFS"
              ? "the filesystem there is read-only"
              : code === "ENOENT"
                ? "its parent directory does not exist and cannot be created there"
                : undefined;
  if (why === undefined) return err as Error;
  return new UsageError(`Cannot write ${path}: ${why}. ${written}. Pass a different \`${flag}\`.`);
}
