/**
 * Whether backend source REGISTERS a module — calls its `register*` function —
 * read over tokens rather than text: under whatever local name the file
 * imported it as, and never a call spelled inside a string or comment.
 *
 * One file at a time: the caller decides which files the backend reaches.
 */
import { scanSource } from "../values/lambda-source.js";

/**
 * `src` with every comment blanked, offsets kept. Strings stay, so an import's
 * specifier still reads — but a commented-out import (the snippet `init` leaves
 * for a module it could not wire) is not an import.
 */
export function withoutComments(src: string): string {
  let spans;
  try {
    spans = scanSource(src).spans;
  } catch {
    // A shape the scanner cannot read: the raw text, where a commented import still counts.
    return src;
  }
  const out = src.split("");
  for (const { kind, start, end } of spans) {
    if (kind !== "comment") continue;
    for (let i = start; i < end; i++) if (out[i] !== "\n") out[i] = " ";
  }
  return out.join("");
}

/** One static import declaration's bindings. */
interface ImportBindings {
  /** The quoted specifier, as written. */
  readonly specifier: string;
  /** `{ imported as local }` value specifiers (type-only ones left out). */
  readonly named: ReadonlyArray<{ imported: string; local: string }>;
  /** Names bound to the whole module or its default: `* as ns`, `def`, `{ default as d }`. */
  readonly owners: readonly string[];
  /** The declaration's offsets in the source. */
  readonly start: number;
  readonly end: number;
}

/** `name` as a regex fragment matching that text exactly. */
function literal(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every value import in `code` (comments already blanked). A type-only import
 * binds nothing callable and is skipped. The clause stops at the first
 * `from "…"` or `import`, so one import never reads into the next when the
 * file has no semicolons.
 */
function importsOf(code: string): ImportBindings[] {
  const clause = `((?:(?!\\bfrom\\s*["'\`]|\\bimport\\b)[^;])*?)`;
  const imports = new RegExp(
    `(?<![\\w$.])import\\s+(?!type\\s*[{*]|type\\s+(?!from\\b)[\\w$])${clause}\\s*from\\s*(["'\`])([^"'\`\\n]+)\\2`,
    "g",
  );
  const out: ImportBindings[] = [];
  for (const match of code.matchAll(imports)) {
    const bound = match[1]!.trim();
    const named: Array<{ imported: string; local: string }> = [];
    const owners: string[] = [];
    const brace = /\{([^}]*)\}/.exec(bound);
    if (brace !== null) {
      for (const part of brace[1]!.split(",")) {
        const spec = /^\s*(type\s+)?([\w$]+|"[^"]*"|'[^']*')\s*(?:as\s+([\w$]+))?\s*$/.exec(part);
        if (spec === null || spec[1] !== undefined) continue;
        const imported = spec[2]!.replace(/^["']|["']$/g, "");
        const local = spec[3] ?? imported;
        if (imported === "default") owners.push(local);
        else named.push({ imported, local });
      }
    }
    const namespace = /\*\s*as\s+([\w$]+)/.exec(bound);
    if (namespace !== null) owners.push(namespace[1]!);
    const head = /^([\w$]+)\s*(?:,|$)/.exec(bound);
    if (head !== null) owners.push(head[1]!);
    out.push({ specifier: match[3]!, named, owners, start: match.index, end: match.index + match[0].length });
  }
  return out;
}

/** `code` with strings, templates, regex literals and comments blanked; the raw text when it cannot be read. */
function codeOnly(code: string): string {
  try {
    return scanSource(code).mask;
  } catch {
    return code;
  }
}

/** Whether `specifier` is `pkg` or a subpath of it. */
function isPackage(specifier: string, pkg: string): boolean {
  return specifier === pkg || specifier.startsWith(`${pkg}/`);
}

/**
 * Where `mask` calls one of `direct`, or `register` as a member of one of
 * `owners`. `top`: a call at the module's top level. `wrappers`: the top-level
 * functions whose bodies hold a call — it registers only if one of them runs.
 * `opaque`: a call this read cannot attribute — inside braces or a concise
 * arrow body that is not such a function (a block, a method, a nested or
 * anonymous function), or handed a workspace it cannot tie to the one the file
 * exports. A call whose enclosing function takes a parameter of the called
 * name is to that parameter, not the import, and is not counted; nor is a call
 * handed a workspace provably other than the exported one.
 */
function callsAny(
  mask: string,
  direct: readonly string[],
  owners: readonly string[],
  register: string,
): { top: boolean; wrappers: string[]; opaque: boolean } {
  const out = { top: false, wrappers: [] as string[], opaque: false };
  const alternatives = [
    ...(direct.length > 0 ? [`(${direct.map(literal).join("|")})`] : []),
    ...(owners.length > 0 ? [`(${owners.map(literal).join("|")})\\s*\\??\\.\\s*${literal(register)}`] : []),
  ];
  if (alternatives.length === 0) return out;
  const concise = conciseBodies(mask);
  const exported = exportedWorkspace(mask);
  for (const m of mask.matchAll(new RegExp(`(?<![\\w$.])(?:${alternatives.join("|")})\\s*(?:\\?\\.\\s*)?\\(`, "g"))) {
    const name = m[1] ?? m[2]!;
    const scopes = enclosingScopes(mask, m.index, concise);
    let shadowed = false;
    let wrapper: string | undefined;
    const params: string[] = [];
    for (let k = scopes.length - 1; k >= 0; k--) {
      const header = scopes[k]!.header;
      if (header === undefined) continue;
      if (header.params.includes(name)) {
        shadowed = true;
        break;
      }
      params.push(...header.params);
      if (k === 0 && header.name !== undefined) wrapper = header.name;
    }
    if (shadowed) continue;
    const target = workspaceArgument(mask, m.index + m[0].length, exported, params);
    if (target === "other") continue;
    if (target === "unknown") out.opaque = true;
    else if (scopes.length === 0) out.top = true;
    else if (wrapper !== undefined) out.wrappers.push(wrapper);
    else out.opaque = true;
  }
  return out;
}

/** What the file default-exports, when it reads as a workspace: a binding's name, or `fresh` for `export default workspace(…)`. */
type Exported = { name: string } | "fresh" | undefined;

function exportedWorkspace(mask: string): Exported {
  const named =
    /(?<![\w$.])export\s+default\s+(?!function\b|class\b|async\b|new\b)([\w$]+)\s*(?:;|$)/m.exec(mask) ??
    /(?<![\w$.])export\s*\{[^}]*?(?<![\w$])([\w$]+)\s+as\s+default\b/.exec(mask);
  if (named !== null) return { name: named[1]! };
  if (/(?<![\w$.])export\s+default\s+workspace\s*\(/.test(mask)) return "fresh";
  return undefined;
}

/**
 * Whether the workspace a register call is handed (its first argument, read
 * from `at`, just past the call's `(`) is the one the file exports. `same` when
 * the file exports none to compare, the argument is not a bare binding (an
 * expression this read does not judge), or it is that binding or a parameter
 * of an enclosing function; `other` when it is a different binding
 * this file creates with `workspace(…)`; `unknown` otherwise.
 */
function workspaceArgument(mask: string, at: number, exported: Exported, params: readonly string[]): "same" | "other" | "unknown" {
  if (exported === undefined) return "same";
  const arg = /^\s*([\w$]+)\s*[,)]/.exec(mask.slice(at))?.[1];
  if (arg === undefined) return "same";
  if (exported !== "fresh" && arg === exported.name) return "same";
  if (params.includes(arg)) return "same";
  const created = new RegExp(`(?<![\\w$])(?:const|let|var)\\s+${literal(arg)}\\s*(?::[^=]*)?=\\s*workspace\\s*\\(`).test(mask);
  return created ? "other" : "unknown";
}

/** A concise arrow body — `=> expr` with no braces — as offsets in `mask`, with the arrow's header. */
interface ConciseBody {
  readonly start: number;
  readonly end: number;
  readonly header: { name?: string; params: string[] } | undefined;
}

/**
 * Every concise arrow body in `mask` (strings and comments already blanked).
 * The body runs from the first token after `=>` until, at its own nesting
 * depth, a `,` or `;`, a closer it did not open, or a line break that ends the
 * expression (one not after or before an operator).
 */
function conciseBodies(mask: string): ConciseBody[] {
  const out: ConciseBody[] = [];
  for (const m of mask.matchAll(/=>/g)) {
    let start = m.index + 2;
    while (start < mask.length && /\s/.test(mask[start]!)) start++;
    if (mask[start] === "{") continue;
    let depth = 0;
    let end = start;
    for (; end < mask.length; end++) {
      const c = mask[end]!;
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (c === "," || c === ";")) break;
      else if (depth === 0 && c === "\n") {
        const last = /(\S)\s*$/.exec(mask.slice(start, end))?.[1];
        const next = /^\s*(\S)/.exec(mask.slice(end))?.[1];
        const continued = (last !== undefined && /[=+\-*/%&|^!?:<>.~]/.test(last)) || (next !== undefined && /[.?+\-*/%&|^:=<>]/.test(next));
        if (!continued) break;
      }
    }
    out.push({ start, end, header: functionHeader(mask.slice(Math.max(0, m.index - 500), m.index + 2)) });
  }
  return out;
}

/** The scopes open at `at`, outermost first: each `{` (with the function it opens, if any) and each concise arrow body. */
function enclosingScopes(
  mask: string,
  at: number,
  concise: readonly ConciseBody[],
): Array<{ start: number; header: { name?: string; params: string[] } | undefined }> {
  const scopes = openBraces(mask, at).map((b) => ({ start: b, header: functionHeader(mask.slice(Math.max(0, b - 500), b)) }));
  for (const body of concise) if (body.start <= at && at < body.end) scopes.push({ start: body.start, header: body.header });
  return scopes.sort((a, b) => a.start - b.start);
}

/** The offsets of the `{` still open at `at` in `mask` (strings and comments already blanked), outermost first. */
function openBraces(mask: string, at: number): number[] {
  const open: number[] = [];
  for (let i = 0; i < at; i++) {
    const c = mask[i];
    if (c === "{") open.push(i);
    else if (c === "}") open.pop();
  }
  return open;
}

/**
 * The function whose body a `{` opens, read from the text just before it:
 * `function name(a, b) {`, `const name = (a) => {`, `const name = async function (a) {`.
 * Its name (when it has one) and the identifiers its parameters bind.
 */
function functionHeader(before: string): { name?: string; params: string[] } | undefined {
  const declared = /(?<![\w$.])function\s*\*?\s*([\w$]+)?\s*(?:<[^>]*>)?\s*\(([^()]*)\)\s*(?::[^{}]*)?$/.exec(before);
  const arrow =
    declared === null
      ? /(?:(?<![\w$])(?:const|let|var)\s+([\w$]+)\s*(?::[^=]*)?=\s*)?(?:async\s*)?(?:\(([^()]*)\)|([\w$]+))\s*(?::[^=]*)?=>\s*$/.exec(before)
      : null;
  const m = declared ?? arrow;
  if (m === null) return undefined;
  let name = m[1];
  if (declared !== null && name === undefined) {
    name = /(?<![\w$])(?:const|let|var)\s+([\w$]+)\s*(?::[^=]*)?=\s*(?:async\s+)?function\s*\*?\s*(?:<[^>]*>)?\s*\([^()]*\)\s*(?::[^{}]*)?$/.exec(before)?.[1];
  }
  const list = m[2] ?? m[3] ?? "";
  const params = [...list.replace(/:[^,=]*/g, "").matchAll(/[\w$]+/g)].map((p) => p[0]);
  return { ...(name === undefined ? {} : { name }), params };
}

/** Whether `mask` calls one of `names` at its top level — outside every brace and concise arrow body. */
function callsAtTop(mask: string, names: readonly string[]): boolean {
  if (names.length === 0) return false;
  const concise = conciseBodies(mask);
  for (const m of mask.matchAll(new RegExp(`(?<![\\w$.])(?:${names.map(literal).join("|")})\\s*\\(`, "g"))) {
    if (/(?<![\w$])function\s*\*?\s*$/.test(mask.slice(Math.max(0, m.index - 30), m.index))) continue;
    if (enclosingScopes(mask, m.index, concise).length === 0) return true;
  }
  return false;
}

/**
 * The top-level functions in `code` whose bodies call `register` from `pkg`
 * and that `code` itself never calls at its top level — the wiring then rests
 * on another file calling one of them.
 */
export function registerWrappers(code: string, pkg: string, register: string): string[] {
  return registerRead(code, pkg, register).wrappers;
}

/**
 * Whether `code` calls, at its top level, one of `names` as imported from
 * another of the project's own files (a relative specifier).
 */
export function callsImportedAtTop(code: string, names: readonly string[]): boolean {
  const locals: string[] = [];
  for (const imp of importsOf(withoutComments(code))) {
    if (!/^[./]/.test(imp.specifier)) continue;
    for (const n of imp.named) if (names.includes(n.imported)) locals.push(n.local);
  }
  return callsAtTop(codeOnly(code), locals);
}

/** How sure a read of one file is that it registers a module. */
export type RegisterState = "yes" | "no" | "unknown";

/** The `{ … }` destructuring pattern's `register` binding, if it names one: `{ registerAuth }`, `{ registerAuth: r }`. */
function destructured(pattern: string, register: string): string | undefined {
  for (const part of pattern.split(",")) {
    const m = /^\s*([\w$]+)\s*(?::\s*([\w$]+))?\s*(?:=[^,]*)?$/.exec(part);
    if (m !== null && m[1] === register) return m[2] ?? m[1];
  }
  return undefined;
}

/** `code` with each string literal opened at `at` read as its contents, when one starts there. */
function stringAt(code: string, at: number): { value: string; end: number } | undefined {
  const m = /^\s*(["'`])([^"'`\n\\$]*)\1/.exec(code.slice(at));
  return m === null ? undefined : { value: m[2]!, end: at + m[0].length };
}

/**
 * Whether `code` (comments already blanked) calls `register` as imported from
 * `pkg` or a subpath of it — under whatever local name the file gave it:
 *
 * - `import { registerAuth } …` → `registerAuth(`, aliased `ra(`
 * - `import * as auth …` / `import auth …` → `auth.registerAuth(`, `auth["registerAuth"](`
 * - `const { registerAuth: r } = auth` / `const r = auth.registerAuth` → `r(`
 * - `const { registerAuth } = await import("…")`, `const auth = await import("…")`,
 *   `(await import("…")).registerAuth(`
 *
 * `"unknown"` when the file reaches the module in a way this read cannot follow
 * — a computed member, the namespace handed elsewhere, a re-export, a dynamic
 * import used any other way — and calls nothing it can see.
 */
export function registerState(code: string, pkg: string, register: string): RegisterState {
  return registerRead(code, pkg, register).state;
}

function registerRead(code: string, pkg: string, register: string): { state: RegisterState; wrappers: string[] } {
  const mask = codeOnly(code);
  const direct: string[] = [];
  const owners: string[] = [];
  let unknown = false;
  const importSpans: Array<[number, number]> = [];
  for (const imp of importsOf(code)) {
    if (!isPackage(imp.specifier, pkg)) continue;
    for (const n of imp.named) if (n.imported === register) direct.push(n.local);
    owners.push(...imp.owners);
    importSpans.push([imp.start, imp.end]);
  }
  // Dynamic imports of the package: `import(` in code, its specifier a literal naming `pkg`.
  for (const m of mask.matchAll(/(?<![\w$.])import\s*\(/g)) {
    const spec = stringAt(code, m.index + m[0].length);
    if (spec === undefined || !isPackage(spec.value, pkg)) continue;
    const close = /^\s*\)/.exec(code.slice(spec.end));
    if (close === null) {
      unknown = true;
      continue;
    }
    const after = spec.end + close[0].length;
    const before = mask.slice(Math.max(0, m.index - 2000), m.index);
    const bound = /(?<![\w$])(?:const|let|var)(?:\s*\{([^}]*)\}|\s+([\w$]+))\s*=\s*(?:await\s+)?$/.exec(before);
    if (bound !== null) {
      if (bound[1] !== undefined) {
        const local = destructured(bound[1], register);
        if (local !== undefined) direct.push(local);
      } else owners.push(bound[2]!);
      continue;
    }
    const member = new RegExp(`^\\s*\\)\\s*\\??\\.\\s*${literal(register)}\\s*(?:\\?\\.\\s*)?\\(`).exec(mask.slice(after));
    if (/\(\s*await\s+$/.test(before) && member !== null) return { state: "yes", wrappers: [] };
    unknown = true;
  }
  // A re-export hands the module to another file, which this one cannot see.
  const reexport = new RegExp(`(?<![\\w$.])export\\s*(\\*|\\{[^}]*\\})[^;]*?\\bfrom\\s*(["'\`])([^"'\`\\n]+)\\2`, "g");
  for (const m of code.matchAll(reexport)) {
    if (isPackage(m[3]!, pkg) && (m[1] === "*" || new RegExp(`(?<![\\w$])${literal(register)}(?![\\w$])`).test(m[1]!))) unknown = true;
  }
  // Each use of a namespace binding: a member, a literal element, or a
  // destructuring source is followed; anything else is the module handed on.
  for (const owner of owners) {
    for (const m of mask.matchAll(new RegExp(`(?<![\\w$.])${literal(owner)}(?![\\w$])`, "g"))) {
      if (importSpans.some(([s, e]) => m.index >= s && m.index < e)) continue;
      const end = m.index + owner.length;
      const rest = mask.slice(end);
      const before = mask.slice(Math.max(0, m.index - 2000), m.index);
      if (/(?<![\w$])(?:const|let|var)\s+$/.test(before) && /^\s*=(?!=)/.test(rest)) continue;
      if (/^\s*\??\.\s*[\w$]/.test(rest)) {
        const alias = new RegExp(`(?<![\\w$])(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*$`).exec(before);
        if (alias !== null && new RegExp(`^\\s*\\??\\.\\s*${literal(register)}(?![\\w$])(?!\\s*[(?.[])`).test(rest)) direct.push(alias[1]!);
        continue;
      }
      const bracket = /^\s*(?:\?\.\s*)?\[/.exec(rest);
      if (bracket !== null) {
        const key = stringAt(code, end + bracket[0].length);
        if (key === undefined || !/^\s*\]/.test(code.slice(key.end))) {
          unknown = true;
          continue;
        }
        if (key.value !== register) continue;
        const tail = mask.slice(key.end).replace(/^\s*\]/, "");
        if (/^\s*(?:\?\.\s*)?\(/.test(tail)) return { state: "yes", wrappers: [] };
        continue;
      }
      const pattern = /(?<![\w$])(?:const|let|var)\s*\{([^}]*)\}\s*=\s*$/.exec(before);
      if (pattern !== null) {
        const local = destructured(pattern[1]!, register);
        if (local !== undefined) direct.push(local);
        continue;
      }
      if (/^\s*\??\.\s*\(/.test(rest)) continue;
      unknown = true;
    }
  }
  // Each use of a direct binding other than a call — re-exported, a default
  // export, an array element, an argument, `.call`/`.apply`/`.bind` — hands the
  // function on to code this read cannot follow.
  for (const local of direct) {
    for (const m of mask.matchAll(new RegExp(`(?<![\\w$.])${literal(local)}(?![\\w$])`, "g"))) {
      if (importSpans.some(([s, e]) => m.index >= s && m.index < e)) continue;
      const rest = mask.slice(m.index + local.length);
      if (/^\s*(?:\?\.\s*)?\(/.test(rest)) continue;
      const before = mask.slice(Math.max(0, m.index - 2000), m.index);
      // Its own declaration: `const r = auth.registerAuth`, `const { registerAuth: r } = …`.
      if (/(?<![\w$])(?:const|let|var)\s+$/.test(before) || /(?<![\w$])(?:const|let|var)\s*\{[^}]*$/.test(before)) continue;
      // A parameter of that name declares a new binding, shadowing it: not a use.
      if (/(?<![\w$.])function\s*\*?\s*[\w$]*\s*(?:<[^>]*>)?\s*\([^()]*$/.test(before)) continue;
      if (/\([^()]*$/.test(before) && /^[^()]*\)\s*(?::[^=]*)?=>/.test(rest)) continue;
      unknown = true;
    }
  }
  const calls = callsAny(mask, direct, owners, register);
  if (calls.top || callsAtTop(mask, calls.wrappers)) return { state: "yes", wrappers: [] };
  const nested = calls.opaque || calls.wrappers.length > 0;
  return { state: unknown || nested ? "unknown" : "no", wrappers: [...new Set(calls.wrappers)] };
}

/** Whether `code` (comments already blanked) visibly calls `register` from `pkg` — {@link registerState} is `"yes"`. */
export function callsRegister(code: string, pkg: string, register: string): boolean {
  return registerState(code, pkg, register) === "yes";
}

/** A package name from a bare specifier: `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/**
 * Every module `code` registers: each package (other than `@xano/sdk` itself)
 * whose `register*` function the file imports and calls, with that function's
 * name. Relative imports are the project's own files, not modules.
 */
export function registeredModules(code: string): Array<{ pkg: string; register: string }> {
  const mask = codeOnly(code);
  const found = new Map<string, { pkg: string; register: string }>();
  for (const imp of importsOf(code)) {
    if (/^[./]/.test(imp.specifier) || /^[a-z]+:/i.test(imp.specifier)) continue;
    const pkg = packageOf(imp.specifier);
    if (pkg === "@xano/sdk") continue;
    const candidates = new Set(imp.named.map((n) => n.imported).filter((n) => /^register[A-Z]/.test(n)));
    for (const owner of imp.owners) {
      for (const m of mask.matchAll(new RegExp(`(?<![\\w$.])${literal(owner)}\\s*\\??\\.\\s*(register[A-Z][\\w$]*)`, "g"))) {
        candidates.add(m[1]!);
      }
    }
    for (const register of candidates) {
      if (callsRegister(code, pkg, register)) found.set(`${pkg}\0${register}`, { pkg, register });
    }
  }
  return [...found.values()];
}
