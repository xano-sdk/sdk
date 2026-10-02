/**
 * Project assembly — decoded objects → a tree of source files.
 *
 * Three problems live here, none of which a per-object decoder can see:
 *
 * - **Symbols.** Xano names are not identifiers. They carry spaces, hyphens,
 *   leading digits, and they collide across kinds (a `users` table and a `users`
 *   function are both legal). Sanitization plus deterministic disambiguation
 *   happens once, up front, so every reference site agrees.
 * - **File layout.** One directory per kind, with an object nested under its
 *   parent where it has one (a query under its api group, a trigger under what
 *   it fires on) and one file per object named after it. Anything referenced
 *   from more than one file lands in `_shared.ts` — co-location is what keeps
 *   the cross-file import graph acyclic.
 * - **Cycles.** Two functions that call each other would import each other.
 *   `ObjectRef` already accepts `{name, guid}`, so a back edge degrades to a
 *   hoisted const holding that literal instead and no circular import is
 *   ever emitted.
 *
 * The reference graph those last two need is derived from the **stored** objects,
 * not from decoding them: any guid a decoder resolves appears as a string
 * somewhere in the stored JSON, so scanning for known guids yields a superset of
 * the real edges. A superset is the safe direction — it can place an object in
 * `_shared.ts` that did not strictly need to be there, but it can never miss an
 * edge and emit a cycle.
 *
 * Everything is order-deterministic: the same bundle assembles to byte-identical
 * files, which is what lets the generated tree be compared directly in tests.
 */
import type { DecodeContext } from "./context.js";
import { SDK_MODULE } from "./context.js";
import { lit, obj, printExpr, printModule, type Expr, type Stmt } from "./print.js";
import type { GeneratedFile } from "./index.js";
import type { IndexedObject, RefIndex } from "./ref-index.js";
import { AUTHOR_KIND_NAME } from "../kinds/def-shape.js";
import { identityName } from "./labels.js";
import { SDK_RUNTIME_EXPORTS } from "./sdk-surface.generated.js";
import * as codegenSurface from "../codegen-entry.js";
import {
  decodeObject,
  KIND_DECODERS,
  KIND_DECODERS_BY_NAME,
  type StoredObject,
} from "./kinds/index.js";

/** The file cross-referenced non-table objects share. */
const SHARED_FILE = "_shared.ts";

/**
 * The directory tables land in, one file per table.
 *
 * Not one `table/table.ts`: at real scale that is a two-thousand-line file
 * whose name says nothing, and every editor tab in a pulled tree reads
 * `table.ts`.
 *
 * Splitting costs no fidelity. Mutually-referencing tables are common — Xano
 * writes a `tableref` on both sides of a relation — but such a pair was ALREADY
 * a cycle *inside* a single file too, so the same edge degrades to the same
 * hoisted `{name, guid}` const either way: the number of degraded reference
 * SITES is the same. What rises is the number of hoisted CONSTS, because a
 * target referred to from three files now declares one in each rather than
 * sharing a single declaration. That is the number `npm run codegen:replay
 * --refs` reports, and it is bytes, not lost references.
 */
const TABLE_DIR = "table";

/**
 * Queries nest one level further than every other kind: `query/<api group>/`.
 * A group's own definition sits in that folder under a fixed name, and queries
 * with no resolvable group collect in one file beside the group folders.
 */
const QUERY_DIR = "query";

/**
 * Queries with no resolvable group share one file beside the group files.
 *
 * The leading underscore is not decoration: `toSymbol` strips leading
 * underscores, so no Xano object can ever produce this name, and a group that
 * happens to be called `orphaned` cannot collide with it. `_shared.ts` is safe
 * for the same reason.
 */
const ORPHANED_QUERY_FILE = "query/_orphaned.ts";

/**
 * The stored reference naming a kind's parent, and the kind that reference must
 * resolve to before it counts.
 *
 * Every one of these is stored the same way — `{ id: <guid> }` under a named key
 * — so one shape reads all of them. Requiring the resolved KIND to match is what
 * keeps a stale or reused guid from nesting an object under something unrelated.
 *
 * Realtime is the only three-level hierarchy in a workspace: a message belongs to
 * a channel, which belongs to a server. Resolution is therefore recursive, and a
 * message ends up beside its channel, inside its server.
 */
const PARENT_REF: Readonly<Record<string, { key: string; kind: string }>> = {
  query: { key: "app", kind: "api_group" },
  channel: { key: "server", kind: "realtime_server" },
  message: { key: "channel", kind: "channel" },
};

/**
 * Kinds that OWN a directory, because they have objects nested beneath them: an
 * api group has queries, a realtime server has channels, a channel has messages
 * and triggers.
 *
 * The definition itself sits BESIDE that directory rather than inside it —
 * `chat.ts` next to `chat/` — which is the `Button.tsx` + `Button/` idiom. Three
 * things fall out of that. The file is named for the OBJECT, so an editor tab
 * reads `chat.ts` rather than a dozen identical `realtime_server.ts`. The path
 * does not stutter (`chat/chat.ts`). And a container with nothing nested under
 * it needs no directory at all.
 *
 * `table` is deliberately absent: nothing nests under a table, so it needs no
 * directory of its own beyond the flat `table/` one every table shares.
 */
const CONTAINER_KINDS: ReadonlySet<string> = new Set(["api_group", "realtime_server", "channel"]);

/** Where a trigger's own files go inside its parent's directory. */
const TRIGGER_SUBDIR = "trigger";

/** The workspace config's own file, and the binding the barrel imports from it. */
const WORKSPACE_FILE = "workspace.ts";
const WORKSPACE_SYMBOL = "workspaceSettings";

/** One object placed in the generated tree. */
interface Placement {
  readonly object: IndexedObject;
  readonly stored: StoredObject;
  /** Exported binding name. */
  readonly symbol: string;
  /** File path relative to the output root. */
  readonly path: string;
  /** Directory the file sits in, for relative-specifier construction. */
  readonly dir: string;
}

/**
 * Identifiers a generated file imports from the SDK, which an object symbol must
 * therefore never take.
 *
 * A Xano workspace may legally hold a table named `table`, a function named
 * `query` or an apiGroup named `auth`, and its symbol would otherwise collide
 * with the SDK binding the file imports to build it — `const table = table({…})`
 * is a TDZ crash, and `import { auth } from "@xano/sdk"` beside
 * `import { auth } from "../auth.js"` is a duplicate binding. Reserving the
 * names up front pushes the object to `table_table`, reusing the same
 * disambiguation the cross-kind case already applies.
 *
 * DERIVED from the two entries a generated file imports from — every runtime
 * export of `@xano/sdk` (generated by `npm run codegen:surface`, pinned by a
 * test against the barrel) and of `@xano/sdk/codegen` — rather than listed by
 * hand, so a new export is reserved the day it ships. The barrel's list is
 * generated rather than read off `import * as`: a namespace import of the
 * barrel makes a browser bundle that imports one name keep every export.
 */
const RESERVED_SYMBOLS: readonly string[] = [
  ...SDK_RUNTIME_EXPORTS,
  ...Object.keys(codegenSurface),
  // The barrel's import of `workspace.ts`. An object taking this name would make
  // the barrel import two different bindings under one identifier — a syntax
  // error in the one file that has to load for anything to deploy.
  WORKSPACE_SYMBOL,
  // The trigger callbacks' parameter (`stack: (t) => […]`). An object bound as
  // `t` would be shadowed inside the callback that references it.
  "t",
];

/**
 * Identifiers the language itself refuses as a binding name.
 *
 * A workspace may legally hold a table called `new` or a function called
 * `default`, and `toSymbol` only sanitizes *characters* — so the name reached the
 * generated file verbatim and the whole tree failed to parse (`import { …, new }`
 * is a syntax error, not a type error). That took 15 of the workspaces in the
 * sweep from verbose to unusable.
 *
 * Every binding a generated file emits is a module-level `const`, so the strict
 * mode and future-reserved sets apply alongside the plain keywords. These are
 * seeded into the same map as {@link RESERVED_SYMBOLS}, which means a reserved
 * name is disambiguated by the one mechanism that already handles cross-kind
 * collisions rather than by a second, parallel escape.
 */
const RESERVED_WORDS: readonly string[] = [
  // keywords
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for",
  "function", "if", "import", "in", "instanceof", "new", "null", "return",
  "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void",
  "while", "with",
  // strict mode + future reserved
  "implements", "interface", "let", "package", "private", "protected", "public",
  "static", "yield", "await",
  // not reserved, but a binding that shadows them is a footgun in generated code
  "arguments", "eval", "undefined", "NaN", "Infinity",
];

/** The kind slot reserved names occupy, so a real object never matches it. */
const RESERVED_KIND = "\0core";

/** `api_group` → `ApiGroup`. */
function pascal(snake: string): string {
  return snake
    .split("_")
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * The word appended when a symbol needs disambiguating — the object's kind, which
 * reads far better than an ordinal (`newFunction`, not `new_2`).
 *
 * A query takes its HTTP verb too: two queries may share a path and differ only
 * by verb, so the kind alone would not separate them and they would fall through
 * to ordinals that say nothing about which is which.
 */
function kindWord(candidate: Candidate): string {
  const kind = candidate.object.kind;
  if (kind !== "query") return pascal(kind);
  const verb = candidate.stored["verb"];
  return typeof verb === "string" && verb !== ""
    ? `${pascal(verb.toLowerCase())}Query`
    : "Query";
}

/**
 * A symbol as it appears in a PATH — always lower case.
 *
 * Paths and bindings answer to different rules. A binding keeps whatever case
 * the Xano object had, because that is the name a reader recognises; a path is
 * typed, tab-completed, and compared across three filesystems, two of which
 * fold case. Lower-casing every segment means a tree written on macOS and a tree
 * written on Linux are the same tree.
 *
 * Uniqueness is not at risk. `assignSymbols` already separates symbols that
 * differ only by case — it has to, since each one names a file — so two symbols
 * can never fold onto one path segment here.
 *
 * The one thing that stays upper case is a query's HTTP verb, and that is
 * applied after this (see {@link queryFile}): `GET` is not a word, it is the
 * method, and `posts_get.ts` reads as a name where `posts_GET.ts` reads as a
 * route.
 */
function toPathName(symbol: string): string {
  return symbol.toLowerCase();
}

/**
 * An object's name as it appears in its PATH: its own sanitized name, never
 * its disambiguated symbol. A symbol carries a kind word when a name repeats
 * across kinds (`agentsTable`, `favoritesPostQuery`), which is noise in a path
 * — the kind directory already says it. A repeat within one directory is
 * settled there: `disambiguatePaths` for files, {@link DirClaimer} for folders.
 */
function pathNameOf(candidate: Candidate): string {
  return toPathName(toSymbol(String(candidate.stored.name ?? "")));
}

/** Claim a folder name under `parent` for one container, suffixing `_2`, `_3`… on a repeat. */
type DirClaimer = (parent: string, name: string, guid: string) => string;

/** Turn a Xano object name into a valid TypeScript identifier. */
export function toSymbol(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]+/g, "_").replace(/^_+|_+$/g, "");
  const safe = cleaned === "" ? "object" : cleaned;
  return /^[0-9]/.test(safe) ? `_${safe}` : safe;
}

/** The tsconfig a generated tree carries so it resolves `@xano/sdk` alone. */
function tsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2022"],
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        skipLibCheck: true,
        verbatimModuleSyntax: true,
      },
      include: ["."],
    },
    null,
    2,
  )}\n`;
}

/**
 * Relative import specifier from a file in `fromDir` to a generated file.
 *
 * The tree is no longer flat — a query sits two deep, under its api group — so
 * this is a real relative-path walk rather than the same-directory /
 * up-one-then-down pair the one-level layout could get away with. Written by
 * hand against POSIX separators instead of `node:path`, because this module is
 * on the browser-safe decode path and `relative()` would also fold `..` against
 * the real filesystem, which is not what a specifier means.
 */
export function specifierFrom(fromDir: string, toPath: string): string {
  const target = toPath.replace(/\.ts$/, ".js");
  const from = fromDir === "." ? [] : fromDir.split("/");
  const to = target.split("/");
  const file = to.pop()!;

  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1;

  const up = from.length - common;
  const down = to.slice(common);
  // A specifier must be explicitly relative; `up === 0` means the target is at or
  // below this directory, which needs the `./` that a bare path would not carry.
  const prefix = up === 0 ? "./" : "../".repeat(up);
  return `${prefix}${[...down, file].join("/")}`;
}

/**
 * Guids do not always sit in a string by themselves.
 *
 * `f.tableRef` stores its target as a *prefixed* field-method argument —
 * `{name: "@", arg: ["dbo=<guid>"]}` — so scanning for bare guid strings misses
 * the edge entirely. That miss is not cosmetic: the reference still decodes to a
 * symbol, but the graph never learns about it, so declaration ordering does not
 * account for it and the generated file crashes on load with a
 * temporal-dead-zone error. (Found on the first real pulled workspace: a
 * `post_tag` join table declared above the `tag` table it references.)
 *
 * Taking the tail after a `=` covers that form and any future one shaped like
 * it, and costs nothing when the string is a plain guid.
 */
function guidCandidates(value: string): string[] {
  const separator = value.lastIndexOf("=");
  return separator === -1 ? [value] : [value, value.slice(separator + 1)];
}

/**
 * Every guid in `stored` that the index recognises — a superset of the object's
 * real outbound references (see the module header on why a superset is safe).
 */
function referencedGuids(stored: unknown, refs: RefIndex, into: Set<string>): Set<string> {
  if (typeof stored === "string") {
    for (const candidate of guidCandidates(stored)) {
      if (refs.lookup(candidate)) into.add(candidate);
    }
    return into;
  }
  if (Array.isArray(stored)) {
    for (const item of stored) referencedGuids(item, refs, into);
    return into;
  }
  if (stored !== null && typeof stored === "object") {
    for (const value of Object.values(stored)) referencedGuids(value, refs, into);
  }
  return into;
}

/** A decodable object, before a symbol or a file has been chosen for it. */
interface Candidate {
  readonly object: IndexedObject;
  readonly stored: StoredObject;
  readonly dir: string;
  /** Guids this object refers to. */
  readonly edges: ReadonlySet<string>;
}

/** Collect every object the decode registry can handle, in a deterministic order. */
function candidates(refs: RefIndex, payload: Record<string, unknown>): Candidate[] {
  const out: Candidate[] = [];
  for (const decoder of KIND_DECODERS) {
    if (decoder.name === "workspace") continue;
    const section = payload[decoder.payloadKey];
    if (!Array.isArray(section)) continue;
    for (const entry of section) {
      if (entry === null || typeof entry !== "object") continue;
      const stored = entry as StoredObject;
      const object = refs.lookup(typeof stored.guid === "string" ? stored.guid : "");
      // Only objects the index recognised are placed. It already reported the
      // ones it could not identify, so silence here is not silence overall.
      if (!object || object.kind !== decoder.name) continue;
      out.push({
        object,
        stored,
        dir: decoder.dir,
        edges: referencedGuids(stored, refs, new Set()),
      });
    }
  }
  return out;
}

/**
 * Assign each candidate a unique TypeScript symbol.
 *
 * A *cross-kind* collision — a `users` table and a `users` function, both legal
 * in Xano — is disambiguated by kind, which reads far better than an ordinal.
 * A same-kind collision has no such distinguishing word (three functions named
 * `my fn`, `my-fn`, and `my_fn` all sanitize alike), so it falls to ordinals.
 * Both resolve in placement order, so the same bundle always produces the same
 * symbols.
 *
 * Two symbols that differ only by case count as a collision even though they are
 * distinct TypeScript identifiers, because each non-shared symbol also names a
 * file and macOS and Windows fold `Flag.ts` onto `flag.ts`. Left alone, the
 * second object written replaces the first on disk while `index.ts` goes on
 * importing both, so the lost binding resolves to `undefined` and encoding it
 * crashes far from the cause. Reserved names stay case-SENSITIVE: they are
 * imported identifiers rather than files, and a generated `Query` genuinely does
 * not shadow the `query` factory.
 */
function assignSymbols(list: readonly Candidate[]): string[] {
  const used = new Map<string, string>();
  for (const name of [...RESERVED_SYMBOLS, ...RESERVED_WORDS]) used.set(name, RESERVED_KIND);
  const folded = new Map<string, string>();
  return list.map((candidate) => {
    const base = toSymbol(String(candidate.stored.name ?? ""));
    const kind = candidate.object.kind;
    let symbol = base;
    const holder = used.get(symbol) ?? folded.get(symbol.toLowerCase());
    if (holder !== undefined && holder !== kind) symbol = `${base}${kindWord(candidate)}`;
    // Ordinals build on the disambiguated symbol, so a reserved name held by two
    // same-kind objects stays readable (`newFunction`, `newFunction_2`) instead of
    // reverting to a bare `new_2`.
    const disambiguated = symbol;
    for (let n = 2; used.has(symbol) || folded.has(symbol.toLowerCase()); n += 1) {
      symbol = `${disambiguated}_${n}`;
    }
    used.set(symbol, kind);
    folded.set(symbol.toLowerCase(), kind);
    return symbol;
  });
}

/**
 * Choose a file for every candidate, then resolve the symbol/path each guid maps
 * to.
 *
 * One collapse: multiply-referenced objects go in `_shared.ts`, because
 * co-locating them is what keeps the cross-file graph acyclic — an edge inside
 * one file is ordered, not imported, so it can never close a cycle. Tables and
 * containers are exempt (see {@link fileFor}), which makes an edge into or out of
 * them a real import that can close a cycle and cost a degraded `{name, guid}`
 * reference. The corpus says that is currently a non-event, and
 * `npm run codegen:replay` reports the count so it stays one.
 */
function place(refs: RefIndex, payload: Record<string, unknown>): Placement[] {
  const list = candidates(refs, payload);
  const symbols = assignSymbols(list);

  // How many *distinct other objects* refer to each guid. Self-references do not
  // count: an object referring to itself is not a cross-file edge.
  const referrers = new Map<string, number>();
  for (const candidate of list) {
    for (const guid of candidate.edges) {
      if (guid === candidate.object.guid) continue;
      referrers.set(guid, (referrers.get(guid) ?? 0) + 1);
    }
  }

  // Guid → (candidate, symbol), so a child can resolve its parent's directory.
  // A parent's symbol has to be settled before any child's path can be built,
  // and a realtime message is three levels down, so this is a graph walk rather
  // than one pass: `dirs` memoises it and doubles as the recursion guard.
  const byGuid = new Map<string, { candidate: Candidate; symbol: string }>();
  for (const [i, candidate] of list.entries()) {
    byGuid.set(candidate.object.guid, { candidate, symbol: symbols[i]! });
  }
  const dirs = new Map<string, string>();
  // Folder names per parent, first come first served in placement order.
  const claimed = new Set<string>();
  const claimDir: DirClaimer = (parent, name) => {
    let claim = name;
    for (let n = 2; claimed.has(`${parent}/${claim}`); n += 1) claim = `${name}_${n}`;
    claimed.add(`${parent}/${claim}`);
    return claim;
  };
  const resolveDir: DirResolver = (guid) => {
    const found = byGuid.get(guid);
    if (!found) return null;
    const cached = dirs.get(guid);
    if (cached !== undefined) return { dir: cached, kind: found.candidate.object.kind };
    // Claim the slot before recursing. Stored parent links should form a tree,
    // but they are engine data: a cycle would otherwise recurse until the stack
    // gives out, and the kind's own directory is a correct answer either way.
    dirs.set(guid, found.candidate.dir);
    const dir = dirOf(found.candidate, resolveDir, claimDir);
    dirs.set(guid, dir);
    return { dir, kind: found.candidate.object.kind };
  };

  const placements = list.map((candidate, i) => {
    const symbol = symbols[i]!;
    const dir = resolveDir(candidate.object.guid)!.dir;
    return {
      object: candidate.object,
      stored: candidate.stored,
      symbol,
      ...fileFor(candidate, referrers, dir),
    };
  });
  return disambiguatePaths(placements);
}

/** Resolve a guid to where that object's files live, and what kind it is. */
type DirResolver = (guid: string) => { dir: string; kind: string } | null;

/**
 * The paths that legitimately hold more than one object. Everything else is one
 * object per file, and two placements landing on one path would silently merge
 * them — both bindings in one file, with the barrel none the wiser.
 */
const COLLAPSED_FILES: ReadonlySet<string> = new Set([SHARED_FILE, ORPHANED_QUERY_FILE]);

/**
 * Give any two placements that claimed one path a path each.
 *
 * Symbols are globally unique, so an object file cannot collide with another
 * object file. What CAN collide is an object against a container's fixed
 * definition file: a realtime message named `realtime_channel`, or a verbless
 * query named `api_group`, sanitizes to exactly the name its own folder already
 * uses. Rare, but the failure is silent rather than loud, which is the kind
 * worth spending ten lines on.
 */
function disambiguatePaths(placements: readonly Placement[]): Placement[] {
  const taken = new Set<string>();
  return placements.map((placement) => {
    if (COLLAPSED_FILES.has(placement.path)) return placement;
    const folded = placement.path.toLowerCase();
    if (!taken.has(folded)) {
      taken.add(folded);
      return placement;
    }
    const base = placement.path.replace(/\.ts$/, "");
    let path = placement.path;
    for (let n = 2; taken.has(path.toLowerCase()); n += 1) path = `${base}_${n}.ts`;
    taken.add(path.toLowerCase());
    return { ...placement, path };
  });
}

/**
 * The file one candidate lands in, given the directory already resolved for it.
 *
 * Returns only `dir`/`path` overrides — a table and a hoisted object move to a
 * file outside their own directory, so both fields travel together.
 */
function fileFor(
  candidate: Candidate,
  referrers: ReadonlyMap<string, number>,
  dir: string,
): { dir: string; path: string } {
  const kind = candidate.object.kind;

  // A table is exempt from the hoist for the same reason a container is: it is
  // referenced by nearly everything in the workspace, so the hoist would sweep
  // the whole `table/` directory into `_shared.ts` and undo the split. It keeps
  // its own file, named after the table.
  if (kind === "table") return { dir: TABLE_DIR, path: `${TABLE_DIR}/${pathNameOf(candidate)}.ts` };

  // A container is exempt from the hoist, because for it the hoist would be
  // actively wrong rather than merely unnecessary. Containers are referenced by
  // everything they hold — every query names its api group, every channel names
  // its server — so the hoist would catch nearly all of them and empty out the
  // very folders their children are nesting into.
  //
  // Its definition sits beside its directory rather than inside it, so the file
  // IS the directory plus `.ts`, and it lives one level up from what it holds.
  if (CONTAINER_KINDS.has(kind)) {
    return { dir: dir.split("/").slice(0, -1).join("/") || ".", path: `${dir}.ts` };
  }

  // Past here the hoist wins over nesting: a multiply-referenced object is in
  // `_shared.ts` for a cycle reason, which outranks reading nicely.
  if ((referrers.get(candidate.object.guid) ?? 0) > 1) return { dir: ".", path: SHARED_FILE };

  // A query with no resolvable group has no folder to sit in, and there may be
  // many of them, so they share a file rather than scattering.
  if (kind === "query" && dir === QUERY_DIR) return { dir: QUERY_DIR, path: ORPHANED_QUERY_FILE };

  // The verb is the one upper-case thing in any path: an HTTP method, not a
  // word, and what separates two queries sharing a name.
  const verb = kind === "query" ? candidate.stored.verb : undefined;
  const suffix = typeof verb === "string" && verb !== "" ? `_${verb.toUpperCase()}` : "";
  return { dir, path: `${dir}/${pathNameOf(candidate)}${suffix}.ts` };
}

/**
 * The directory a candidate belongs in, resolving its parent chain.
 *
 * Three shapes, all falling back to the kind's own directory when nothing
 * resolves — which is a home, not a failure. There is simply no parent to nest
 * under, and the flat kind directory is where such an object belongs.
 *
 * - A CONTAINER (api group, realtime server, realtime channel) gets a directory
 *   named after itself, inside its own parent's. That is what makes the realtime
 *   hierarchy work: `realtime_server/<server>/<channel>/`.
 * - A CHILD (query, realtime message) sits directly in its parent's directory,
 *   beside the parent's own definition file.
 * - A TRIGGER sits in a `trigger/` subdirectory of whatever it fires on, found
 *   by resolving `obj_id` rather than by switching on the trigger's `obj_type`.
 *   The decoder already works this way — `obj_type: "toolset"` covers both mcp
 *   servers and agents, and only the bound object's kind separates them — so a
 *   static type→directory table would restate that and misfile any type Xano
 *   adds later.
 */
function dirOf(candidate: Candidate, resolveDir: DirResolver, claimDir: DirClaimer): string {
  const kind = candidate.object.kind;

  if (kind === "trigger") {
    const objId = candidate.stored.obj_id;
    const parent = typeof objId === "string" && objId !== "" ? resolveDir(objId) : null;
    return parent === null ? candidate.dir : `${parent.dir}/${TRIGGER_SUBDIR}`;
  }

  const parentDir = parentDirOf(candidate, resolveDir);
  if (CONTAINER_KINDS.has(kind)) {
    const parent = parentDir ?? candidate.dir;
    return `${parent}/${claimDir(parent, pathNameOf(candidate), candidate.object.guid)}`;
  }
  return parentDir ?? candidate.dir;
}

/**
 * The directory of the object a candidate hangs off, or null when it hangs off
 * nothing — no `PARENT_REF` for the kind, an absent or non-guid reference, or a
 * guid that resolves to nothing or to a DIFFERENT kind than the reference is
 * declared to point at. That last check is what stops a stale or reused guid
 * from filing an object under something unrelated.
 */
function parentDirOf(candidate: Candidate, resolveDir: DirResolver): string | null {
  const ref = PARENT_REF[candidate.object.kind];
  if (ref === undefined) return null;
  const id = (candidate.stored[ref.key] as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string" || id === "") return null;
  const parent = resolveDir(id);
  return parent && parent.kind === ref.kind ? parent.dir : null;
}

/**
 * The reference edges that must NOT become imports, keyed `fromPath → guid`.
 *
 * Files form a directed graph once placements are known; a depth-first walk in
 * placement order marks every edge that closes a cycle. Marking the edge that
 * *closes* the cycle (rather than an arbitrary one) means the back edge is
 * chosen deterministically, and exactly one edge per cycle is degraded.
 */
function findBackEdges(placements: readonly Placement[], edges: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const byGuid = new Map(placements.map((p) => [p.object.guid, p]));
  const byPath = new Map<string, Placement[]>();
  for (const placement of placements) {
    const group = byPath.get(placement.path) ?? [];
    group.push(placement);
    byPath.set(placement.path, group);
  }

  const back = new Set<string>();
  const state = new Map<string, "open" | "done">();

  const visit = (path: string): void => {
    state.set(path, "open");
    for (const placement of byPath.get(path) ?? []) {
      for (const guid of edges.get(placement.object.guid) ?? []) {
        const target = byGuid.get(guid);
        if (!target || target.path === path) continue;
        const status = state.get(target.path);
        if (status === "open") {
          back.add(`${path} ${guid}`);
          continue;
        }
        if (status === undefined) visit(target.path);
      }
    }
    state.set(path, "done");
  };

  for (const placement of placements) {
    if (!state.has(placement.path)) visit(placement.path);
  }
  return back;
}

/**
 * Order the placements inside one file so a binding is declared before it is
 * referenced, and report the intra-file edges that cannot be ordered.
 *
 * `const` is not hoisted, so a same-file reference to a binding declared further
 * down is a temporal-dead-zone crash at import — not a type error, and invisible
 * to a round trip that never loads the tree. Dependencies are emitted first
 * (DFS post-order); an edge closing an intra-file cycle is degraded to the same
 * `{name, guid}` literal the cross-file case uses.
 */
function orderWithinFile(
  group: readonly Placement[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): { ordered: Placement[]; back: Set<string> } {
  const byGuid = new Map(group.map((p) => [p.object.guid, p]));
  const ordered: Placement[] = [];
  const back = new Set<string>();
  const state = new Map<string, "open" | "done">();

  const visit = (placement: Placement): void => {
    state.set(placement.object.guid, "open");
    for (const guid of edges.get(placement.object.guid) ?? []) {
      const target = byGuid.get(guid);
      if (!target || target.object.guid === placement.object.guid) continue;
      const status = state.get(guid);
      if (status === "open") {
        back.add(`${placement.object.guid} ${guid}`);
        continue;
      }
      if (status === undefined) visit(target);
    }
    state.set(placement.object.guid, "done");
    ordered.push(placement);
  };

  for (const placement of group) {
    if (!state.has(placement.object.guid)) visit(placement);
  }
  return { ordered, back };
}

/** One generated file, accumulated across every placement that lands in it. */
interface FileState {
  readonly imports: ReturnType<DecodeContext["beginFile"]>;
  readonly body: Stmt[];
  /** Hoisted `{name, guid}` consts, keyed by the guid each one stands for. */
  readonly refs: Map<string, { symbol: string; name: string }>;
}

/**
 * Names the hoisted consts a degraded reference points at, and hands out one per
 * (file, target) pair.
 *
 * A reference that cannot become a symbol — a cycle back edge, or an object
 * referring to itself — still has to say which object it means, and `ObjectRef`
 * accepts `{name, guid}` for exactly that. Inline, though, that literal is 4 lines
 * every time it appears, and the tables that trigger it tend to reference each
 * other from several columns at once: one real workspace spent 24 lines saying
 * "Bugs and issues" six times. Hoisting it to `const Bugs_and_issuesRef = {…}`
 * names the thing once and leaves the reference sites as short as the resolved
 * ones — the same bytes deploy either way, since only the guid is ever read.
 *
 * Names are handed out from a single pool seeded with every object symbol and
 * every reserved word, so a hoisted const can never shadow a binding or an
 * imported factory, in this file or any other.
 */
class RefConstNamer {
  readonly #taken: Set<string>;

  constructor(placements: readonly Placement[]) {
    this.#taken = new Set([
      ...RESERVED_SYMBOLS,
      ...RESERVED_WORDS,
      ...placements.map((placement) => placement.symbol),
    ]);
  }

  /** The const `file` should use for `target`, declaring it on first use. */
  declare(file: FileState, target: Placement): string {
    const existing = file.refs.get(target.object.guid);
    if (existing) return existing.symbol;
    const base = `${target.symbol}Ref`;
    let symbol = base;
    for (let n = 2; this.#taken.has(symbol); n += 1) symbol = `${base}_${n}`;
    this.#taken.add(symbol);
    file.refs.set(target.object.guid, { symbol, name: target.object.name });
    return symbol;
  }
}

/**
 * The hoisted ref consts as statements, at the head of the file body.
 *
 * Hoisted rather than emitted where they were first needed, because the whole
 * point is that the binding they stand in for is NOT declared yet — a ref const
 * next to its use site would hit the same temporal dead zone. They depend on
 * nothing, so the top of the file is always safe.
 */
function refConstStatements(file: FileState): Stmt[] {
  if (file.refs.size === 0) return [];
  const out: Stmt[] = [
    {
      kind: "comment",
      text:
        "References to objects declared below (or in a file that imports this one) — " +
        "a guid names the object, so no import is needed.",
    },
  ];
  for (const [guid, { symbol, name }] of file.refs) {
    out.push({
      kind: "const",
      name: symbol,
      value: {
        kind: "id",
        text: printExpr(
          obj([
            ["name", lit(name)],
            ["guid", lit(guid)],
          ]),
        ),
      },
    });
  }
  out.push({ kind: "blank" });
  return out;
}

/** Decode every object in a bundle payload and assemble the generated tree. */
export function assembleProject(
  ctx: DecodeContext,
  refs: RefIndex,
  payload: Record<string, unknown>,
): GeneratedFile[] {
  const placed = place(refs, payload);
  const edges = new Map(
    placed.map((p) => [p.object.guid, referencedGuids(p.stored, refs, new Set())] as const),
  );
  const backEdges = findBackEdges(placed, edges);

  // Reorder each file's declarations so same-file references resolve, collecting
  // the intra-file edges that had to be degraded along the way. The barrel and
  // the ref map are built from the reordered list so every view agrees.
  const grouped = new Map<string, Placement[]>();
  for (const placement of placed) {
    const group = grouped.get(placement.path) ?? [];
    group.push(placement);
    grouped.set(placement.path, group);
  }
  const placements: Placement[] = [];
  const sameFileBackEdges = new Set<string>();
  for (const group of grouped.values()) {
    const { ordered, back } = orderWithinFile(group, edges);
    placements.push(...ordered);
    for (const edge of back) sameFileBackEdges.add(edge);
  }
  const byGuid = new Map(placements.map((p) => [p.object.guid, p]));

  // Several placements can share one file (`_shared.ts`), so a file's imports and
  // its declarations accumulate across placements and are printed once at the end.
  const files = new Map<string, FileState>();
  const refConsts = new RefConstNamer(placements);

  for (const placement of placements) {
    const decoder = KIND_DECODERS_BY_NAME.get(placement.object.kind)!;
    let file = files.get(placement.path);
    if (!file) {
      file = { imports: ctx.beginFile(), body: [], refs: new Map() };
      files.set(placement.path, file);
    }
    ctx.imports = file.imports;

    // The SDK kind name (`apiGroup:Docs`), never the registry spelling (`api_group`):
    // it is printed to the author, and it is the key `verify` looks files up by.
    const label = `${AUTHOR_KIND_NAME[decoder.name] ?? decoder.name}:${identityName(payload, decoder.payloadKey, placement.stored)}`;
    // Recorded here because this is where the choice is made: a finding is keyed
    // by the object it happened in, but the fix happens in the file that object
    // was written to, and nothing downstream can recover which file that was.
    ctx.report.locate(label, placement.path);

    const { expr, factory } = ctx.inObject(label, () =>
      decodeObject(decoder, {
        ctx,
        refs,
        stored: placement.stored,
        payload,
        resolve: {
          symbolFor: (target) => {
            const found = byGuid.get(target.guid);
            if (!found) return null;
            // Same file: reference the binding directly, no import — unless the
            // declaration order could not put it first, or it is this object.
            if (found.path === placement.path) {
              if (
                found.symbol === placement.symbol ||
                sameFileBackEdges.has(`${placement.object.guid} ${target.guid}`)
              ) {
                return refConsts.declare(file!, found);
              }
              return found.symbol;
            }
            // The cycle escape: importing this would close a cycle, so the
            // reference degrades to a `{name, guid}` literal instead.
            if (backEdges.has(`${placement.path} ${target.guid}`)) {
              return refConsts.declare(file!, found);
            }
            file!.imports.use(specifierFrom(placement.dir, found.path), found.symbol);
            return found.symbol;
          },
        },
      }),
    );

    // Registered AFTER decoding: a per-object kind does not know which of the two
    // symbols it needs until its arguments are built and checked. Imports are
    // accumulated and printed once at the end, so ordering here is free.
    if (factory) file.imports.use(SDK_MODULE, factory);
    else file.imports.useType(SDK_MODULE, decoder.defType);

    if (file.body.length > 0) file.body.push({ kind: "blank" });
    file.body.push(
      {
        kind: "comment",
        text: `${decoder.name} "${placement.object.name}" — generated from a Xano bundle.`,
      },
      {
        kind: "const",
        name: placement.symbol,
        exported: true,
        // The factory both checks the literal and runs its `const` inference, so
        // the generated symbol keeps the column/input/schema types a bare
        // `satisfies` would widen away. Kinds with no factory keep `satisfies`,
        // which still checks the literal without widening it.
        value: {
          kind: "id",
          text: factory
            ? `${factory}(${printExpr(expr)})`
            : `${printExpr(expr)} satisfies ${decoder.defType}`,
        },
      },
    );
  }

  const out: GeneratedFile[] = [];
  // Non-TypeScript files an object contributes — today, the markdown body a
  // knowledge def points at. Emitted relative to the kind's directory, which is
  // also where the def that references them lands, so the relative specifier the
  // decoder wrote resolves.
  for (const placement of placements) {
    const decoder = KIND_DECODERS_BY_NAME.get(placement.object.kind)!;
    for (const companion of decoder.companions?.({ stored: placement.stored, payload }) ?? []) {
      out.push({ path: `${decoder.dir}/${companion.path}`, contents: companion.contents });
    }
  }
  for (const [path, file] of files) {
    const body: Stmt[] = [...refConstStatements(file), ...file.body];
    out.push({
      path,
      contents: printModule([...usedImports(file.imports.toStatements(), printModule(body)), { kind: "blank" }, ...body]),
    });
  }
  // Sorted so the file list itself is deterministic, not merely each file's bytes.
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const settings = workspaceFile(ctx, refs, payload);
  if (settings) out.push({ path: WORKSPACE_FILE, contents: settings.contents });
  out.push({ path: "index.ts", contents: barrel(ctx, payload, placements, settings) });
  out.push({ path: "README.md", contents: readme(ctx, placements) });
  out.push({ path: "tsconfig.json", contents: tsconfig() });
  return out;
}

/**
 * The import block without an SDK value symbol the printed body never names. A
 * decoder records a symbol as it decodes, and a later rewrite can remove the
 * only use — a trigger's `inp("payload.text")` becomes `t.payload("text")` —
 * which left an unused import in the file.
 */
function usedImports(imports: Stmt[], bodyText: string): Stmt[] {
  return imports.flatMap((st) => {
    if (st.kind !== "import" || st.module !== SDK_MODULE || st.typeOnly === true) return [st];
    const symbols = st.symbols.filter((sym) => new RegExp(`(?:(?<=\\.\\.\\.)|(?<![\\w$.]))${sym.replace(/\$/g, "\\$")}(?![\\w$])`).test(bodyText));
    return symbols.length === 0 ? [] : [{ ...st, symbols }];
  });
}

/** The decoded workspace config, as its own file. */
interface WorkspaceFile {
  readonly contents: string;
  /** Binding the barrel imports and passes to `registerWorkspace`. */
  readonly symbol: string;
}

/**
 * Decode the workspace config into `workspace.ts`.
 *
 * Its own file rather than inlined into the barrel's registry chain, which
 * would bury the one object a reader most often wants to find under every other
 * object's registration — and a workspace config is not small: it carries the
 * env var list and the four-host middleware map. Its own file also keeps the
 * barrel purely a registry.
 *
 * Returns null when the payload carries no workspace object, in which case no
 * file is emitted and the barrel registers nothing.
 */
function workspaceFile(
  ctx: DecodeContext,
  refs: RefIndex,
  payload: Record<string, unknown>,
): WorkspaceFile | null {
  // `payload.env` is hoisted out of the workspace object at export time; fold it
  // back in so the workspace decoder sees the shape its encoder produced.
  const stored: StoredObject = {
    ...((payload.workspace ?? {}) as StoredObject),
    ...(Array.isArray(payload.env) && payload.env.length > 0 ? { env: payload.env } : {}),
  };
  if (stored.name === undefined) return null;

  const imports = ctx.beginFile();
  const decoder = KIND_DECODERS_BY_NAME.get("workspace")!;
  const { expr, factory } = ctx.inObject("workspace", () =>
    decodeObject(decoder, { ctx, refs, stored, payload, resolve: {} }),
  );
  if (factory) imports.use(SDK_MODULE, factory);
  else imports.useType(SDK_MODULE, decoder.defType);

  const literal = printExpr(expr);
  return {
    symbol: WORKSPACE_SYMBOL,
    contents: printModule([
      { kind: "comment", text: "Workspace settings — generated from a Xano bundle." },
      ...imports.toStatements(),
      { kind: "blank" },
      {
        kind: "const",
        name: WORKSPACE_SYMBOL,
        exported: true,
        value: {
          kind: "id",
          text: factory ? `${factory}(${literal})` : `${literal} satisfies ${decoder.defType}`,
        } as Expr,
      },
    ]),
  };
}

/**
 * The barrel: registers every decoded object under its `register*` bucket, and
 * re-exports every one of them by name.
 *
 * The re-export is what makes a pulled tree importable as a package rather than
 * only runnable as a whole. Every object is already imported here to be
 * registered, so `import { getUser } from "./xano/index.js"` costs one statement
 * — without it, a caller has to know which of ~40 generated paths a symbol
 * happens to live at, and that path moves whenever the object's parent or its
 * shared-file placement changes.
 *
 * Symbols are globally disambiguated before placement, so this scope cannot
 * collide by construction — the same property that lets the register calls
 * import them all into one file.
 */
function barrel(
  ctx: DecodeContext,
  payload: Record<string, unknown>,
  placements: readonly Placement[],
  settings: WorkspaceFile | null,
): string {
  const imports = ctx.beginFile();
  imports.use(SDK_MODULE, "workspace");

  const workspaceName = String((payload.workspace as StoredObject | undefined)?.name ?? ctx.fallbackWorkspaceName);
  const lines: string[] = [`workspace(${JSON.stringify(workspaceName)})`];

  if (settings) {
    imports.use(specifierFrom(".", WORKSPACE_FILE), settings.symbol);
    lines.push(`  .registerWorkspace(${settings.symbol})`);
  }

  // Only what this file actually imports may be re-exported, so it is collected
  // in the register loop rather than from `placements` — a placement whose kind
  // has no decoder is never imported here, and exporting that name would not
  // compile.
  const exported: string[] = settings ? [settings.symbol] : [];

  const emittedSections = new Set<string>();
  for (const decoder of KIND_DECODERS) {
    if (decoder.name === "workspace") continue;
    // Kinds that share one payload section (an MCP server and an agent are both
    // `toolset` rows) are registered TOGETHER, in section order: one call per
    // run of the same kind. Registering each kind in one call put every MCP
    // server ahead of every agent, so an app that registered its agents first
    // re-exported the section reordered. An app that registered them grouped
    // still gets exactly one call per kind.
    if (emittedSections.has(decoder.payloadKey)) continue;
    emittedSections.add(decoder.payloadKey);
    const sharing = new Map(
      KIND_DECODERS.filter((d) => d.payloadKey === decoder.payloadKey).map((d) => [d.name, d.register]),
    );
    // Register in PAYLOAD order, not placement order. `placements` is grouped by
    // file, so every `_shared.ts` member of a kind would otherwise be registered
    // ahead of the members that got their own file — silently reordering that
    // payload section on re-export. It only ever went unnoticed because the
    // shared member of each kind also happened to come first in its section.
    const members = placements
      .filter((p) => sharing.has(p.object.kind))
      .sort((a, b) => a.object.position - b.object.position);
    if (members.length === 0) continue;
    for (const member of members) {
      imports.use(`./${member.path.replace(/\.ts$/, ".js")}`, member.symbol);
      exported.push(member.symbol);
    }
    // Consecutive members of one kind share a call.
    const runs: Array<{ register: string; symbols: string[] }> = [];
    for (const member of members) {
      const register = sharing.get(member.object.kind)!;
      const last = runs[runs.length - 1];
      if (last !== undefined && last.register === register) last.symbols.push(member.symbol);
      else runs.push({ register, symbols: [member.symbol] });
    }
    for (const run of runs) lines.push(`  .${run.register}([${run.symbols.join(", ")}])`);
  }

  return printModule([
    // Not "disposable": the tree is the project's source from here on, and a
    // header saying otherwise told readers their edits would be thrown away.
    { kind: "comment", text: "Decoded from a Xano bundle. This is your source now: edit it and commit it. See README.md." },
    ...imports.toStatements(),
    { kind: "blank" },
    { kind: "exportDefault", value: { kind: "id", text: lines.join("\n") } as Expr },
    { kind: "blank" },
    {
      kind: "comment",
      text: "Every object in the tree, by name — import from here rather than from its file,\nwhich moves when its parent or its shared-file placement changes.",
    },
    { kind: "exportNamed", symbols: exported },
  ]);
}

/**
 * The generated README.
 *
 * The three warnings are unconditional and deliberately blunt. This tree is a
 * scratch surface: regenerating it destroys hand edits, it carries schema only
 * (no seed rows, no unsupported payload sections), and deploying it runs the
 * server's clear-then-import path — a **full replace** of whatever workspace it
 * lands in. A user who reads only this file must still come away knowing not to
 * point it at a workspace holding data they care about.
 */
/**
 * A decoder's kind as the README lists it: the factory an author calls
 * (`apiGroup`, `workflowTest`), never the decoder's internal name. A kind with no
 * factory of its own (a trigger, the workspace settings) is named in words.
 */
function readmeKindName(decoder: { readonly name: string; readonly factory?: string }): string {
  if (decoder.name === "workspace") return "workspace settings";
  if (decoder.name === "function") return "function";
  return decoder.factory ?? decoder.name;
}

function readme(ctx: DecodeContext, placements: readonly Placement[]): string {
  const counts = new Map<string, number>();
  for (const placement of placements) {
    counts.set(placement.object.kind, (counts.get(placement.object.kind) ?? 0) + 1);
  }

  const lines: string[] = [
    "# Generated Xano SDK workspace",
    "",
    "Decoded from a Xano backend by `xanosdk init --from`, `xanosdk pull` or `xanosdk generate`.",
    "It is your source now: edit it and commit it.",
    "",
    "## Read this before deploying",
    "",
    "- **A refresh overwrites what it decodes.** `xanosdk pull` (or re-running `init --from`)",
    "  lists what will change and asks first, keeps files you added, and overwrites the",
    "  files it decodes — commit before refreshing, so an overwritten edit is in git.",
    "- **`xanosdk deploy` is a full replace** of an ephemeral environment: it clears it and",
    "  re-imports. A real workspace is reached with `xanosdk promote <release>` or",
    "  `xanosdk deploy --to workspace`, which merge and leave table rows alone.",
    "- **This is schema only.** Table rows are not carried, and neither are payload",
    "  sections this SDK models no kind for. A deploy recreates the structure, not the data.",
    "",
    "## What is here",
    "",
  ];
  for (const decoder of KIND_DECODERS) {
    const count = counts.get(decoder.name) ?? 0;
    if (count > 0) lines.push(`- ${count} × ${readmeKindName(decoder)}`);
  }
  lines.push(
    "",
    "Every table has its own file under `table/`. Anything else referenced from more " +
      "than one file lives in `_shared.ts`. A query sits under its API group, and a " +
      "trigger under the object it fires on.",
    "",
    "`index.ts` re-exports all of it by name, so import from the tree's root rather " +
      "than from a file — a path here moves when an object's parent or its `_shared.ts` " +
      "placement changes, and the root does not.",
    "",
  );

  const report = ctx.report.renderMarkdown();
  lines.push(report === "" ? "Everything in the source bundle round-tripped cleanly." : report);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
