/**
 * `@xano/sdk/bundle` — the primitives for READING a compiled bundle.
 *
 * The authoring surface (`.`) writes a bundle; this entry reads one back. It is
 * for tools that take compiled JSON as input — a graph view, a diff, a linter, a
 * docs generator, a migration script — and it exists because every one of those
 * otherwise reimplements the same few hundred lines of bundle knowledge, then
 * goes silently wrong the day the engine grows a shape the copy did not know
 * about.
 *
 * Unlike `@xano/sdk/internal`, this is a SUPPORTED surface. It has no opinions
 * in it: no rendering, no rules, no policy about what a bundle should contain.
 * Five questions, answered once:
 *
 * - `statementCatalog()` — what is this `mvp:` name, in authoring terms?
 * - `subStacks()` / `walk()` — what nests under this statement, and where is it?
 * - `statementPath()` — what do we all agree to CALL that node?
 * - `structuralHash()` — did this statement change, ignoring engine-filled noise?
 * - `tableRefOf()` / `linkedTableOf()` — what table does this column point at?
 *
 * ```ts
 * import { walk, statementCatalog, structuralHash } from "@xano/sdk/bundle";
 *
 * const catalog = statementCatalog();
 * for (const { raw, path, depth } of walk(query.stack)) {
 *   const entry = catalog.get(raw.name);
 *   console.log(`${"  ".repeat(depth)}${path}  ${entry?.sPath ?? raw.name}`);
 * }
 * ```
 *
 * Everything here is pure and dependency-free — no filesystem, no network, no
 * Node built-ins — so it runs in a browser, a worker, or an edge function.
 */

export { statementCatalog } from "./bundle/catalog.js";
export type { StatementCatalogEntry } from "./bundle/catalog.js";

export { SUB_STACK_KEYS, statementPath, subStacks, walk } from "./bundle/walk.js";
export type { SubStack, WalkedStatement } from "./bundle/walk.js";

export { canonicalJson, structuralHash } from "./bundle/hash.js";

export { linkedTableOf, tableRefOf } from "./bundle/schema.js";

/**
 * The normalizer the SDK itself compares with — the fixture corpus and the
 * `xanosdk preflight` round-trip diff both run stored bytes through it before
 * comparing. Published because a tool that diffs a stored bundle against a
 * compiled one has exactly that problem, and solving it a second time by hand
 * produces a different answer.
 *
 * `deepEqual` is its companion: compare two ALREADY-normalized values.
 */
export { deepEqual, normalize } from "./validate/normalize.js";

/**
 * The stored shapes, so a reader can type what it walks. These are also on the
 * root entry — re-exported here so a bundle-analysis tool needs one import.
 */
export type {
  ConditionalContext,
  ConditionalElifContext,
  ExprGroup,
  ExprNode,
  ExprOperand,
  ExprStatement,
  FieldXdo,
  FilterXdo,
  InputXdo,
  MethodXdo,
  ResultItemXdo,
  StackItemXdo,
  StatementInputXdo,
  TaggedValue,
} from "./types/xdo.js";
