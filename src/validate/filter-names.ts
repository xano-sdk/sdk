/**
 * Offline filter-name validation.
 *
 * The typed `fl.*` surface only exposes runtime-resolvable filters, but the raw
 * `filter(name, …)` escape hatch accepts any string. A name the engine can't
 * resolve type-checks and exports clean, then 500s on the first live request with
 * `Unable to locate func entry: <name>`. This walks a compiled bundle, collects
 * every `filters[].name`, and flags any that is not in the resolvable catalog —
 * turning a runtime 500 into an export-time warning (or a `--strict` failure).
 *
 * Browser-safe: no node imports; the allowlist is the generated `FILTER_NAMES`.
 */
import { FILTER_NAMES } from "../values/generated/filters.generated.js";
import { isQueryExpressionFilter } from "../values/query-filters.js";

/** One unresolvable filter usage found in a bundle. */
export interface FilterNameFinding {
  /** The offending filter name. */
  name: string;
  /** Best-effort owning object (nearest named ancestor), for an actionable message. */
  location: string;
  /** Closest resolvable name(s), when one is an obvious fix (`to_upper` → `upper`). */
  suggestions: string[];
  /** Set when a sighting sits in an EXPRESSION string (`obj()` member, `c.expression`), not a `filters[]` entry. */
  inExpression?: true;
}

const RESOLVABLE = new Set<string>(FILTER_NAMES);

/**
 * Keys whose subtree is a db-query EXPRESSION — evaluated in SQL, not in the
 * request — so a filter under one of them resolves against the query-expression
 * registry as well as the runtime catalog (see `values/query-filters.ts`).
 *
 * Without this every vector-distance, geo, and `search_rank` usage was reported
 * as "will 500 at runtime" while working perfectly. The flag is
 * sticky: an operand nested three levels inside `search` is still in SQL.
 */
const QUERY_EXPRESSION_KEYS = new Set(["eval", "search", "sort", "aggregate"]);

/** Levenshtein distance, single-row DP — only used to rank a short suggestion list. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/**
 * Up to two likely-intended resolvable names for an unresolvable one. Prefers a
 * substring relationship (`to_upper` contains `upper`) then small edit distance,
 * so the common rename/prefix footguns get a precise "did you mean".
 */
export function suggestFilterNames(name: string): string[] {
  // Affix rename: one name is the other minus a short prefix/suffix — the exact
  // shape of the real footguns (`to_upper`→`upper`, `keys`→`array_keys`). Bound
  // the affix to 6 chars so an unrelated name that merely ends in a filter word
  // (`..._a_filter`) doesn't spuriously match.
  const AFFIX_MAX = 6;
  const affix = (long: string, short: string): boolean =>
    (long.startsWith(short) || long.endsWith(short)) && long.length - short.length <= AFFIX_MAX;
  const substr = FILTER_NAMES.filter((r) =>
    name.length >= r.length ? affix(name, r) : affix(r, name),
  ).sort((a, b) => Math.abs(a.length - name.length) - Math.abs(b.length - name.length));
  if (substr.length) return substr.slice(0, 2);
  // Edit distance has to be read RELATIVE to the name's length. Two edits in a
  // four-character name is half the word — `null` → `mul` scores 2 and is not a
  // typo of anything, but it was suggested as one, and applying it would replace
  // a null-producing filter with multiplication. A wrong suggestion
  // is worse than none: it converts "I don't recognize this" into a confident
  // instruction to change behaviour.
  //
  // One edit always reads as a typo. Two only in a name long enough for two
  // characters to be a small share of it.
  const near = (d: number): boolean => d === 1 || (d === 2 && name.length >= 6);
  return FILTER_NAMES.map((r) => ({ r, d: editDistance(name, r) }))
    .filter((x) => near(x.d))
    .sort((a, b) => a.d - b.d)
    .slice(0, 2)
    .map((x) => x.r);
}

/** How a payload section's objects are named in a finding (`dbo` holds tables). */
const SECTION_KIND: Readonly<Record<string, string>> = {
  dbo: "table",
  app: "api group",
  toolset: "toolset",
  realtime_server: "realtime server",
  channel: "realtime channel",
  message: "realtime message",
  workflow_test: "workflow test",
};

/**
 * The stack key a branch's `run` array sits under, spelled as the author wrote
 * it: `s.conditional`'s `then`/`else` are stored as `if`/`else`, so without this
 * both branches of one conditional read `stack[0].stack[0]`.
 */
const BRANCH_LABEL: Readonly<Record<string, string>> = {
  if: "then",
  else: "else",
  elif: "elif",
};

/**
 * Statements that reuse those stored keys for differently named arms: a
 * `try_catch` stores try/catch/finally as `if`/`else`/`then`, and a `switch`
 * stores its cases under `elif` and its default under `else`. Keyed by the
 * statement that OWNS the `context`, so the label is the author's word.
 */
const STATEMENT_BRANCH_LABEL: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "mvp:try_catch": { if: "try", else: "catch", then: "finally" },
  "mvp:switch": { elif: "cases", else: "default" },
  "mvp:switch_case": { if: "body" },
};

/**
 * The filter names an EXPRESSION string pipes through — `obj()` (and
 * `c.expression`) store their members as one `const:expr2` source string, so a
 * filter inside `obj({ k: withFilters(v, filter("to_upper")) })` is `"x"|to_upper`
 * there, not a `filters[]` entry the structured walk can see.
 *
 * Read the way the expression grammar reads it: string literals are skipped
 * whole (a `|` inside one is text), `||` is logical OR, and a single `|` is
 * followed by the filter's name.
 */
export function expressionFilterNames(source: string): string[] {
  const names: string[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'") {
      for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === "\\") i++;
      continue;
    }
    if (ch !== "|") continue;
    if (source[i + 1] === "|") {
      i++;
      continue;
    }
    const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(i + 1));
    if (name) names.push(name[1]!);
  }
  return names;
}

/**
 * Walk any compiled-bundle value and collect every unresolvable `filters[].name`.
 * Generic over the bundle shape: recurses all objects/arrays, and wherever a
 * `filters` array holds `{name}` entries, checks each name. A finding names the
 * payload object that owns it by kind and name, and the place in it —
 * `query "b" at response.f`, `function "f" at stack[2].stack[0]` — rather than
 * the nearest `name` key, which was often a response member (`(in f)`).
 */
export function findUnresolvableFilters(bundle: unknown): FilterNameFinding[] {
  const findings: FilterNameFinding[] = [];
  const seen = new Map<string, { finding: FilterNameFinding; paths: string[] }>();

  const walk = (node: unknown, owner: string, path: string, inQuery = false, parentKey = "", stmt = ""): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, owner, path, inQuery, parentKey, stmt);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    // The statement whose `context` this walk is inside: its arms are named by
    // statement, not by the stored key alone.
    const own = typeof obj.name === "string" && "context" in obj ? obj.name : parentKey === "context" ? stmt : "";

    // Filters named inside an expression string (an `obj()` member, a
    // `c.expression`) are checked as if they were structured entries.
    const embedded =
      obj.tag === "const:expr2" && typeof obj.value === "string"
        ? expressionFilterNames(obj.value).map((name) => ({ name, expr: true }))
        : [];
    const filters = Array.isArray(obj.filters) ? [...(obj.filters as unknown[]), ...embedded] : embedded;
    if (filters.length > 0) {
      for (const f of filters) {
        const fname = (f as { name?: unknown })?.name;
        const resolvable =
          typeof fname === "string" &&
          (RESOLVABLE.has(fname) || (inQuery && isQueryExpressionFilter(fname)));
        if (typeof fname === "string" && fname !== "" && !resolvable) {
          // One finding per name per owner, listing every place it sits.
          const key = `${fname}@${owner}`;
          let found = seen.get(key);
          if (found === undefined) {
            found = { finding: { name: fname, location: owner || "(unknown)", suggestions: suggestFilterNames(fname) }, paths: [] };
            seen.set(key, found);
            findings.push(found.finding);
          }
          if ((f as { expr?: true }).expr) found.finding.inExpression = true;
          if (path !== "" && !found.paths.includes(path)) {
            found.paths.push(path);
            found.finding.location = `${owner || "(unknown)"} at ${found.paths.join(", ")}`;
          }
        }
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      const query = inQuery || QUERY_EXPRESSION_KEYS.has(key);
      // A stack (`run`) at any depth, and the owner's own response and inputs,
      // are the places an author can find again; every other key is envelope.
      if (Array.isArray(value) && (key === "run" || (path === "" && (key === "result" || key === "input")))) {
        value.forEach((item, i) => {
          const name = (item as { name?: unknown } | null)?.name;
          const at =
            key === "run"
              ? `${STATEMENT_BRANCH_LABEL[stmt]?.[parentKey] ?? BRANCH_LABEL[parentKey] ?? "stack"}[${i}]`
              : `${key === "result" ? "response" : "input"}${typeof name === "string" && name !== "" ? `.${name}` : `[${i}]`}`;
          walk(item, owner, path ? `${path}.${at}` : at, query);
        });
      } else walk(value, owner, path, query, key, own);
    }
  };

  const payload = (bundle as { payload?: unknown } | null)?.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    walk(bundle, "", "");
    return findings;
  }
  for (const [section, entries] of Object.entries(payload)) {
    const kind = SECTION_KIND[section] ?? section;
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      const name = (entry as { name?: unknown } | null)?.name;
      walk(entry, typeof name === "string" && name !== "" ? `${kind} "${name}"` : kind, "");
    }
  }
  return findings;
}
