/**
 * Where in the author's source a load-time throw came from.
 *
 * A statement or value factory validates its arguments when it is CALLED, which
 * is while the entry's module graph is evaluating — inside a `stack: [ … ]`
 * literal, before the def that will own it exists. So `Statement
 * "s.db.query": where is the constant …` names the statement and not the query
 * or task it sits in, and nothing at register or export time ever sees it. The
 * stack does: its first frame in the author's own files is the call that threw.
 */
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRootFrom } from "./backend-dir.js";

/** This package's own root (from `src/emit/` or the built `dist/`) — its frames are never the author's. */
const OWN_ROOT = dirname(fileURLToPath(import.meta.url)).replace(/[\\/](src[\\/]emit|dist)$/, "");

/**
 * `file:line:column` of the first frame under the entry's project that is
 * neither a dependency nor this package, relative to the working directory —
 * or undefined when no frame qualifies.
 */
export function authoringSite(err: unknown, entry: string): string | undefined {
  return authorFrame(err, entry)?.site;
}

/**
 * The first author frame ({@link authoringSite}), and whether it is the frame
 * that THREW — the top of the stack — rather than a caller of SDK code that did.
 */
function authorFrame(err: unknown, entry: string): { site: string; top: boolean } | undefined {
  const stack = err instanceof Error ? (err.stack ?? "") : "";
  const project = projectRootFrom(dirname(resolve(entry))) + sep;
  let first = true;
  for (const line of stack.split("\n").slice(1)) {
    const frame = /(?:file:\/\/)?((?:\/|[A-Za-z]:[\\/])[^\s()]*?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!frame) continue;
    let file = frame[1]!;
    if (line.includes("file://")) {
      try {
        file = fileURLToPath(`file://${file}`);
      } catch {
        continue;
      }
    }
    const top = first;
    first = false;
    if (!file.startsWith(project) || file.includes(`${sep}node_modules${sep}`)) continue;
    if (file.startsWith(OWN_ROOT + sep + "src" + sep) || file.startsWith(OWN_ROOT + sep + "dist" + sep)) continue;
    return { site: `${relative(process.cwd(), file) || file}:${frame[2]}:${frame[3]}`, top };
  }
  return undefined;
}

/**
 * The author's own files on an error's stack, innermost first: every frame
 * outside this package and outside `node_modules`, with no project bound. A
 * caller that has no entry to bound by — `writeBundle` asking which project
 * built the registry and which module called it — reads its answer here.
 */
export function authorFiles(err: Error): string[] {
  const files: string[] = [];
  const stack: unknown = err.stack;
  for (const line of (typeof stack === "string" ? stack : "").split("\n").slice(1)) {
    const frame = /(?:file:\/\/)?((?:\/|[A-Za-z]:[\\/])[^\s()]*?):\d+:\d+\)?\s*$/.exec(line);
    if (!frame) continue;
    let file = frame[1]!;
    if (line.includes("file://")) {
      try {
        file = fileURLToPath(`file://${file}`);
      } catch {
        continue;
      }
    }
    if (file.includes(`${sep}node_modules${sep}`)) continue;
    if (file.startsWith(OWN_ROOT + sep + "src" + sep) || file.startsWith(OWN_ROOT + sep + "dist" + sep)) continue;
    if (!files.includes(file)) files.push(file);
  }
  return files;
}

/**
 * Frames to keep while an entry loads. A refusal raised several helpers deep in
 * a factory — a lambda body's parameter check under a statement factory under a
 * filter — leaves the author's own frame past V8's default of 10, and without
 * that frame the error is neither placed nor classed as the author's.
 */
const AUTHORING_STACK_DEPTH = 200;

/**
 * Run `load` with stacks deep enough for {@link withAuthoringSite} to find the
 * author's frame, restoring the process's own limit afterwards.
 */
export async function withAuthoringStacks<T>(load: () => Promise<T>): Promise<T> {
  const limit = Error.stackTraceLimit;
  if (typeof limit === "number" && limit >= AUTHORING_STACK_DEPTH) return load();
  Error.stackTraceLimit = AUTHORING_STACK_DEPTH;
  try {
    return await load();
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/** Tag an error a usage failure, by shape (the classifier reads `name`). */
function asUsage(err: Error): void {
  Object.defineProperty(err, "name", { value: "UsageError", configurable: true, writable: true });
}

/**
 * The same error, its message closed with where it was authored, and classed
 * as a usage failure when the author's code is at fault. Only an author's own
 * throw is annotated: a loader failure (it carries a `code`) is about the file,
 * not a line in it.
 *
 * The rule for the class: whatever fails in the author's own code is a usage
 * failure (`SDK_USAGE`) — a plain `Error` from a factory the author called (a
 * refused argument), ANY error thrown by a line the author wrote (their own
 * `TypeError`, their own `throw`), and an import of a name the SDK does not
 * export. A `TypeError` or kin thrown INSIDE the SDK keeps its class
 * (`SDK_ERROR`): that one is ours.
 */
export function withAuthoringSite(err: unknown, entry: string): unknown {
  if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== undefined) return err;
  const missing = /does not provide an export named '([^']+)'/.exec(err.message);
  if (err instanceof SyntaxError && missing !== null) {
    asUsage(err);
    return err;
  }
  const frame = authorFrame(err, entry);
  if (frame === undefined) return err;
  if (frame.top || Object.getPrototypeOf(err) === Error.prototype) asUsage(err);
  if (!err.message.includes(frame.site)) err.message = `${err.message}\n  (thrown while loading ${frame.site})`;
  return err;
}
