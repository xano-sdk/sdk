/**
 * A dotted `ref("row.col")` into a binding that is `null` when no row matched.
 *
 * `s.db.get` (and `s.db.query` with `returnType: "single"`) binds `null` on a
 * miss, and the engine's var path lookup does not treat a null base as a null
 * result: it raises `Unable to locate var: row.col` (ERROR_FATAL, HTTP 500) and
 * the whole request fails. Only the null-safe spelling,
 * `ref(path, { safe: true })` — the base var plus a `get` filter — yields
 * `null`. So a drill nothing has narrowed deploys clean, passes every test that
 * uses an id that exists, and 500s on the first unknown id.
 *
 * Read in source order, flat rather than scoped, and generous about what counts
 * as narrowing — a warning that cries wolf is a warning people learn to skip:
 *  - a precondition (`guard.found`, `guard.owner`, a hand-written one) whose
 *    condition reads the base in any form narrows everything after it;
 *  - an `s.conditional` whose condition reads the base narrows its branches,
 *    and everything after it when a branch can end the request (a throw, a
 *    return, a precondition);
 *  - a condition that reads the bare base alongside a drill (`row != null &&
 *    row.x == …`) is not reported for that drill;
 *  - re-binding the name with anything else (or updating it in place) ends it.
 * A disabled statement does not run, so it neither reads, binds nor narrows.
 */
import { sdkKindName } from "../util/sdk-kind.js";
import { statementLabel } from "../statements/statement.js";
import type { DiagnosticBag } from "./diagnostics.js";

const DB_GET = "mvp:dbo_getby";
const DB_QUERY = "mvp:dbo_view";
const PRECONDITION = "mvp:precondition";
const CONDITIONAL = "mvp:conditional";
/** Statements that can end the request from inside a branch. */
const TERMINAL: ReadonlySet<string> = new Set(["mvp:throw_error", "mvp:return", PRECONDITION]);

type Rec = Record<string, unknown>;

function isStatement(node: unknown): node is Rec & { name: string } {
  return !!node && typeof node === "object" && !Array.isArray(node) &&
    typeof (node as Rec).name === "string" && ((node as Rec).name as string).startsWith("mvp:");
}

/** The statement that binds a row-or-null, labelled as the author wrote it. */
function maybeNullSource(st: Rec & { name: string }): string | undefined {
  if (st.name === DB_GET) return "`s.db.get`";
  if (st.name === DB_QUERY) {
    const type = (st.context as { return?: { type?: unknown } } | undefined)?.return?.type;
    if (type === "single") return '`s.db.query` with `returnType: "single"`';
  }
  return undefined;
}

/** A var read: its full path, and whether the base appears without a dot. */
interface Read {
  readonly path: string;
}

const EXPR_VAR = /\$var\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;

/**
 * Every var read under `root`, NOT descending into nested statements (they are
 * walked in their own turn) or into `mocks` (a canned value, not a read).
 */
function ownReads(root: unknown, out: Read[], children?: Rec[]): void {
  const stack: unknown[] = [root];
  let first = true;
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const record = node as Rec;
    if (!first && isStatement(record)) {
      children?.push(record);
      continue;
    }
    first = false;
    if (record.tag === "var") {
      for (const path of [record.value, record.operand]) if (typeof path === "string") out.push({ path });
    } else if (record.tag === "const:expr2") {
      for (const text of [record.value, record.operand]) {
        if (typeof text !== "string" || !text.includes("$var.")) continue;
        const code = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
        for (const m of code.matchAll(EXPR_VAR)) out.push({ path: m[1]! });
      }
    }
    const entries = Object.entries(record).filter(([key]) => key !== "mocks");
    for (let i = entries.length - 1; i >= 0; i--) stack.push(entries[i]![1]);
  }
}

function baseOf(path: string): string {
  const dot = path.indexOf(".");
  return dot === -1 ? path : path.slice(0, dot);
}

/** Does a branch of this statement (at any depth) contain one that can end the request? */
function hasTerminal(children: readonly Rec[]): boolean {
  const stack: unknown[] = [...children];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const record = node as Rec;
    if (isStatement(record)) {
      if (record.disabled === true) continue;
      if (TERMINAL.has(record.name)) return true;
    }
    stack.push(...Object.values(record));
  }
  return false;
}

interface Finding {
  readonly base: string;
  readonly path: string;
  readonly source: string;
  readonly where: string;
}

class Walk {
  /** Bases currently bound to a row-or-null nothing has narrowed, by their binding statement. */
  readonly maybeNull = new Map<string, string>();
  readonly findings: Finding[] = [];

  private report(reads: readonly Read[], where: string, exempt: ReadonlySet<string> = new Set()): void {
    for (const { path } of reads) {
      if (!path.includes(".")) continue;
      const base = baseOf(path);
      const source = this.maybeNull.get(base);
      if (source === undefined || exempt.has(base)) continue;
      this.findings.push({ base, path, source, where });
    }
  }

  statements(list: readonly unknown[]): void {
    for (const node of list) if (isStatement(node)) this.statement(node);
  }

  private statement(st: Rec & { name: string }): void {
    if (st.disabled === true) return;
    const reads: Read[] = [];
    const children: Rec[] = [];
    ownReads(st, reads, children);
    const readBases = new Set(reads.map((r) => baseOf(r.path)));
    const isCondition = st.name === PRECONDITION || st.name === CONDITIONAL;
    // A condition that also reads the bare base is testing it: `row != null && row.x`.
    const tested = isCondition
      ? new Set(reads.filter((r) => !r.path.includes(".")).map((r) => r.path))
      : undefined;
    this.report(reads, `\`${statementLabel(st.name)}\``, tested);

    // What the statement binds is visible to its body (a loop item) and after it.
    const as = typeof st.as === "string" ? st.as : "";
    if (as !== "") {
      const source = maybeNullSource(st);
      if (source !== undefined) this.maybeNull.set(as, source);
      else this.maybeNull.delete(as);
    }
    const context = st.context as { as?: unknown; name?: unknown } | undefined;
    for (const name of [context?.as, context?.name]) {
      if (typeof name === "string" && name !== "") this.maybeNull.delete(baseOf(name));
    }

    if (st.name === PRECONDITION) {
      for (const base of readBases) this.maybeNull.delete(base);
    }
    if (st.name === CONDITIONAL) {
      const narrowed = [...readBases].filter((base) => this.maybeNull.has(base));
      const saved = new Map(narrowed.map((base) => [base, this.maybeNull.get(base)!] as const));
      for (const base of narrowed) this.maybeNull.delete(base);
      this.statements(children);
      // No branch ends the request: past the conditional the row may still be null.
      if (!hasTerminal(children)) {
        for (const [base, source] of saved) if (!this.maybeNull.has(base)) this.maybeNull.set(base, source);
      }
      return;
    }
    this.statements(children);
  }

  response(result: unknown): void {
    const reads: Read[] = [];
    ownReads({ result }, reads);
    this.report(reads, "the response");
  }
}

/**
 * Warn `stack.drill-maybe-null` once per (object, base): an unnarrowed dotted
 * read into a `db.get` / single `db.query` binding.
 */
export function checkDrillMaybeNull(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const record = obj as Rec;
      if (!Array.isArray(record.run)) continue;
      const walk = new Walk();
      walk.statements(record.run);
      if ("result" in record) walk.response(record.result);
      if (walk.findings.length === 0) continue;
      const name = record.name;
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
      const reported = new Set<string>();
      for (const { base, path, source, where } of walk.findings) {
        if (reported.has(base)) continue;
        reported.add(base);
        bag.warn(
          "stack.drill-maybe-null",
          `${owner}: \`ref("${path}")\` in ${where} drills into \`${base}\`, which ${source} binds to ` +
            `\`null\` when no row matches, and nothing before it checks that. On a miss the engine does ` +
            `not serve null: it raises \`Unable to locate var: ${path}\` (HTTP 500). Either guard ` +
            `existence first — \`guard.found("${base}")\` before the drill answers a proper 404 — or ` +
            `drill null-safe with \`ref("${path}", { safe: true })\` to serve \`null\`.`,
          obj,
        );
      }
    }
  }
}
