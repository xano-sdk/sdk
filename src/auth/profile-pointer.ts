/**
 * `xano.profile.json` — the committed, secret-free file that pins a REPOSITORY
 * to a named credential profile.
 *
 * It sits at the project root rather than under `.xano/`, because `.xano/` is
 * gitignored wholesale and a pointer meant to be shared cannot live somewhere
 * git is told to ignore. It names a profile and nothing else: the credential
 * itself stays in `auth.json`, outside the repo.
 *
 * Secret-free BY CONSTRUCTION, and enforced — a file carrying anything
 * token-shaped is rejected outright rather than read past. A thrown error is
 * strictly better than a token reaching a teammate's clone.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { atomicWrite } from "../util/atomic-write.js";
import { assertValidProfileName } from "./profile-select.js";
import { UsageError } from "../emit/errors.js";
import { shellQuote } from "../util/shell-quote.js";
import { holdsProjectManifest } from "../util/project-root.js";

/** The committed pointer file's name, at the project root. */
export const POINTER_FILE = "xano.profile.json";

/** Keys that must never appear in a committed file. Rejected, not ignored. */
const TOKEN_BEARING = [
  "access_token",
  "refresh_token",
  "meta_api_token",
  "token",
  "secret",
  "client_secret",
  "password",
  "api_key",
  "apikey",
  "authorization",
  "bearer",
  "access_key",
  "private_key",
];

/** How deep to look for a leaked key. Bounded so a hostile file cannot spin this. */
const MAX_SCAN_DEPTH = 6;

/**
 * Every token-shaped key in the file, as dotted paths.
 *
 * Recursive and case-insensitive: the file is committed, so a token nested one
 * level down (`{"auth": {"token": "..."}}`) is exactly as leaked as one at the
 * top, and a top-level-only check would wave it through.
 */
function leakedKeys(value: unknown, path: string[] = [], depth = 0): string[] {
  if (depth > MAX_SCAN_DEPTH || typeof value !== "object" || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => leakedKeys(item, [...path, String(i)], depth + 1));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const here = [...path, key];
    if (TOKEN_BEARING.includes(key.toLowerCase())) return [here.join(".")];
    return leakedKeys(child, here, depth + 1);
  });
}

/**
 * The nearest `xano.profile.json` at or above `startDir`, or `undefined`.
 *
 * The walk stops at the first directory containing a `package.json`, the same
 * anchor and the same reason as `nearestLockPath`: walking past a project root
 * adopts another project's identity. Uncapped, this would pick up a pointer
 * from an unrelated monorepo parent — or from `$HOME`.
 */
export function findPointerFile(startDir: string): string | undefined {
  return walkUp(startDir).pointer;
}

/**
 * ONE walk, answering both questions it can answer: where the pointer is, and
 * where the project root is.
 *
 * Written once because the `package.json` anchor is the load-bearing invariant
 * — `profile use` writes where the next command's lookup reads — and a rule
 * encoded in two loops is a rule that can disagree with itself.
 */
function walkUp(startDir: string): { pointer?: string; root: string; bounded: boolean } {
  const start = resolve(startDir);
  const home = resolve(homedir());
  let dir = start;
  for (;;) {
    const candidate = join(dir, POINTER_FILE);
    if (existsSync(candidate)) return { pointer: candidate, root: dir, bounded: true };
    // The project's root is as far as its identity can come from; walking past
    // a package.json adopts another project's.
    if (holdsProjectManifest(dir)) return { root: dir, bounded: true };
    // A tree with no package.json above it must still be BOUNDED. Unbounded,
    // a stray `xano.profile.json` in $HOME — or in a world-writable /tmp —
    // would silently retarget every run started anywhere beneath it.
    if (existsSync(join(dir, ".git"))) return { root: dir, bounded: true };
    const parent = dirname(dir);
    if (parent === dir || dir === home) return { root: start, bounded: false };
    dir = parent;
  }
}

/**
 * The profile a pointer file names.
 *
 * A file that does not name one — not an object, no `profile` key, or a
 * `profile` that is not a string — is refused, naming the file and what is
 * wrong: proceeding on the credential file's default would act as a profile
 * the project never chose, with nothing said. So is a token-bearing key, which
 * is a leak.
 */
export function readPointerFile(path: string): string {
  let text: string;
  try {
    // A UTF-8 byte-order mark (Windows editors, PowerShell `Out-File`) is not part of the JSON.
    text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  } catch (err) {
    throw pointerFsFailure(err, path, "read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(
      `${path} is not valid JSON. It names the credential profile this project uses, ` +
        `e.g. {"profile": "prod"} — or delete it to fall back to the default profile.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw pointerWithoutProfile(path, `holds ${jsonKind(parsed)}, not an object`);
  }
  const record = parsed as Record<string, unknown>;

  const leaked = leakedKeys(record);
  if (leaked.length > 0) {
    throw new Error(
      `${path} contains ${leaked.map((k) => `\`${k}\``).join(", ")}. This file is committed to ` +
        `version control and must never hold credentials — it names a profile and nothing else. ` +
        `Remove ${leaked.length === 1 ? "that key" : "those keys"}, and treat the value as leaked: ` +
        `run \`xanosdk logout\` for the affected profile and sign in again.`,
    );
  }

  const name = record.profile;
  if (name === undefined) throw pointerWithoutProfile(path, "has no `profile` key");
  if (typeof name !== "string") {
    throw pointerWithoutProfile(path, `has a \`profile\` that is ${jsonKind(name)}, not a name`);
  }
  assertValidProfileName(name, path);
  return name;
}

/** A parsed JSON value's kind, with its article: `null`, `an array`, `a number`. */
function jsonKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/** The refusal for a pointer file that names no profile, said as `what` is wrong with it. */
function pointerWithoutProfile(path: string, what: string): UsageError {
  return new UsageError(
    `${path} ${what}. It names the credential profile this project uses, e.g. {"profile": "prod"} — ` +
      `rewrite it with \`xanosdk profile use <name>\`, or delete it to fall back to the default profile.`,
  );
}

/**
 * A project's pin: the pointer file, and the profile it names.
 *
 * Named rather than written inline at each site because every message that
 * discloses a pin needs BOTH halves — the profile to say what the project acts
 * as, and the path to say which file a reader should look at — and a site that
 * carried only one of them could not write the sentence.
 */
export interface ProjectPin {
  readonly path: string;
  readonly profile: string;
}

/** The pointer for `startDir`'s project, resolved and read. `undefined` when there is none. */
export function resolveProjectProfile(startDir: string): string | undefined {
  return findProjectPointer(startDir)?.profile;
}

/**
 * The pointer file AND the name it holds, from one walk — so a caller that
 * reports the path alongside the name can promise they came from the same file.
 * `undefined` when there is no pointer; one that names no profile is refused.
 */
export function findProjectPointer(startDir: string): ProjectPin | undefined {
  const path = findPointerFile(startDir);
  if (path === undefined) return undefined;
  return { path, profile: readPointerFile(path) };
}

/**
 * Write the pointer at `dir` (`xanosdk profile use`). Plain 0644 and a trailing
 * newline — this is a committed source file, not a credential.
 */
export function writePointerFile(dir: string, profile: string): string {
  assertValidProfileName(profile);
  const path = join(resolve(dir), POINTER_FILE);
  try {
    atomicWrite(path, JSON.stringify({ profile }, null, 2) + "\n");
  } catch (err) {
    throw pointerFsFailure(err, path, "write");
  }
  return path;
}

/**
 * A pointer file the filesystem will not read or replace, said as what is in
 * the way: a directory or a looping link where the file belongs, or a
 * file or directory this user cannot read or write. Other errors pass through unchanged.
 */
function pointerFsFailure(err: unknown, path: string, op: "read" | "write"): unknown {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const pin = 'It holds the project\'s profile pin, e.g. {"profile": "prod"}';
  switch (code) {
    case "EISDIR":
      return new UsageError(`${path} is a directory, not a file. ${pin}: remove or rename the directory, then run the command again.`);
    case "ELOOP":
      return new UsageError(`${path} is a symbolic link that loops back on itself (ELOOP). ${pin}: point it at a real file or remove it, then run the command again.`);
    case "EACCES":
    case "EPERM":
    case "EROFS":
      if (op === "read") return new UsageError(`${path} cannot be read by this user (${code}). Restore access with \`chmod u+r ${shellQuote(path)}\`, then run the command again.`);
      return new UsageError(`${path} cannot be written: ${dirname(path)} is not writable here (${code}). Make it writable, then run the command again.`);
    default:
      return err;
  }
}

/**
 * The directory a pointer written now should land in: the project root, found
 * the same way the walk finds one to READ, so `profile use` and the next
 * command's lookup cannot disagree about where the file belongs.
 */
export function pointerRootFor(startDir: string): string {
  return walkUp(startDir).root;
}

/**
 * The project a pointer written from `startDir` would pin, or `undefined` when
 * there is none: no pointer, `package.json` or `.git` on the way up, or a root
 * that is the home directory itself — a pointer there is read from every
 * non-project directory below it, pinning them all over the machine default.
 */
export function projectRootFor(startDir: string): string | undefined {
  const { root, bounded } = walkUp(startDir);
  return bounded && resolve(root) !== resolve(homedir()) ? root : undefined;
}
