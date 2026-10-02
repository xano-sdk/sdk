/**
 * A database filter whose operand SHAPE makes the operator refuse the request,
 * decided from what the bundle already states: a literal's shape and the bound
 * table's column type.
 *
 * Every rule here is one the engine applies to the operands before it builds
 * any SQL, so the clause fails every request that reaches it, whatever the
 * data (HTTP 400 `ParseError: Invalid value for param`, or a 500 for a list
 * given to a pattern operator):
 *
 * - `between` / `not between` — the right side must be a literal list of exactly
 *   two values (a column there is refused too).
 * - `in` / `not in` — one side must be a scalar and the other a list.
 * - `contains` / `not contains` / `overlaps` / `not overlaps` — both sides must
 *   be json or a list.
 *   On a json column they fail for every operand (the database has no
 *   comparison for the list the engine builds), and on a numeric list column an
 *   element that is not a number fails its cast.
 * - `@>` — the left side must be a json column, and the right side json: a
 *   scalar, or a list whose first element is a scalar, is not, and an object
 *   literal fails to evaluate (a bound variable holding one works).
 * - a comparison (`=`, `<`, …) — neither side may be a list.
 * - a pattern or search operator (`like`, `~`, `includes`, `search`, …) — the
 *   right side may not be a list, and `includes` refuses a bool column.
 *
 * Only what is decidable is judged: a left operand that is an undotted column
 * of the statement's own table (a joined or json-path column resolves
 * elsewhere), a right operand that is an unfiltered literal (a filter changes
 * its type, and an input, a variable or an auth read is a runtime value). A
 * clause with `ignoreEmpty` on an empty literal is skipped — the engine drops it
 * before the operator runs.
 *
 * Only `context.search` is read: a runtime condition (`s.if`, a precondition)
 * evaluates its operators in the request, not in SQL, under different rules.
 */
import { sdkKindName } from "../util/sdk-kind.js";
import type { DiagnosticBag } from "./diagnostics.js";

/** A column as the bundle stores it: its type and whether it holds a list. */
interface ColumnShape {
  type: string;
  list: boolean;
}

/** What a literal operand evaluates to, as the operator sees it. */
type LiteralShape =
  | { kind: "scalar" }
  | { kind: "list"; length: number; items: readonly unknown[] }
  | { kind: "object" };

/** Column types that are never json and never a container. */
const SCALAR_COLUMN_TYPES = new Set([
  "int", "decimal", "text", "bool", "epochms", "timestamp", "date", "email", "password", "enum", "uuid",
]);

/** The literal tags whose stored operand is the value itself. */
const SCALAR_TAGS = new Set(["const", "const:encoded", "const:int", "const:decimal", "const:bool", "const:null"]);

/**
 * The text a numeric list column's cast reads, per element type (Postgres input
 * syntax, surrounding whitespace allowed): an int list takes a signed whole
 * number, a decimal list also a fraction (either side of the point may be
 * empty, not both), an exponent, and NaN/Infinity.
 */
const NUMERIC_TEXT: Readonly<Record<string, RegExp>> = {
  int: /^\s*[+-]?\d+\s*$/,
  decimal: /^\s*(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|nan|[+-]?inf(?:inity)?)\s*$/i,
};

/** A whole number (or its text) past the signed 64-bit range an int list's cast reads (measured: SQL 22003). */
function outsideInt64(v: unknown): boolean {
  const text = typeof v === "number" && Number.isInteger(v) ? BigInt(v).toString() : typeof v === "string" ? v.trim() : undefined;
  if (text === undefined || !/^[+-]?\d+$/.test(text)) return false;
  const n = BigInt(text);
  return n > 2n ** 63n - 1n || n < -(2n ** 63n);
}

function isScalar(v: unknown): boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

const COMPARISON_OPS = new Set(["=", "==", "!=", "===", "!==", "<", "<=", ">", ">="]);
const PATTERN_OPS = new Set(["like", "not like", "ilike", "not ilike", "~", "!~", "includes", "not includes", "search"]);
const CONTAINMENT_OPS = new Set(["contains", "not contains", "overlaps", "not overlaps"]);

interface Operand {
  tag?: unknown;
  operand?: unknown;
  filters?: unknown;
  ignore_empty?: unknown;
}

function unfiltered(o: Operand): boolean {
  return !Array.isArray(o.filters) || o.filters.length === 0;
}

/** The shape of an unfiltered literal operand, or undefined when it is not one (or not decidable). */
function literalShape(o: Operand): LiteralShape | undefined {
  if (typeof o.tag !== "string" || !unfiltered(o)) return undefined;
  const text = typeof o.operand === "string" ? o.operand : undefined;
  // A leading `(` is the engine's inline filter form, evaluated rather than read.
  if (text?.startsWith("(")) return undefined;
  if (SCALAR_TAGS.has(o.tag)) return { kind: "scalar" };
  if (o.tag !== "const:array" && o.tag !== "const:obj") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text ?? "");
  } catch {
    return undefined;
  }
  if (Array.isArray(value)) return { kind: "list", length: value.length, items: value };
  if (!value || typeof value !== "object") return undefined;
  const keys = Object.keys(value);
  // An object keyed `0..n-1` (or empty) is evaluated as a list.
  if (keys.every((k, i) => k === String(i))) return undefined;
  return { kind: "object" };
}

/**
 * Whether the operand is an object literal as `c.obj({ … })` compiles it — an
 * empty object built up key by key with `set` — which `@>` cannot evaluate.
 */
function objectLiteral(o: Operand): boolean {
  return (
    o.tag === "const:obj" &&
    o.operand === "{}" &&
    Array.isArray(o.filters) &&
    o.filters.length > 0 &&
    o.filters.every((x) => (x as { name?: unknown } | null)?.name === "set")
  );
}

/** Whether the engine reads this literal as empty — the case `ignoreEmpty` removes. */
function emptyLiteral(o: Operand): boolean {
  if (o.tag === "const:null") return true;
  return typeof o.operand !== "string" || ["", "0", "[]", "{}", "false", "null"].includes(o.operand);
}

function tableShapes(sections: Readonly<Record<string, unknown[] | undefined>>): Map<string, Map<string, ColumnShape>> {
  const out = new Map<string, Map<string, ColumnShape>>();
  for (const raw of sections.dbo ?? []) {
    const t = raw as { guid?: unknown; schema?: unknown } | null;
    if (typeof t?.guid !== "string" || !Array.isArray(t.schema)) continue;
    const cols = new Map<string, ColumnShape>();
    for (const c of t.schema as Array<{ name?: unknown; type?: unknown; style?: { type?: unknown } }>) {
      if (typeof c?.name !== "string" || typeof c.type !== "string") continue;
      cols.set(c.name, { type: c.type, list: c.style?.type === "list" });
    }
    out.set(t.guid, cols);
  }
  return out;
}

function describeColumn(name: string, c: ColumnShape): string {
  return `\`${name}\` (${c.type}${c.list ? " list" : ""})`;
}

function describeLiteral(s: LiteralShape): string {
  if (s.kind === "list") return `a ${s.length}-element list`;
  return s.kind === "object" ? "an object" : "a scalar";
}

/** Why this comparison fails every request, or undefined when it may not. */
function problem(op: string, left: Operand, right: Operand, columns: Map<string, ColumnShape> | undefined): string | undefined {
  if (right.ignore_empty === true && emptyLiteral(right)) return undefined;
  const lit = literalShape(right);
  const leftName = left.tag === "col" && typeof left.operand === "string" && unfiltered(left) ? left.operand : undefined;
  const column = leftName !== undefined && !leftName.includes(".") ? columns?.get(leftName) : undefined;

  if (op === "between" || op === "not between") {
    if (left.tag !== "col") return undefined;
    if (right.tag === "col") return `\`${op}\` takes a literal two-value list on the right, not a column`;
    if (lit && !(lit.kind === "list" && lit.length === 2)) {
      return `\`${op}\` needs exactly a two-value list (\`c.array([low, high])\`) on the right; it has ${describeLiteral(lit)}`;
    }
    return undefined;
  }
  if (!column) return undefined;
  const col = describeColumn(leftName!, column);
  // The left-side rules read the column alone, whatever the right side is.
  if (CONTAINMENT_OPS.has(op) && !column.list && SCALAR_COLUMN_TYPES.has(column.type)) {
    return `\`${op}\` is json/list containment and ${col} is neither — for a substring match use \`includes\``;
  }
  if (CONTAINMENT_OPS.has(op) && column.type === "json" && !column.list && right.tag !== "col") {
    return (
      `\`${op}\` on a json column has no working operand: the database cannot compare ${col} with the list ` +
      `it builds, whatever the value. Store the values in a list column (\`f.text({ array: true })\`), where ` +
      `\`${op}\` works, or match a json array of objects with \`@>\` (\`c.array([{ … }])\`)`
    );
  }
  if (op === "@>" && SCALAR_COLUMN_TYPES.has(column.type)) {
    return `\`@>\` needs a json column on the left, and ${col} is not one`;
  }
  if (op === "@>" && !column.list && objectLiteral(right)) {
    return (
      `\`@>\` with an object literal on the right fails with "Invalid expression" — bind the object first ` +
      `(\`s.set_var("match", c.obj({ … }))\`, then \`ref("match")\`) or take it as a json input; a json array of ` +
      `objects matches with \`c.array([{ … }])\``
    );
  }
  if ((op === "includes" || op === "not includes") && column.type === "bool") {
    return `\`${op}\` does not take a bool column (${col})`;
  }
  if (!lit) return undefined;
  if (op === "in" || op === "not in") {
    if (!column.list && lit.kind !== "list") return `\`${op}\` on ${col} needs a list on the right; it has ${describeLiteral(lit)}`;
    if (column.list && lit.kind === "list") return `\`${op}\` needs a scalar on one side, and ${col} and the right side are both lists`;
    return undefined;
  }
  if (op === "@>" && column.type === "json") {
    if (lit.kind === "scalar" || (lit.kind === "list" && isScalar(lit.items[0]))) {
      return (
        `\`@>\` needs a json value on the right, and a ${lit.kind === "scalar" ? "scalar" : "list of scalars"} is not ` +
        `one — the engine reads a list by its first element. A list of objects works (\`c.array([{ … }])\`); ` +
        `matching scalar elements needs a list column (\`f.text({ array: true })\`) with \`contains\``
      );
    }
    return undefined;
  }
  const numeric = NUMERIC_TEXT[column.type];
  if (CONTAINMENT_OPS.has(op) && column.list && numeric !== undefined && lit.kind === "list") {
    const bad = lit.items.find((v) => typeof v === "string" && !numeric.test(v));
    if (bad !== undefined) {
      return `\`${op}\` on ${col} casts every element to ${column.type === "int" ? "a whole number" : "a number"}, and ${JSON.stringify(bad)} is not one`;
    }
    const big = column.type === "int" ? lit.items.find(outsideInt64) : undefined;
    if (big !== undefined) {
      return `\`${op}\` on ${col} casts every element to a 64-bit whole number, and ${JSON.stringify(big)} is out of its range`;
    }
  }
  if (CONTAINMENT_OPS.has(op)) {
    if (lit.kind === "scalar") return `\`${op}\` needs json or a list on the right; it has a scalar — wrap it: \`c.array([value])\``;
    return undefined;
  }
  if (COMPARISON_OPS.has(op)) {
    if (lit.kind === "list") return `\`${op}\` does not compare lists; the right side is ${describeLiteral(lit)} — use \`in\``;
    if (column.list && right.tag !== "const:null") return `\`${op}\` does not compare lists, and ${col} is one`;
    return undefined;
  }
  if (PATTERN_OPS.has(op)) {
    if (lit.kind === "list") return `\`${op}\` does not take a list on the right; it has ${describeLiteral(lit)}`;
  }
  return undefined;
}

function walk(node: unknown, visit: (record: Record<string, unknown>) => void): void {
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const n = stack.pop();
    if (Array.isArray(n)) {
      for (let i = n.length - 1; i >= 0; i--) stack.push(n[i]);
    } else if (n && typeof n === "object") {
      const record = n as Record<string, unknown>;
      visit(record);
      const values = Object.values(record);
      for (let i = values.length - 1; i >= 0; i--) stack.push(values[i]);
    }
  }
}

export function checkFilterOperands(
  sections: Readonly<Record<string, unknown[] | undefined>>,
  bag: DiagnosticBag,
): void {
  const tables = tableShapes(sections);
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      const found: string[] = [];
      walk(obj, (record) => {
        const context = record.context as { search?: unknown; dbo?: { id?: unknown } } | undefined;
        if (!context || typeof context.search !== "object" || context.search === null) return;
        const id = context.dbo?.id;
        const columns = typeof id === "string" ? tables.get(id) : undefined;
        walk(context.search, (node) => {
          const s = node.statement as { op?: unknown; left?: unknown; right?: unknown } | undefined;
          if (!s || typeof s !== "object" || typeof s.op !== "string") return;
          const why = problem(s.op, (s.left ?? {}) as Operand, (s.right ?? {}) as Operand, columns);
          if (why !== undefined) found.push(why);
        });
      });
      if (found.length === 0) continue;
      const name = (obj as { name?: unknown }).name;
      const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
      for (const why of [...new Set(found)]) {
        bag.warn(
          "db.filter-operand-invalid",
          `${owner}: a \`where\` clause fails every request that reaches it, whatever the data — ${why}.`,
          obj,
        );
      }
    }
  }
}
