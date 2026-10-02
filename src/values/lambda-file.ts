/**
 * `lam.file` — a lambda body that lives in its own type-checked module.
 *
 * The inline form ({@link lam.fn}) is right up to the point where a body earns
 * real structure: helpers, branches, a shape worth reading on its own. Past that
 * it wants to be a file the author's own `tsconfig` checks, their editor
 * navigates, and their formatter formats. `lam.file("./lambdas/total.ts")` reads
 * that file at build time and emits the same `const:text` every other `lam.*`
 * form emits, through the same extraction and the same guard.
 *
 * The file's shape is one default-exported function whose first parameter
 * destructures the bindings — the same convention as the inline form, so
 * `LambdaBindings<"reduce">` annotates it and the body type-checks:
 *
 * ```ts
 * // lambdas/order-total.ts
 * import type { LambdaBindings } from "@xano/sdk";
 * export default ({ $result, $this }: LambdaBindings<"reduce">) => {
 *   const line = $this.qty * $this.price;
 *   return $result + line;
 * };
 * ```
 *
 * It is read as TEXT rather than imported: no transpiler runs, so what the engine
 * receives is exactly the bytes in the file (TypeScript annotations included —
 * the engine's executor accepts them). That is also what makes this the
 * deterministic option when a bundler is in play, where `Function.prototype
 * .toString()` returns whatever the bundler emitted.
 *
 * This lives on `@xano/sdk/node` because it touches the filesystem; the
 * isomorphic entry has no `lam.file`.
 */
import { readFileSync } from "node:fs";
import { isMissingFile } from "../util/local-file.js";
import { LocalFileNotFoundError } from "../emit/errors.js";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Value } from "./value.js";
import { SourceReader, SourceShapeError, lineOf, maskNonCode, tokenize } from "./lambda-source.js";
import {
  extractFunction,
  readFunction,
  lam as isomorphicLam,
  lambdaSyntaxError,
  lambdaValue,
  LAMBDA_GLOBALS,
  LAMBDA_MODULE_GLOBALS,
} from "./lambda.js";
import type { CaptureValue, LambdaOptions } from "./lambda.js";
import { readsFreeName } from "./lambda-scope.js";
import { decodeIdentifier, decodeIdentifierEscapes } from "./lambda-ident.js";

const PREFIX = "lam.file";

/** Transpiling loaders whose frames sit between this module and the caller's. */
const LOADER_FRAME = /[/\\]node_modules[/\\](?:\.pnpm[/\\][^/\\]+[/\\]node_modules[/\\])?(?:vite-node|vite|vitest|tsx|ts-node|jiti|esbuild-register|@esbuild-kit)[/\\]/;

/** This module's own path, so its frames can be told from the caller's. */
const SELF = fileURLToPath(import.meta.url);

/**
 * The file of every frame on the current stack, innermost first — the file
 * that is actually RUNNING, never the one a source map points at.
 *
 * Read off V8's structured call sites rather than the rendered `stack` string.
 * With source maps on (`--enable-source-maps`, or a loader that turns them on)
 * the string is rewritten to the ORIGINAL sources, so a frame of this module in
 * a built chunk reads as `…/src/values/lambda-file.ts`: no longer this module
 * by path, and taken for the caller — which resolved the author's relative
 * path against the SDK's own source tree. A call site's file name is the
 * loaded module's, whatever the renderer does with it. The string parse stays
 * as the fallback for an engine with no structured stack.
 */
function stackFiles(): string[] {
  const previous = Error.prepareStackTrace;
  let sites: unknown;
  try {
    Error.prepareStackTrace = (_error, callSites) => callSites;
    sites = new Error().stack;
  } finally {
    Error.prepareStackTrace = previous;
  }
  if (Array.isArray(sites)) {
    return (sites as NodeJS.CallSite[])
      .slice(1)
      .map((site) => site.getFileName() ?? site.getScriptNameOrSourceURL?.() ?? "")
      .filter((file): file is string => typeof file === "string" && file !== "");
  }
  const files: string[] = [];
  for (const line of String(typeof sites === "string" ? sites : new Error().stack ?? "").split("\n").slice(1)) {
    const match = /\((.*?):\d+:\d+\)\s*$/.exec(line) ?? /at (.*?):\d+:\d+\s*$/.exec(line);
    if (match?.[1] !== undefined) files.push(match[1]);
  }
  return files;
}

/**
 * The directory of the module that called `lam.file`.
 *
 * A relative path in a workspace definition means "next to this file", the way
 * every `import` in the same file does — resolving against `process.cwd()`
 * instead would make the same definition compile or fail depending on which
 * directory the build was launched from. Node has no `import.meta` of the
 * caller, so the frame is read off a stack trace: the first frame outside this
 * module is the caller.
 */
function callerDir(): string {
  const frames: string[] = [];
  for (const raw of stackFiles()) {
    if (raw.startsWith("node:")) continue;
    const path = raw.startsWith("file:") ? fileURLToPath(raw) : raw;
    // Matched by PATH, not by filename: a user module may well be called
    // `lambda-file.ts` too, and skipping it would resolve against the wrong dir.
    if (path === SELF) continue;
    frames.push(path);
  }
  // A loader can sit between this module and the authored one — vite-node, tsx,
  // ts-node — and its frames come first. Skipping those by NAME rather than
  // skipping all of `node_modules` matters: a shared definitions package that
  // ships its own lambda files lives in `node_modules` legitimately, and
  // resolving its relative paths against the consuming app's directory would
  // read the wrong file (or none).
  const authored = frames.find((p) => !LOADER_FRAME.test(p));
  return dirname(authored ?? frames[0] ?? process.cwd());
}

/**
 * Walk the module's top-level statements and return the default export's
 * expression as a source range, refusing anything that would not survive
 * extraction.
 *
 * Only the default export's body is sent to the engine, so anything ELSE
 * declared at the top level of the file is silently absent at runtime — a helper
 * function defined beside the default export would be undefined inside it, and
 * the engine would hand that back as diagnostic text in the value slot. Imports
 * and type-only declarations are the exception: they exist for the author's
 * type-checker and vanish from the emitted body either way.
 *
 * Statements are told apart by tokens, matched brackets and JavaScript's own
 * line-break rules — never by newlines alone, so a default export whose body
 * continues on the next line is one statement, and a type declared after it is
 * another.
 */
function defaultExport(source: string, path: string): [number, number] {
  const reader = new SourceReader(tokenize(source));
  const { toks } = reader;
  const at = (k: number): string => `${path}:${lineOf(source, reader.offset(k))}`;
  let found: [number, number] | undefined;
  let k = 0;
  try {
    while (k < toks.length) {
      const t = toks[k]!;
      if (reader.isP(k, ";")) {
        k++;
        continue;
      }
      // A directive prologue (`"use strict";`) does nothing the body depends on.
      if (t.kind === "string" && (reader.isP(k + 1, ";") || toks[k + 1] === undefined || toks[k + 1]!.nl)) {
        k++;
        continue;
      }
      if (reader.isId(k, "export") && reader.isId(k + 1, "default")) {
        if (found !== undefined) throw new Error(`${PREFIX}: ${at(k)} has more than one \`export default\`.`);
        const first = k + 2;
        const head = toks[first];
        if (!(reader.isP(first, "(") || reader.isP(first, "<") || (head?.kind === "id" && !reader.isId(first, "class")))) {
          throw new Error(
            `${PREFIX}: ${at(first)} default-exports something that is not a function. Export the lambda itself: ` +
              `\`export default ({ $this }: LambdaBindings<"map">) => …\`.`,
          );
        }
        const { end } = parseDefault(reader, first, at);
        found = [reader.offset(first), toks[end - 1]!.end];
        k = end;
        continue;
      }
      if (isTypeOnly(reader, k)) {
        k = skipTypeOnly(reader, k);
        continue;
      }
      if (reader.isId(k, "export")) {
        throw new Error(
          `${PREFIX}: ${at(k)} exports something besides its default. Only the default export's BODY is sent to the ` +
            `engine, so a second export is undefined at runtime — the engine returns that failure as diagnostic text ` +
            `in the value slot rather than as an error. A lambda module is one \`export default\` function and nothing ` +
            `else: move it inside that function.`,
        );
      }
      // A VALUE import is never resolved: the module is never loaded, so the
      // imported binding is undefined inside the body. Dependencies come from the
      // preloaded globals — a literal `import()`/`require()` specifier does not
      // resolve on every instance.
      if (reader.isId(k, "import")) {
        throw new Error(
          `${PREFIX}: ${at(k)} imports a value at the top level, which the engine never resolves — only the default ` +
            `export's body is sent, so the import is undefined at runtime. Use \`import type\` for types, or reach a ` +
            `dependency through the PRELOADED globals, which need no specifier and are the only route that works on ` +
            `every instance: ${LAMBDA_MODULE_GLOBALS.join(", ")} (plus ${LAMBDA_GLOBALS.join(" / ")}, fetch, Buffer, ` +
            `TextEncoder). A scaffolded project's \`xano/lambdas/tsconfig.json\` declares them for the type checker ` +
            `(\`@xano/sdk/lambda-globals\`; keep it in a tsconfig of the lambdas' own, as its globals reach the whole program).`,
        );
      }
      // Name what the author actually declared, not the keyword in front of it.
      let n = k;
      if (reader.isId(n, "async")) n++;
      const declared = /^(?:const|let|var|function|class|enum)$/.test(toks[n]?.text ?? "") && reader.isId(n + 1)
        ? toks[n + 1]!.text
        : t.text;
      throw new Error(
        `${PREFIX}: ${at(k)} declares \`${declared}\` at the top level, and only the default export's BODY is ` +
          `sent to the engine — anything beside it is undefined at runtime, and the engine returns that failure as ` +
          `diagnostic text in the value slot rather than as an error. Move it inside the default-exported function.`,
      );
    }
  } catch (e) {
    if (e instanceof SourceShapeError) {
      throw new Error(
        `${PREFIX}: could not read ${path}:${lineOf(source, e.offset)} (${e.message}), so the default export's body ` +
          `cannot be located with certainty. A lambda module is one \`export default\` function — ` +
          `\`export default ({ $var }: …) => …\` or \`export default function ({ $var }: …) { … }\` — plus type-only ` +
          `imports and declarations.`,
      );
    }
    throw e;
  }
  if (found === undefined) {
    throw new Error(
      `${PREFIX}: ${path} has no \`export default\`. A lambda module is one default-exported function whose ` +
        `first parameter destructures the bindings — \`export default ({ $this }: LambdaBindings<"map">) => …\`.`,
    );
  }
  return found;
}

/**
 * Reject a NAMED default export that reads its own name. Only the body is sent,
 * so the name is not bound at runtime: recursion through it, or
 * `countStops.length`, is undefined there — the same failure a top-level helper
 * has, returned as text in the value slot.
 */
function assertNoSelfReference(exported: string, path: string): void {
  const name = readFunction(exported, `${PREFIX}: ${path}`).name;
  if (name === undefined) return;
  // Scope-aware: a local that shadows the name, an object key and a property
  // access are not reads of the function's own binding.
  if (!readsFreeName(maskNonCode(decodeIdentifierEscapes(exported)), decodeIdentifier(name))) return;
  throw new Error(
    `${PREFIX}: ${path} default-exports \`function ${name}\` and reads \`${name}\` inside it, but only the ` +
      `function's BODY is sent to the engine — the name is not bound at runtime, so the reference is undefined ` +
      `there. For recursion, declare a helper inside the body (\`const walk = (node) => …walk(child)…\`) and call it.`,
  );
}

/**
 * Read the default-exported function at token `first`, returning the token
 * index past its statement. A `function` there is a DECLARATION, which ends at
 * its body's `}` whatever follows; anything else is one expression, which ends
 * where JavaScript ends it — and must end there, not run on into a call or a
 * member access that would make the export something other than the function.
 */
function parseDefault(reader: SourceReader, first: number, at: (k: number) => string): { end: number } {
  const { end } = reader.parseFunctionExpression(first);
  const next = reader.toks[end];
  const declaration = reader.isId(first, "function") || (reader.isId(first, "async") && reader.isId(first + 1, "function"));
  if (next === undefined || reader.isP(end, ";") || declaration) return { end };
  if (next.nl && !reader.continues(next)) return { end };
  throw new Error(
    `${PREFIX}: ${at(end)} default-exports an expression that continues past the function (\`${next.text}\`), so ` +
      `what is exported is not the function itself. Export the lambda itself: ` +
      `\`export default ({ $this }: LambdaBindings<"map">) => …\`.`,
  );
}

/** Whether the statement at `k` exists only for the type-checker. */
function isTypeOnly(reader: SourceReader, k: number): boolean {
  const n = reader.isId(k, "export") ? k + 1 : k;
  if (reader.isId(n, "interface") && reader.isId(n + 1)) return true;
  if (reader.isId(n, "type") && (reader.isId(n + 1) || reader.isP(n + 1, "{") || reader.isP(n + 1, "*"))) return true;
  if (n === k && reader.isId(k, "declare") && !reader.toks[k + 1]?.nl) return true;
  if (n !== k || !reader.isId(k, "import")) return false;
  // `import type { A } from "…"`, `import type A from "…"` — but `import type from "…"` imports a value named `type`.
  if (reader.isId(k + 1, "type") && !(reader.isId(k + 2, "from") && reader.toks[k + 3]?.kind === "string")) return true;
  // `import { type A, type B } from "…"` names only types, so it vanishes the same way.
  if (!reader.isP(k + 1, "{")) return false;
  const close = reader.close(k + 1);
  const specifiers: number[][] = [[]];
  for (let j = k + 2; j < close; j++) {
    if (reader.isP(j, ",")) specifiers.push([]);
    else specifiers[specifiers.length - 1]!.push(j);
  }
  const named = specifiers.filter((s) => s.length > 0);
  return named.length > 0 && named.every((s) => reader.isId(s[0]!, "type") && s.length > 1);
}

/** Token index past a type-only statement. */
function skipTypeOnly(reader: SourceReader, k: number): number {
  let n = reader.isId(k, "export") ? k + 1 : k;
  // `type Name<…> = Type` and `interface Name<…> extends A, B { … }` are read by the type grammar:
  // a line break inside a union or a function type does not end them.
  if (reader.isId(n, "type") && reader.isId(n + 1) && (reader.isP(n + 2, "=") || reader.isP(n + 2, "<"))) {
    n += 2;
    if (reader.isP(n, "<")) n = reader.skipAngle(n);
    if (!reader.isP(n, "=")) reader.fail("a type alias without `=`", n);
    n = reader.skipType(n + 1);
    return reader.isP(n, ";") ? n + 1 : n;
  }
  if (reader.isId(n, "interface")) {
    n += 2;
    if (reader.isP(n, "<")) n = reader.skipAngle(n);
    if (reader.isId(n, "extends")) {
      n = reader.skipType(n + 1, true);
      while (reader.isP(n, ",")) n = reader.skipType(n + 1, true);
    }
    if (!reader.isP(n, "{")) reader.fail("an interface without a body", n);
    return reader.close(n) + 1;
  }
  return reader.statementEnd(k);
}

/**
 * Read a lambda body from its own module.
 *
 * `path` resolves against the CALLING module's directory (like an `import`), not
 * the process working directory. The file must default-export exactly one
 * function; its body is extracted and validated exactly as {@link lam.fn}'s is.
 */
export function file(path: string, opts?: LambdaOptions<Record<string, CaptureValue>>): Value {
  const resolved = isAbsolute(path) ? path : resolve(callerDir(), path);

  let source: string;
  try {
    source = readFileSync(resolved, "utf8");
  } catch (err) {
    throw new (isMissingFile(err) ? LocalFileNotFoundError : Error)(
      `${PREFIX}: ${isMissingFile(err) ? "no file at" : "cannot read"} ${resolved} (resolved from ${JSON.stringify(path)}, relative to the calling module ` +
        `rather than the working directory).`,
    );
  }

  const [start, end] = defaultExport(source, resolved);
  const exported = source.slice(start, end);
  assertNoSelfReference(exported, resolved);
  const { body, captureReads } = extractFunction(exported, `${PREFIX}: ${resolved}`);
  assertBodyParses(body, source, start + readFunction(exported, `${PREFIX}: ${resolved}`).body[0], resolved);
  return lambdaValue(body, opts, `${PREFIX}(${path})`, false, captureReads);
}

/**
 * Refuse a body that does not parse, at its line in the FILE. Checked here,
 * before the capture prelude is prepended and the call site checks the text
 * again, because only here is the file known: the body's first line is the
 * first non-blank one at or after `bodyStart`, and its lines map one to one.
 */
function assertBodyParses(body: string, source: string, bodyStart: number, path: string): void {
  const error = lambdaSyntaxError(body);
  if (error === undefined) return;
  const first = bodyStart + Math.max(source.slice(bodyStart).search(/\S/), 0);
  const line = lineOf(source, first) + error.line - 1;
  const text = source.split("\n")[line - 1] ?? error.lineText;
  throw new Error(
    `${PREFIX}: ${path}:${line}: the lambda body does not parse — ${error.message} (\`${text.trim()}\`). A body ` +
      `that does not parse cannot run.`,
  );
}

/**
 * Lambda authoring, with the filesystem form attached.
 *
 * Identical to the `lam` exported from `@xano/sdk`, plus {@link file}. The
 * isomorphic entry deliberately does not carry it: reading a file is not
 * something a browser bundle can do, and a workspace definition shared with a
 * frontend must keep resolving.
 */
export const lam = { ...isomorphicLam, file };
