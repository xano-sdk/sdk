/**
 * Database-family decoders — the `!map:dbo` ops, the bulk writes, raw SQL, the
 * transaction block, and `db.query`.
 *
 * Almost the whole family shares one stored skeleton: the target table under
 * `context.dbo.id`, an optional `as`, and the operation's arguments as `input[]`
 * entries. That regularity is what {@link dboOp} exploits — one table-driven
 * decoder covers eleven statements, in the same spirit as `calls.ts`.
 *
 * `db.query` (`mvp:dbo_view`) is the exception and is written out longhand: its
 * arguments are spread across `context.search` (a boolean-expression tree),
 * `context.return` (five differently-shaped return blocks, each with its own
 * sort/paging/distinct sub-schema), `context.bind`, `context.eval`,
 * `context.external` / `context.simpleExternal`, *and* the statement's own
 * output/addon envelope. Every one of those is optional and most carry engine
 * defaults that must be elided to keep the generated call readable.
 *
 * As everywhere in codegen, each decoder is proof-carrying: it builds candidate
 * authoring args, calls the real `s.db.*` factory, and emits source only when the
 * re-encoded statement matches the stored one. Where a default is elided here,
 * that elision is verified rather than assumed.
 */
import type { StackItemXdo, TaggedValue } from "../../types/xdo.js";
import { configuredDeadReturnBlocks, isDefaultEnvelopeMember, normalize } from "../../validate/normalize.js";
import { encodeStatement } from "../../statements/statement.js";
import { deepEqual } from "../field.js";
import { outputPaths, PAGING_ENVELOPE_ROOTS } from "../../statements/special/output-select.js";
import { dbAdd, dbAddOrEdit as dbAddOrEditStatement, dbEdit, searchConstrainsRows } from "../../statements/special/db.js";
import { arr, id, lit, obj, type Expr } from "../print.js";
import { isBoundNumericId, isReferenceId, isUnboundId, resolveReference } from "../ref-index.js";
import { decodeValue, describeStored } from "../value.js";
import { decodeCondition } from "../expression.js";
import {
  blankRefDetail,
  declineHere,
  getPath,
  prove,
  type SpecialArgs,
  type SpecialDecoder,
} from "./prove.js";

/** Coerce a stored `{value, tag, filters}` block to a tagged value. */
function toValue(raw: unknown): TaggedValue | null {
  if (raw === null || typeof raw !== "object") return null;
  const block = raw as { value?: unknown; tag?: unknown; filters?: unknown };
  if (typeof block.tag !== "string" || block.value === undefined) return null;
  return {
    value: block.value as string,
    tag: block.tag as TaggedValue["tag"],
    filters: (Array.isArray(block.filters) ? block.filters : []) as TaggedValue["filters"],
  };
}

/**
 * True when a stored `context` member holds the empty default the engine writes
 * unconditionally, so authoring nothing re-encodes to the same bytes.
 *
 * The engine fills `search` / `bind` / `eval` on a query that filters, joins, and
 * computes nothing; the SDK's encoder omits them (`if (search !== undefined)`).
 * `normalize` already reconciles that by dropping such a member from **both**
 * sides, so the only correct reading of one is "not authored" — and the test is
 * delegated to the normalizer rather than restated here, which is what keeps the
 * decoder and the comparison it will be judged by from drifting apart.
 *
 * Reading them as a filter this decoder failed to parse is what cost 113 of 201
 * fallen-back `db.query` statements their readability.
 */
function isUnauthored(key: string, value: unknown): boolean {
  return value === undefined || isDefaultEnvelopeMember(key, value);
}

/** A stored `const:bool` with no filter chain, as a plain boolean. */
function plainBool(raw: unknown): boolean | null {
  const value = toValue(raw);
  if (!value || value.tag !== "const:bool" || value.filters.length > 0) return null;
  return value.value === "true";
}

/** A recovered `table:` argument — a bound reference, or `null` when unbound. */
interface TableArg {
  readonly expr: Expr;
  readonly runtime: { name: string; guid: string } | null;
}

/**
 * The `table:` argument for a stored table guid.
 *
 * The source side gets a symbol (or a `{name, guid}` literal); the runtime side
 * always references the table by guid, because `resolveRef` returns an explicit
 * guid verbatim — so proving never depends on whether a symbol was in scope. The
 * indexed name still rides along: `db.add_or_edit` stores it as `context.dbo.as`
 * and `db.query` uses it to alias-qualify aggregate columns.
 */
function tableArg(a: SpecialArgs, guid: string): TableArg {
  const target = a.refs.lookup(guid);
  return {
    expr: resolveReference(a.ctx, a.refs, guid, { ...a.resolve, unresolved: "object-ref" }),
    runtime: { name: target?.name ?? "", guid },
  };
}

/**
 * A blank `context.dbo.id` — recovered as `table: null`, and REPORTED.
 *
 * The bytes are faithful either way (`raw()` would carry the same blank), and the
 * authoring surface models the unbound state deliberately as `table: null` — the
 * same contract an addon's `table` has carried all along. Reading it as "nothing
 * to recover" degraded 83 db statements to `raw()` across the sweep.
 *
 * **It reports rather than emitting quietly**, because a blank binding is a
 * defect in the workspace and `table: null` is the faithful rendering of one —
 * emitting it silently would let a lost binding pass as a deliberate choice.
 * There is one reading and no hedge: this flow pulls whole workspaces, so a
 * blank reference cannot be a live target that merely sat outside the export
 * (see {@link blankRefDetail}). Same contract the realtime kinds already hold
 * blank bindings to (`test/codegen/realtime-blank-refs`), applied consistently.
 *
 * The alias is left to {@link aliasEntry}, which reads `dbo.as` by presence: a
 * deleted table's alias frequently outlives it (`{as: "user", id: ""}`).
 */
function unboundTableArg(a: SpecialArgs, what: string): TableArg {
  a.ctx.problem("blank-binding", blankRefDetail(`${what} has a blank table reference`, "table"), what);
  return { expr: lit(null), runtime: null };
}


/**
 * The `tableAlias:` argument for a stored `context.dbo.as`.
 *
 * Read by PRESENCE, not compared against the table name: Xano writes this alias
 * on some db statements and omits it on others within the same workspace, so its
 * absence is data too. An alias that does not equal the referenced table's name
 * cannot be reproduced through a symbol reference (the def carries the real
 * name), so `prove` rejects it and the statement falls back — exact, unreadable.
 */
function aliasEntry(stored: unknown): { entry: [string, Expr]; runtime: string } | null {
  const alias = getPath(stored, "dbo.as");
  if (typeof alias !== "string") return null;
  return { entry: ["tableAlias", lit(alias)], runtime: alias };
}

/**
 * The `enforceHiddenFields:` argument for a stored `context.enforce_hidden_fields`.
 *
 * Read by VALUE rather than presence, because this one has a real default: the
 * engine declares `enforce_hidden_fields?=false` and three statement classes read
 * it as `?? false`, so absent and `false` are the same OFF and only `true` is
 * worth authoring. All 557 stored `dbo_add` statements in the offline corpus omit
 * it entirely; the flag showed up on a current instance.
 *
 * Returning null for a stored `false` is what keeps the round trip exact — the
 * encoder writes the key only when on, so recovering `enforceHiddenFields: false`
 * would re-encode to an absent key and fail its own proof.
 *
 * A stored `false` therefore falls back to `raw()`, and that is deliberate. The
 * engine's side of "absent means false" is evidenced twice over, but invariant 2
 * wants the other half too — a real workspace storing the key present-at-default
 * beside one omitting it — and no workspace does: 557 stored `dbo_add` statements
 * omit it and the only one that writes it writes `true`. Normalizing a spelling
 * nothing produces would be modelling on an analogy. If it ever shows up, the
 * fallback now names the exact key, which is the whole point of the report.
 */
function enforceHiddenFieldsEntry(
  stored: unknown,
): { entry: [string, Expr]; runtime: boolean } | null {
  return getPath(stored, "enforce_hidden_fields") === true
    ? { entry: ["enforceHiddenFields", lit(true)], runtime: true }
    : null;
}

/** One parsed `input[]` entry, with the sub-entries of an expanded one. */
interface InputEntry {
  readonly name: string;
  readonly value: TaggedValue;
  readonly ignore: boolean;
  readonly children: InputEntry[];
}

/**
 * Parse `input[]` into name/value/ignore entries, recursing into the `children`
 * of an expanded one, or null if any entry is malformed.
 *
 * `expand` and `children` must agree, because the encoder derives `expand` from
 * "has children" and so cannot reproduce a tree where they disagree. Neither
 * disagreeing combination occurs in the wild; declining keeps them recorded as
 * `raw()` rather than re-encoded into a shape that differs from what is stored.
 */
function inputEntries(stored: StackItemXdo): InputEntry[] | null {
  return parseEntries(stored.input, "input[]");
}

function parseEntries(list: unknown, path: string): InputEntry[] | null {
  const out: InputEntry[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const value = toValue(raw);
    const name = (raw as { name?: unknown }).name;
    if (!value || typeof name !== "string")
      return declineHere(`${path}: entry is not a named tagged value`);
    const rawChildren = (raw as { children?: unknown }).children;
    const expand = (raw as { expand?: unknown }).expand === true;
    const hasChildren = Array.isArray(rawChildren) && rawChildren.length > 0;
    if (expand !== hasChildren)
      return declineHere(`${path}: "expand" disagrees with "children"`);
    const children = hasChildren ? parseEntries(rawChildren, `${path}.children[]`) : [];
    if (!children) return null;
    out.push({
      name,
      value,
      ignore: (raw as { ignore?: unknown }).ignore === true,
      children,
    });
  }
  return out;
}

/**
 * The `output:` argument for a decoded column whitelist.
 *
 * A bare name the bound table does not carry — a column since renamed or
 * dropped, still listed in a stored `output` — names no key: the engine returns
 * the row without it. Written plainly it fails `OutputPath` typing, so the
 * decoded tree reported as verified would not compile. It is written
 * `"name" as never` instead, which re-encodes to the same bytes and types the
 * row the engine actually returns (without it), and REPORTED as a workspace
 * defect. Checked only against a table this bundle holds; a dotted path, an
 * `eval`/addon alias and a paging-envelope field are not columns to check.
 */
function outputArg(a: SpecialArgs, cols: readonly string[], guid: string | undefined): Expr {
  const schema = guid === undefined ? undefined : a.refs.lookup(guid)?.schema;
  if (!Array.isArray(schema)) return lit(cols);
  const known = new Set<string>(PAGING_ENVELOPE_ROOTS);
  for (const column of schema) known.add(String((column as { name?: unknown } | null)?.name));
  const aliases = [
    ...asArray(getPath(a.stored.context, "eval")),
    ...asArray((a.stored as { addon?: unknown }).addon),
  ];
  for (const alias of aliases) {
    const as = (alias as { as?: unknown } | null)?.as;
    if (typeof as === "string") known.add(as.split(".").pop()!);
  }
  const stale = cols.filter((col) => !col.includes(".") && !known.has(col));
  if (stale.length === 0) return lit(cols);
  a.ctx.problem(
    "workspace-defect",
    `\`output\` selects ${stale.map((col) => `"${col}"`).join(", ")}, which table "${a.refs.lookup(guid!)?.name ?? ""}" ` +
      `does not carry — the engine returns the row without ${stale.length === 1 ? "it" : "them"}. Decoded as ` +
      `\`"…" as never\` so the tree compiles; drop ${stale.length === 1 ? "it" : "them"} from the list, or restore the column.`,
  );
  return arr(cols.map((col) => (stale.includes(col) ? id(`${JSON.stringify(col)} as never`) : lit(col))));
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The column whitelist a statement's `output` envelope carries, if it is
 * customized — as the dotted paths that re-encode to the stored tree, so a
 * nested selection (sub-keys of an object column) survives the round trip.
 * `undefined` for an uncustomized block; a customized block the path form cannot
 * express returns `undefined` too, which leaves the block unaccounted and lets
 * `prove` decline rather than emitting a selection that drops keys.
 */
function outputCols(stored: StackItemXdo): string[] | undefined {
  const output = (stored as { output?: unknown }).output as
    | { customize?: unknown; items?: unknown }
    | undefined;
  if (!output || output.customize !== true) return undefined;
  return outputPaths(output.items ?? []) ?? undefined;
}

/**
 * Only row-data entries have an authored home for sub-entries or an `ignore`
 * flag. A lookup or named entry that carries either would re-encode without it,
 * so this declines with a label rather than letting `prove` report it as an
 * anonymous byte difference.
 *
 * `ignore` is not exhaust on these entries — it is honoured. The engine walks
 * every statement's `input[]` through ONE generic routine that knows nothing
 * about which slot an entry fills: a flagged entry is recorded as
 * `"<name>:ignore"` and then skipped, so it never reaches the statement and
 * never joins the input whitelist. On a lookup that means `field_name` or
 * `field_value` is simply not passed. That is a real (if broken-looking) stored
 * state, and `raw()` preserves it rather than re-encoding a statement that
 * would suddenly start passing the entry.
 */
function plainEntry(row: InputEntry, path: string): boolean {
  if (row.children.length > 0) {
    declineHere(`${path}: "${row.name}" carries sub-entries, which only row data can hold`);
    return false;
  }
  if (row.ignore) {
    declineHere(
      `${path}: "${row.name}" is flagged \`ignore\`, which only row data can hold — the engine ` +
        `drops the entry, so it is not passed at all`,
    );
    return false;
  }
  return true;
}

/**
 * One row-write entry as authored `data:` — `{name, value}`, plus `ignore` when
 * set and `children` when the entry is expanded. Shared by every op that carries
 * row data so the nested form cannot decode one way here and another there.
 */
function rowCell(
  a: SpecialArgs,
  row: InputEntry,
): { expr: Expr; runtime: Record<string, unknown> } {
  const fields: Array<[string, Expr]> = [
    ["name", lit(row.name)],
    ["value", decodeValue(a.ctx, row.value)],
  ];
  const runtime: Record<string, unknown> = { name: row.name, value: row.value };
  if (row.ignore) {
    fields.push(["ignore", lit(true)]);
    runtime.ignore = true;
  }
  if (row.children.length > 0) {
    const children = row.children.map((child) => rowCell(a, child));
    fields.push(["children", arr(children.map((child) => child.expr))]);
    runtime.children = children.map((child) => child.runtime);
  }
  return { expr: obj(fields), runtime };
}

/** Decode one stored addon attachment, recursing into `children`. */
function decodeAddonSpec(
  a: SpecialArgs,
  stored: unknown,
): { expr: Expr; runtime: Record<string, unknown> } | null {
  if (stored === null || typeof stored !== "object")
    return declineHere("addon[]: attachment is not an object");
  const block = stored as Record<string, unknown>;
  const guid = block.id;
  const alias = block.as;
  // A NUMERIC id is a bound row reference, not portable identity — the same
  // settled case the call family declines by name, and the only shape in the
  // survey corpus that reaches this guard (3 attachments; every other one
  // carries a string id, blank or otherwise). It was reported as "has no id",
  // which is false and sent the reader looking for a missing key.
  if (typeof guid === "number" && isBoundNumericId(guid))
    return declineHere(
      `addon[]: attachment id ${JSON.stringify(guid)} is a numeric object reference, not portable identity`,
    );
  if ((typeof guid !== "string" && typeof guid !== "number") || typeof alias !== "string")
    return declineHere("addon[]: attachment has no id or no as");

  // The encoder splits the authored destination at its last dot into
  // `offset` + `as`; rejoining them recovers exactly what was authored, including
  // any `items[]` paging-envelope prefix (whose re-application is idempotent).
  const offset = typeof block.offset === "string" ? block.offset : "";
  const destination = offset ? `${offset}.${alias}` : alias;

  // An UNBOUND id is an attachment whose addon was deleted or never bound.
  // Resolving it threw inside the factory, which degraded the whole enclosing
  // query to `raw()`; `addon: null` is the same "no target" spelling `table:
  // null` and `fn: null` already carry, and it keeps the query readable.
  //
  // Both stored spellings of "no target" count — the blank string and the
  // numeric `0` a pre-guid attachment carries. A numeric id that is NOT the
  // sentinel already declined above, so this reads no identity out of a number;
  // it only recognizes the absence of one.
  const unbound = isUnboundId(guid);
  const target = unbound ? undefined : a.refs.lookup(guid as string);
  // Reported for the same reason a blank `table` is: the two causes — deleted or
  // never bound vs. blanked on the way out of a narrow export — are
  // indistinguishable here, and emitting `addon: null` silently would present a
  // real lost binding as a deliberate one.
  if (unbound) {
    a.ctx.problem(
      "blank-binding",
      blankRefDetail(`addon attachment "${alias}" has a blank addon reference`, "addon"),
      `addon "${alias}"`,
    );
  }
  const entries: Array<[string, Expr]> = [
    [
      "addon",
      unbound
        ? lit(null)
        : resolveReference(a.ctx, a.refs, guid as string, { ...a.resolve, unresolved: "object-ref" }),
    ],
    ["as", lit(destination)],
  ];
  const runtime: Record<string, unknown> = {
    addon: unbound ? null : { name: target?.name ?? "", guid: guid as string },
    as: destination,
  };

  const inputList = Array.isArray(block.input) ? block.input : [];
  if (inputList.length > 0) {
    const cells: Array<[string, Expr]> = [];
    const inputRuntime: Record<string, unknown> = {};
    for (const raw of inputList) {
      const value = toValue(raw);
      const name = (raw as { name?: unknown }).name;
      if (!value || typeof name !== "string")
        return declineHere("addon[].input[]: entry is not a named tagged value");
      cells.push([name, decodeValue(a.ctx, value)]);
      inputRuntime[name] = value;
    }
    entries.push(["input", obj(cells)]);
    runtime.input = inputRuntime;
  }

  const output = block.output as { customize?: unknown; items?: unknown } | undefined;
  if (output?.customize === true) {
    const paths = outputPaths(output.items ?? []);
    if (!paths)
      return declineHere("addon[].output.items[]: column selection is not a name tree");
    entries.push(["output", lit(paths)]);
    runtime.output = paths;
  }

  const children = Array.isArray(block.children) ? block.children : [];
  if (children.length > 0) {
    const decoded = children.map((child) => decodeAddonSpec(a, child));
    if (decoded.some((d) => d === null)) return null;
    entries.push(["children", arr(decoded.map((d) => d!.expr))]);
    runtime.children = decoded.map((d) => d!.runtime);
  }
  return { expr: obj(entries), runtime };
}

/** Decode the statement's `addon[]` block, or null when it is malformed. */
function decodeAddons(
  a: SpecialArgs,
  stored: StackItemXdo,
  pagedEnvelope = false,
): { expr: Expr; runtime: unknown[] } | null {
  const list = (stored as { addon?: unknown }).addon;
  if (!Array.isArray(list) || list.length === 0) return null;
  const decoded = list.map((spec) => {
    const one = decodeAddonSpec(a, spec);
    // On a query that returns the paging envelope, a top-level attachment whose
    // offset is not under `items[]` grafts onto the envelope itself — the engine
    // applies the stored path as written. `envelope: true` says so; without it
    // the encoder would move the graft onto every row.
    const offset = (spec as { offset?: unknown } | null)?.offset;
    if (one === null || !pagedEnvelope || (typeof offset === "string" && offset.startsWith("items"))) return one;
    return {
      expr: one.expr.kind === "object" ? obj([...one.expr.entries, ["envelope", lit(true)]]) : one.expr,
      runtime: { ...(one.runtime as Record<string, unknown>), envelope: true },
    };
  });
  if (decoded.some((d) => d === null)) return null;
  return { expr: arr(decoded.map((d) => d!.expr)), runtime: decoded.map((d) => d!.runtime) };
}

/**
 * Decode `[{sortBy, orderBy}]` back to the authoring `[{sortBy, dir?}]` form.
 *
 * `keptBare` names the keys the encoder would qualify (a joined list/stream
 * query's undotted own-column keys) — stored bare, they carry `qualify: false`
 * so the typed call re-encodes them bare rather than qualified.
 */
function decodeSort(
  list: unknown,
  keptBare: (sortBy: string) => boolean = () => false,
): { expr: Expr; runtime: unknown[] } | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const exprs: Expr[] = [];
  const runtime: unknown[] = [];
  for (const raw of list) {
    const sortBy = (raw as { sortBy?: unknown }).sortBy;
    const orderBy = (raw as { orderBy?: unknown }).orderBy;
    if (typeof sortBy !== "string") return declineHere("sort[]: entry has no sortBy");
    const cells: Array<[string, Expr]> = [["sortBy", lit(sortBy)]];
    const entry: Record<string, unknown> = { sortBy };
    // `asc` is the encoder's default, so stating it would be noise.
    if (typeof orderBy === "string" && orderBy !== "asc") {
      cells.push(["dir", lit(orderBy)]);
      entry.dir = orderBy;
    }
    if (keptBare(sortBy)) {
      cells.push(["qualify", lit(false)]);
      entry.qualify = false;
    }
    exprs.push(obj(cells));
    runtime.push(entry);
  }
  return { expr: arr(exprs), runtime };
}

/**
 * Decode an `eval[]` block (`context.eval`, or an aggregate's `group`/`eval`).
 *
 * `stripAlias` undoes the aggregate qualifier: the encoder prefixes a bare column
 * with the primary table alias, so removing that prefix recovers what was
 * authored and re-qualifies to the identical stored name.
 */
function decodeEvals(
  a: SpecialArgs,
  list: unknown,
  stripAlias = "",
): { expr: Expr; runtime: unknown[] } | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const exprs: Expr[] = [];
  const runtime: unknown[] = [];
  const prefix = stripAlias ? `${stripAlias}.` : "";
  for (const raw of list) {
    const block = raw as { as?: unknown; name?: unknown; filters?: unknown };
    if (typeof block.as !== "string" || typeof block.name !== "string")
      return declineHere("eval[]: entry has no name or no as");
    const name = prefix && block.name.startsWith(prefix) ? block.name.slice(prefix.length) : block.name;
    const cells: Array<[string, Expr]> = [
      ["name", lit(name)],
      ["as", lit(block.as)],
    ];
    const entry: Record<string, unknown> = { name, as: block.as };

    const filters = Array.isArray(block.filters) ? block.filters : [];
    if (filters.length > 0) {
      const filterExprs: Expr[] = [];
      const filterRuntime: unknown[] = [];
      for (const step of filters) {
        const stepBlock = step as { name?: unknown; arg?: unknown; disabled?: unknown };
        if (typeof stepBlock.name !== "string")
          return declineHere("eval[].filters[]: step has no name");
        const stepCells: Array<[string, Expr]> = [["name", lit(stepBlock.name)]];
        const stepEntry: Record<string, unknown> = { name: stepBlock.name };
        const args = Array.isArray(stepBlock.arg) ? stepBlock.arg : [];
        if (args.length > 0) {
          const values = args.map(toValue);
          if (values.some((v) => v === null))
            return declineHere("eval[].filters[].arg[]: argument is not a tagged value");
          stepCells.push(["arg", arr(values.map((v) => decodeValue(a.ctx, v!)))]);
          stepEntry.arg = values;
        }
        if (stepBlock.disabled === true) {
          stepCells.push(["disabled", lit(true)]);
          stepEntry.disabled = true;
        }
        filterExprs.push(obj(stepCells));
        filterRuntime.push(stepEntry);
      }
      cells.push(["filters", arr(filterExprs)]);
      entry.filters = filterRuntime;
    }
    exprs.push(obj(cells));
    runtime.push(entry);
  }
  return { expr: arr(exprs), runtime };
}

// ---------------------------------------------------------------------------
// The uniform `!map:dbo` operations
// ---------------------------------------------------------------------------

/** How one uniform db op maps its stored `input[]` onto authoring arguments. */
interface DboOpShape {
  /** The `s.` path to emit. */
  readonly path: string;
  /** Consume a leading `field_name`/`field_value` pair as `fieldName`/`fieldValue`. */
  readonly lookup?: boolean;
  /** Named entries mapped straight onto an authoring argument. */
  readonly named?: ReadonlyArray<{
    readonly entry: string;
    readonly arg: string;
    /** A `const:bool` entry decodes to a plain boolean; anything else stays a value. */
    readonly bool?: boolean;
    /**
     * The entry is `?=` in the engine schema, so its ABSENCE is meaningful and
     * must survive: present → emit the argument (even at its default value),
     * absent → omit it. Reading presence rather than comparing to a default is
     * what lets both the lean shape Xano's editor writes and the explicit shape
     * an author asks for round-trip to their own bytes.
     */
    readonly optional?: boolean;
  }>;
  /** Remaining entries become the row-write `data:` list. */
  readonly rowData?: boolean;
  /** The op accepts an `output:` column whitelist. */
  readonly takesOutput?: boolean;
  /** The op accepts `addon:` attachments. */
  readonly takesAddon?: boolean;
}

/** Build a decoder for one uniform `context.dbo.id` + `input[]` operation. */
function dboOp(shape: DboOpShape): SpecialDecoder {
  return (a) => {
    const storedId = getPath(a.stored.context, "dbo.id");
    if (!isReferenceId(storedId))
      return declineHere(`${shape.path}: context.dbo.id is not a reference id`);
    if (isBoundNumericId(storedId))
      return declineHere(`${shape.path}: context.dbo.id is a numeric object reference`);
    const entriesIn = inputEntries(a.stored);
    if (!entriesIn) return null;

    const table = isUnboundId(storedId)
      ? unboundTableArg(a, shape.path)
      : tableArg(a, String(storedId));
    const entries: Array<[string, Expr]> = [["table", table.expr]];
    const runtime: Record<string, unknown> = { table: table.runtime };
    const alias = aliasEntry(a.stored.context);
    if (alias) {
      entries.push(alias.entry);
      runtime.tableAlias = alias.runtime;
    }
    const enforce = enforceHiddenFieldsEntry(a.stored.context);
    if (enforce) {
      entries.push(enforce.entry);
      runtime.enforceHiddenFields = enforce.runtime;
    }
    let cursor = 0;

    if (shape.lookup) {
      // The lookup value is a REQUIRED argument: with no entry to pass it, the
      // engine answers `Missing param: field_value` on every run. A stored
      // statement in that state is broken where it lives, and `raw()` is its
      // faithful reading — filed as a workspace defect, not a decoder gap.
      const lookupValue = entriesIn.find((e) => e.name === "field_value");
      if (lookupValue === undefined || lookupValue.ignore) {
        return declineHere(
          `${lookupValue === undefined ? "stores no `field_value` entry" : "flags its `field_value` entry `ignore`, so the engine never passes it"}` +
            ` — the value it looks the row up by is a required argument, so the engine answers ` +
            "`Missing param: field_value` on every run",
          "workspace-defect",
        );
      }
      const fieldName = entriesIn[cursor++];
      const fieldValue = entriesIn[cursor++];
      if (fieldName?.name !== "field_name" || fieldValue?.name !== "field_value")
        return declineHere(`${shape.path}: input[] does not lead with field_name/field_value`);
      if (fieldName.value.tag !== "const" || fieldName.value.filters.length > 0)
        return declineHere(`${shape.path}: field_name is not a bare constant`);
      if (!plainEntry(fieldName, shape.path) || !plainEntry(fieldValue, shape.path)) return null;
      // `id` is the encoder's default lookup column, so naming it adds nothing.
      if (fieldName.value.value !== "id") {
        entries.push(["fieldName", lit(fieldName.value.value)]);
        runtime.fieldName = fieldName.value.value;
      }
      entries.push(["fieldValue", decodeValue(a.ctx, fieldValue.value)]);
      runtime.fieldValue = fieldValue.value;
    }

    for (const spec of shape.named ?? []) {
      const found = entriesIn[cursor];
      if (found?.name !== spec.entry) {
        // An optional entry the engine omitted: skip it without consuming a slot.
        if (spec.optional) continue;
        // `db.patch` with no `item`: the engine treats the payload as empty, so
        // it looks the row up and saves it unchanged. Every other stored entry
        // names an input the statement does not declare, which it never reads.
        if (shape.path === "db.patch" && spec.entry === "item") {
          const unread = entriesIn.slice(cursor).filter((e) => !e.ignore).map((e) => `\`${e.name}\``);
          return declineHere(
            "stores no `item`, so it writes nothing: the engine looks the row up and saves it unchanged" +
              (unread.length > 0
                ? `. Its other entries (${unread.join(", ")}) are not inputs this statement declares, so the engine never reads them`
                : ""),
            "workspace-defect",
          );
        }
        return declineHere(`${shape.path}: input[] is missing required "${spec.entry}"`);
      }
      cursor += 1;
      if (!plainEntry(found, shape.path)) return null;
      if (spec.bool) {
        const value = plainBool(found.value);
        if (value === null)
          return declineHere(`${shape.path}: "${spec.entry}" is not a bare boolean constant`);
        entries.push([spec.arg, lit(value)]);
        runtime[spec.arg] = value;
        continue;
      }
      entries.push([spec.arg, decodeValue(a.ctx, found.value)]);
      runtime[spec.arg] = found.value;
    }

    // Where the row argument goes, decided once every other argument is known.
    const rowAt = entries.length;
    let rows: InputEntry[] = [];
    if (shape.rowData) {
      rows = entriesIn.slice(cursor);
      cursor = entriesIn.length;
    }

    // A stored entry no rule accounts for means this is not the shape we think
    // it is — fall through rather than silently dropping it.
    if (cursor !== entriesIn.length)
      return declineHere(
        `${shape.path}: input[] carries ${entriesIn.length - cursor} unaccounted entries ` +
          `(first: "${entriesIn[cursor]?.name ?? ""}")`,
      );

    if (shape.takesOutput) {
      const cols = outputCols(a.stored);
      if (cols?.length) {
        entries.push(["output", outputArg(a, cols, table.runtime?.guid)]);
        runtime.output = cols;
      }
    }
    if (shape.takesAddon) {
      const addons = decodeAddons(a, a.stored);
      if (addons) {
        entries.push(["addon", addons.expr]);
        runtime.addon = addons.runtime;
      }
    }

    const as = (a.stored as { as?: unknown }).as;
    if (typeof as === "string" && as !== "") {
      entries.push(["as", lit(as)]);
      runtime.as = as;
    }
    if (rows.length > 0) {
      // `row: { … }` — only the cells the expansion would not supply itself —
      // when it re-encodes to exactly these bytes; the verbatim `data:` list
      // otherwise. The same rule as `guard.found`: readable only when proven.
      const write = ROW_WRITERS[shape.path];
      const row = write === undefined ? null : addRow(a, runtime, rows, String(storedId), write);
      if (row !== null) {
        entries.splice(rowAt, 0, ["row", row.expr]);
        runtime.row = row.runtime;
        runtime.table = row.table;
      } else {
        const cells = rows.map((r) => rowCell(a, r));
        entries.splice(rowAt, 0, ["data", arr(cells.map((cell) => cell.expr))]);
        runtime.data = cells.map((cell) => cell.runtime);
      }
    }
    return prove(a.ctx, a.stored, shape.path, [runtime], [obj(entries)]);
  };
}

/** The row-writing factories whose `data:` list may read back as `row: {}`. */
type RowWriter = (args: never) => Parameters<typeof encodeStatement>[0];
const ROW_WRITERS: Readonly<Record<string, RowWriter>> = {
  "db.add": dbAdd as RowWriter,
  "db.edit": dbEdit as RowWriter,
};

/**
 * A stored row write's field list as the `row:` record that expands back to it,
 * or `null` when it does not: a nested cell, a table this bundle does not hold,
 * or any difference at all once re-encoded. `db.add`, `db.edit` and
 * `db.add_or_edit` share it — each through its own factory, so the proof is
 * that statement's own expansion.
 */
function addRow(
  a: SpecialArgs,
  runtime: Record<string, unknown>,
  rows: readonly InputEntry[],
  guid: string,
  write: RowWriter,
): { expr: Expr; runtime: Record<string, unknown>; table: unknown } | null {
  const schema = a.refs.lookup(guid)?.schema;
  if (!Array.isArray(schema) || rows.some((r) => r.children.length > 0)) return null;
  const table = { ...(runtime.table as object), schema };
  let bare: StackItemXdo;
  try {
    bare = encodeStatement(write({ ...(runtime as object), table, row: {} } as never));
  } catch {
    return null;
  }
  // Keep only the cells the empty row does not already produce — compared as
  // whole entries, since an edit's expansion marks an unwritten column
  // `ignore: true` where a written one at the same value is not. The reduced
  // row is then re-encoded below, which is the proof.
  const defaults = new Map(
    ((bare as { input?: Array<{ name: string }> }).input ?? []).map((e) => [e.name, e] as const),
  );
  const storedInput = (a.stored as { input?: Array<{ name: string }> }).input ?? [];
  const kept = rows.filter((r) => {
    const stored = storedInput.find((e) => e.name === r.name);
    return !deepEqual(normalize(stored), normalize(defaults.get(r.name)));
  });
  const rowRuntime = Object.fromEntries(kept.map((r) => [r.name, r.value]));
  try {
    const reduced = encodeStatement(write({ ...(runtime as object), table, row: rowRuntime } as never));
    if (!deepEqual(normalize(reduced), normalize(a.stored))) return null;
  } catch {
    return null;
  }
  return {
    expr: obj(kept.map((r) => [r.name, decodeValue(a.ctx, r.value)] as [string, Expr])),
    runtime: rowRuntime,
    table,
  };
}

/**
 * `db.add_or_edit` — the one `!map:dbo` op on the leaner serialization.
 *
 * Its `context.dbo` carries the table's own name beside the guid, its input
 * entries are the lean form, and only the row-data entries carry an `ignore`
 * flag. The table argument must therefore reproduce that stored name, which is
 * why the ref index's name — not an empty placeholder — is what proves here.
 */
const dbAddOrEdit: SpecialDecoder = (a) => {
  const storedId = getPath(a.stored.context, "dbo.id");
  if (!isReferenceId(storedId))
    return declineHere("db.add_or_edit: context.dbo.id is not a reference id");
  if (isBoundNumericId(storedId))
    return declineHere("db.add_or_edit: context.dbo.id is a numeric object reference");
  // `dbo.as` is read by PRESENCE, like every other db statement: it is authored
  // per statement, so its absence is data. Requiring it here would make
  // `add_or_edit` the one db statement that could not decode without an alias.
  const alias = aliasEntry(a.stored.context);

  const entriesIn = inputEntries(a.stored);
  if (!entriesIn) return null;
  const [fieldName, fieldValue, ...rows] = entriesIn;
  if (fieldName?.name !== "field_name" || fieldValue?.name !== "field_value")
    return declineHere("db.add_or_edit: input[] does not lead with field_name/field_value");
  if (fieldName.value.tag !== "const" || fieldName.value.filters.length > 0)
    return declineHere("db.add_or_edit: field_name is not a bare constant");
  if (!plainEntry(fieldName, "db.add_or_edit") || !plainEntry(fieldValue, "db.add_or_edit"))
    return null;

  // Through the shared table argument like the rest of the family, which is what
  // gives this one the unbound state too — it used to resolve the guid inline.
  const table = isUnboundId(storedId)
    ? unboundTableArg(a, "db.add_or_edit")
    : tableArg(a, String(storedId));
  const entries: Array<[string, Expr]> = [["table", table.expr]];
  const runtime: Record<string, unknown> = { table: table.runtime };
  if (alias) {
    entries.push(alias.entry);
    runtime.tableAlias = alias.runtime;
  }
  const enforce = enforceHiddenFieldsEntry(a.stored.context);
  if (enforce) {
    entries.push(enforce.entry);
    runtime.enforceHiddenFields = enforce.runtime;
  }

  if (fieldName.value.value !== "id") {
    entries.push(["fieldName", lit(fieldName.value.value)]);
    runtime.fieldName = fieldName.value.value;
  }
  entries.push(["fieldValue", decodeValue(a.ctx, fieldValue.value)]);
  runtime.fieldValue = fieldValue.value;

  const as = (a.stored as { as?: unknown }).as;
  if (typeof as === "string" && as !== "") runtime.as = as;
  if (rows.length > 0) {
    const row = isUnboundId(storedId)
      ? null
      : addRow(a, runtime, rows, String(storedId), dbAddOrEditStatement as RowWriter);
    if (row !== null) {
      entries.push(["row", row.expr]);
      runtime.row = row.runtime;
      runtime.table = row.table;
    } else {
      const cells = rows.map((row) => rowCell(a, row));
      entries.push(["data", arr(cells.map((cell) => cell.expr))]);
      runtime.data = cells.map((cell) => cell.runtime);
    }
  }
  if (typeof as === "string" && as !== "") entries.push(["as", lit(as)]);
  return prove(a.ctx, a.stored, "db.add_or_edit", [runtime], [obj(entries)]);
};

// ---------------------------------------------------------------------------
// Raw SQL, bulk writes, and the transaction block
// ---------------------------------------------------------------------------

/** The positional `arg[]` bind values a raw-SQL statement carries. */
function sqlArgs(
  a: SpecialArgs,
  context: Record<string, unknown>,
): { expr: Expr; runtime: TaggedValue[] } | null {
  const list = Array.isArray(context.arg) ? context.arg : [];
  const values = list.map(toValue);
  if (values.some((v) => v === null))
    return declineHere("raw SQL: context.arg[] holds a non-tagged value");
  return {
    expr: arr(values.map((v) => decodeValue(a.ctx, v!))),
    runtime: values as TaggedValue[],
  };
}

/** Shared decode of the `{code, response_type, arg[]}` raw-SQL context. */
function sqlEntries(
  a: SpecialArgs,
  context: Record<string, unknown>,
): { entries: Array<[string, Expr]>; runtime: Record<string, unknown> } | null {
  // An UNCONFIGURED statement — the engine writes `context: {}` for one that was
  // dropped into a stack and never filled in, and all 6 in the survey corpus are
  // that, not a malformed `code`. Left as `raw()` deliberately, and the two
  // halves have DIFFERENT reasons — read them before re-opening this:
  //
  //  - The five external-engine variants declare `connection_string_flex` as a
  //    NESTED object, and the optional-schema pass defaults a nested member to
  //    the literal string `"{}"` rather than materializing it (see the note by
  //    {@link filledContext}). There is nothing to recover, full stop.
  //  - `mvp:dbo_direct_query` is different: its context is `{code, response_type
  //    ?=list, parser?=prepared, arg[]?=[]}` — every member a scalar or a list,
  //    so the engine DOES supply them all and the state is in principle
  //    recoverable. What stops it is shape, not evidence: {@link
  //    EMPTY_CONTEXT_FILL} fills a context that IS a tagged value, and this one
  //    is a plain multi-member record. Closing it means a second fill shape for
  //    one row of a statement that has no SQL in it either way.
  if (context.code === undefined && Object.keys(context).length === 0) {
    // One writer, not two. `noteDecline` is first-writer-wins, so a second call
    // here — carrying the better sentence — could never land, and every row
    // would show the terser guard label instead.
    return declineHere(
      "stores an entirely empty context — it was added to the stack and never configured, so " +
        "there is no SQL and no connection to recover. `raw()` is what an unconfigured stub " +
        "looks like",
      "unconfigured-stub",
    );
  }
  if (typeof context.code !== "string") return declineHere("raw SQL: context.code is not a string");
  const entries: Array<[string, Expr]> = [["sql", lit(context.code)]];
  const runtime: Record<string, unknown> = { sql: context.code };
  // `list` is the encoder's default result shape.
  if (typeof context.response_type === "string" && context.response_type !== "list") {
    entries.push(["responseType", lit(context.response_type)]);
    runtime.responseType = context.response_type;
  }
  // How the body is interpolated. Absent means the engine's `prepared` default,
  // and the engine's own renderer omits the key there — so presence, not value,
  // is what has to be carried back.
  if (context.parser !== undefined) {
    if (typeof context.parser !== "string")
      return declineHere("raw SQL: context.parser is not a string");
    entries.push(["parser", lit(context.parser)]);
    runtime.parser = context.parser;
  }
  const args = sqlArgs(a, context);
  if (!args) return null;
  if (args.runtime.length > 0) {
    entries.push(["args", args.expr]);
    runtime.args = args.runtime;
  }
  return { entries, runtime };
}

/** `db.direct_query` — raw SQL against the workspace database. */
const dbDirectQuery: SpecialDecoder = (a) => {
  const context = (a.stored.context ?? {}) as Record<string, unknown>;
  const decoded = sqlEntries(a, context);
  if (!decoded) return null;
  const as = (a.stored as { as?: unknown }).as;
  if (typeof as === "string" && as !== "") {
    decoded.entries.push(["as", lit(as)]);
    decoded.runtime.as = as;
  }
  return prove(a.ctx, a.stored, "db.direct_query", [decoded.runtime], [obj(decoded.entries)]);
};

/** Stored name → the external engine segment of its `s.` path. */
const EXTERNAL_ENGINES: ReadonlyMap<string, string> = new Map([
  ["mvp:dbo_external_mssql_query", "mssql"],
  ["mvp:dbo_external_mysql_query", "mysql"],
  ["mvp:dbo_external_oracle_query", "oracle"],
  ["mvp:dbo_external_postgres_query", "postgres"],
  ["mvp:dbo_external_snowflake_query", "snowflake"],
]);

/** `db.external.<engine>.direct_query` — raw SQL against an external database. */
function externalQuery(engine: string): SpecialDecoder {
  return (a) => {
    const context = (a.stored.context ?? {}) as Record<string, unknown>;
    const decoded = sqlEntries(a, context);
    if (!decoded) return null;
    // Two stored generations, both live. The engine prefers the tagged
    // `connection_string_flex` and falls back to the bare `connection_string`
    // whenever the tagged value is empty — so read them in that same order, and
    // carry back whichever one the workspace actually holds.
    const flex = context.connection_string_flex;
    const bare = context.connection_string;
    //
    // Unlike the `token` slot these are two DIFFERENT keys rather than two
    // shapes of one, so each is read on its own terms: the newer key must hold
    // a tagged value, and the older one a non-empty string.
    const tagged = toValue(flex);
    const connection = tagged
      ? { runtime: tagged as unknown, expr: decodeValue(a.ctx, tagged) }
      : typeof bare === "string" && bare !== ""
        ? { runtime: bare as unknown, expr: lit(bare) }
        : null;
    if (!connection)
      return declineHere(
        "external SQL: neither context.connection_string_flex (a tagged value, " +
          `${describeStored(flex)} here) nor context.connection_string (a non-empty string, ` +
          `${describeStored(bare)} here) names a connection`,
      );
    decoded.entries.splice(1, 0, ["connectionString", connection.expr]);
    decoded.runtime.connectionString = connection.runtime;

    const as = (a.stored as { as?: unknown }).as;
    if (typeof as === "string" && as !== "") {
      decoded.entries.push(["as", lit(as)]);
      decoded.runtime.as = as;
    }
    return prove(
      a.ctx,
      a.stored,
      `db.external.${engine}.direct_query`,
      [decoded.runtime],
      [obj(decoded.entries)],
    );
  };
}

/** `db.bulk.delete` — the one bulk op whose filter rides `context.search`. */
const dbBulkDelete: SpecialDecoder = (a) => {
  const context = (a.stored.context ?? {}) as Record<string, unknown>;
  const storedId = getPath(context, "dbo.id");
  if (!isReferenceId(storedId))
    return declineHere("db.bulk.delete: context.dbo.id is not a reference id");
  if (isBoundNumericId(storedId))
    return declineHere("db.bulk.delete: context.dbo.id is a numeric object reference");
  const table = isUnboundId(storedId)
    ? unboundTableArg(a, "db.bulk.delete")
    : tableArg(a, String(storedId));
  const entries: Array<[string, Expr]> = [["table", table.expr]];
  const runtime: Record<string, unknown> = { table: table.runtime };
  const alias = aliasEntry(context);
  if (alias) {
    entries.push(alias.entry);
    runtime.tableAlias = alias.runtime;
  }

  // A stored delete with NO `search` key at all cannot be spelled by the
  // factory any more: `allRows: true` emits the empty-group search the
  // engine requires, so generated source would re-encode to different bytes.
  // Such a statement is already broken at runtime — the engine answers
  // `Missing param: search` — so decline and let it round-trip as raw() rather
  // than silently rewrite it.
  if (isUnauthored("search", context.search)) {
    return declineHere(
      "stores no `search` — the engine answers `Missing param: search` on every run, so it deletes nothing",
      "workspace-defect",
    );
  }
  const where = decodeWhere(a, context.search, "db.bulk.delete search");
  if (!where) return null;
  entries.push(["where", where.expr]);
  runtime.where = where.runtime;
  // A stored search that constrains nothing — an empty `expression[]`, or an
  // empty `and()`/`or()` group — deletes every row, and the factory requires
  // that intent to be spelled out. Generated source spells it out while keeping
  // whatever `where` was stored, so the re-encoded bytes are unchanged.
  if (!searchConstrainsRows(context.search)) {
    entries.push(["allRows", lit(true)]);
    runtime.allRows = true;
  }
  const as = (a.stored as { as?: unknown }).as;
  if (typeof as === "string" && as !== "") {
    entries.push(["as", lit(as)]);
    runtime.as = as;
  }
  return prove(a.ctx, a.stored, "db.bulk.delete", [runtime], [obj(entries)]);
};

/**
 * A stored increment amount as the authoring argument: a bare number when the
 * factory's number form re-encodes to the same tag (whole → `const:int`,
 * fractional → `const:decimal`), otherwise the tagged value as stored.
 */
function incrementAmount(a: SpecialArgs, value: TaggedValue): { expr: Expr; runtime: unknown } {
  if (value.filters.length === 0 && (value.tag === "const:int" || value.tag === "const:decimal")) {
    const n = Number(value.value);
    const numberForm = Number.isFinite(n) && String(n) === value.value;
    if (numberForm && Number.isInteger(n) === (value.tag === "const:int")) {
      return { expr: lit(n), runtime: n };
    }
  }
  return { expr: decodeValue(a.ctx, value), runtime: value };
}

/** `db.increment` — a `db.bulk.delete`-style search plus `field_name`/`value` and a return mode. */
const dbIncrement: SpecialDecoder = (a) => {
  const context = (a.stored.context ?? {}) as Record<string, unknown>;
  const storedId = getPath(context, "dbo.id");
  if (!isReferenceId(storedId))
    return declineHere("db.increment: context.dbo.id is not a reference id");
  if (isBoundNumericId(storedId))
    return declineHere("db.increment: context.dbo.id is a numeric object reference");
  const table = isUnboundId(storedId)
    ? unboundTableArg(a, "db.increment")
    : tableArg(a, String(storedId));
  const entries: Array<[string, Expr]> = [["table", table.expr]];
  const runtime: Record<string, unknown> = { table: table.runtime };
  const alias = aliasEntry(context);
  if (alias) {
    entries.push(alias.entry);
    runtime.tableAlias = alias.runtime;
  }

  // The editor saves a new increment before its where is set. The engine changes
  // no rows for it, and the factory refuses to author that, so it stays raw().
  if (!searchConstrainsRows(context.search))
    return declineHere("db.increment: context.search constrains nothing (the engine changes no rows)");
  const where = decodeWhere(a, context.search, "db.increment search");
  if (!where) return null;
  entries.push(["where", where.expr]);
  runtime.where = where.runtime;

  const inputs = inputEntries(a.stored);
  if (!inputs) return null;
  const [field, amount] = inputs;
  if (inputs.length !== 2 || field?.name !== "field_name" || amount?.name !== "value")
    return declineHere("db.increment: input[] is not exactly field_name, value");
  if (!plainEntry(field, "db.increment") || !plainEntry(amount, "db.increment")) return null;
  if (field.value.tag === "const" && field.value.filters.length === 0) {
    entries.push(["fieldName", lit(field.value.value)]);
    runtime.fieldName = field.value.value;
  } else {
    entries.push(["fieldName", decodeValue(a.ctx, field.value)]);
    runtime.fieldName = field.value;
  }
  const value = incrementAmount(a, amount.value);
  entries.push(["value", value.expr]);
  runtime.value = value.runtime;

  const returnType = getPath(context, "return.type");
  if (returnType !== "list" && returnType !== "count")
    return declineHere(`db.increment: context.return.type is ${describeStored(returnType)}, not "list" or "count"`);
  if (returnType === "count") {
    entries.push(["returnType", lit("count")]);
    runtime.returnType = "count";
  }

  const cols = outputCols(a.stored);
  if (cols?.length) {
    entries.push(["output", outputArg(a, cols, table.runtime?.guid)]);
    runtime.output = cols;
  }
  const addons = decodeAddons(a, a.stored);
  if (addons) {
    entries.push(["addon", addons.expr]);
    runtime.addon = addons.runtime;
  }
  const as = (a.stored as { as?: unknown }).as;
  if (typeof as === "string" && as !== "") {
    entries.push(["as", lit(as)]);
    runtime.as = as;
  }
  return prove(a.ctx, a.stored, "db.increment", [runtime], [obj(entries)]);
};

/** `db.transaction { … }` — a nested `run[]`, and the result binding it carries. */
const dbTransaction: SpecialDecoder = (a) => {
  const body = a.decodeStack(getPath(a.stored.context, "run"));
  const entries: Array<[string, Expr]> = [["body", arr(body.exprs)]];
  const runtime: Record<string, unknown> = { body: body.statements };
  const as = (a.stored as { as?: unknown }).as;
  if (typeof as === "string" && as !== "") {
    entries.push(["as", lit(as)]);
    runtime.as = as;
  }
  return prove(a.ctx, a.stored, "db.transaction", [runtime], [obj(entries)]);
};

// ---------------------------------------------------------------------------
// `db.query` — the wide one
// ---------------------------------------------------------------------------

/**
 * Decode a stored `where`: an `{expression: […]}` tree through the shared
 * boolean-expression inverse, or a raw `Value` escape hatch passed through.
 *
 * Null is always fatal for a caller (a search filter cannot be dropped), so the
 * decline is recorded here rather than at each call site.
 *
 * `site` names WHICH where failed. A query has three of them — its own search,
 * a `bind[]` join's, and an addon attachment's — and the bare message named
 * none, so six declines in the survey corpus all read identically and could not
 * be told apart without re-deriving the call site by hand.
 */
function decodeWhere(
  a: SpecialArgs,
  stored: unknown,
  site: string,
): { expr: Expr; runtime: unknown } | null {
  const condition = decodeCondition(a.ctx, stored, { sqlWhere: true });
  if (condition) return { expr: condition.expr, runtime: condition.runtime };
  const value = toValue(stored);
  if (!value)
    return declineHere(
      `where (${site}): neither a decodable condition tree nor a tagged value — stored ${JSON.stringify(stored).slice(0, 80)}`,
    );
  return { expr: decodeValue(a.ctx, value), runtime: value };
}

/** A persisted int, whether serialized as a number or as a numeric string. */
function numberOf(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v !== "" && /^-?\d+$/.test(v)) return Number(v);
  return undefined;
}

/** The paging fields a query recovers, split between the static block and `simpleExternal`. */
function decodePaging(
  a: SpecialArgs,
  block: Record<string, unknown>,
  simple: Record<string, unknown>,
  fields: readonly (readonly [key: "page" | "per_page" | "offset", fallback: number])[],
): { entries: Array<[string, Expr]>; runtime: Record<string, unknown> } | null {
  const entries: Array<[string, Expr]> = [];
  const runtime: Record<string, unknown> = {};
  for (const [key, fallback] of fields) {
    // An input-bound field lives in `simpleExternal` and shadows the static
    // baseline, which stays at its engine default in that case.
    if (simple[key] !== undefined) {
      const value = toValue(simple[key]);
      if (!value)
        return declineHere(`db.query: context.simpleExternal.${key} is not a tagged value`);
      entries.push([key, decodeValue(a.ctx, value)]);
      runtime[key] = value;
      continue;
    }
    // The engine's schema types these `int`, but a persisted value can arrive as
    // a numeric STRING — the same serialization artifact `normalize` absorbs for
    // tagged `value`/`arg`. Requiring a number here silently skipped the field, so
    // the re-encode fell back to the engine default and the whole query degraded
    // to `raw()` over a paging size the SDK had read but discarded.
    const stored = numberOf(block[key]);
    if (stored !== undefined && stored !== fallback) {
      entries.push([key, lit(stored)]);
      runtime[key] = stored;
    }
  }
  return { entries, runtime };
}

/** `db.query` — the full query-all surface. */
const dbQuery: SpecialDecoder = (a) => {
  const context = (a.stored.context ?? {}) as Record<string, unknown>;
  const storedId = getPath(context, "dbo.id");
  if (!isReferenceId(storedId))
    return declineHere("db.query: context.dbo.id is not a reference id");
  if (isBoundNumericId(storedId))
    return declineHere("db.query: context.dbo.id is a numeric object reference");
  if (Array.isArray(a.stored.input) && a.stored.input.length > 0)
    return declineHere("db.query: statement-level input[] is populated");

  const table = isUnboundId(storedId)
    ? unboundTableArg(a, "db.query")
    : tableArg(a, String(storedId));
  const entries: Array<[string, Expr]> = [["table", table.expr]];
  // A table reached by symbol is its def in the generated file, and the factory
  // checks column paths only against a def that carries columns — so the proof
  // carries them too, or a stored path those checks refuse would prove here and
  // throw when the pulled tree loads.
  const schema = table.runtime === null ? undefined : a.refs.lookup(table.runtime.guid)?.schema;
  const runtime: Record<string, unknown> = {
    table: table.expr.kind === "id" && Array.isArray(schema) ? { ...table.runtime, schema } : table.runtime,
  };
  const alias = aliasEntry(context);
  if (alias) {
    entries.push(alias.entry);
    runtime.tableAlias = alias.runtime;
  }

  const ret = (context.return ?? {}) as Record<string, unknown>;
  const returnType = typeof ret.type === "string" ? ret.type : "list";
  // The editor writes every return branch and the engine reads only the one
  // `type` selects, so the rest are dropped (see `liveReturnSection`). A dropped
  // branch that still holds real configuration is worth saying out loud — it is
  // what the query used to do before its return type was switched.
  for (const dead of configuredDeadReturnBlocks(ret)) {
    a.ctx.problem(
      "expected-omission",
      `db.query returns "${returnType}", so its stored "${dead}" return block — which carries a sort, grouping, or paging — is inert: the engine reads only the branch \`return.type\` names. Dropped.`,
    );
  }
  if (returnType !== "list") {
    entries.push(["returnType", lit(returnType)]);
    runtime.returnType = returnType;
  }

  if (!isUnauthored("search", context.search)) {
    const where = decodeWhere(a, context.search, "db.query search");
    if (!where) return null;
    entries.push(["where", where.expr]);
    runtime.where = where.runtime;
  }

  if (!isUnauthored("bind", context.bind)) {
    if (!Array.isArray(context.bind))
      return declineHere("db.query: context.bind is present but not an array");
    const bindExprs: Expr[] = [];
    const bindRuntime: unknown[] = [];
    for (const stored of context.bind) {
      const bindGuid = getPath(stored, "dbo.id");
      const bindAlias = getPath(stored, "dbo.as");
      if (typeof bindGuid !== "string")
        return declineHere("db.query: a context.bind[] join has no dbo.id");
      // A dotted id is not a table: it is the `<alias>.<column>` path of a list
      // column the engine expands into one joined row per element. No guid
      // carries a `.`, so the two cannot be confused.
      if (bindGuid.includes(".")) {
        if (typeof bindAlias !== "string" || bindAlias === "")
          return declineHere("db.query: a context.bind[] list expansion has no dbo.as");
        const cells: Array<[string, Expr]> = [
          ["expand", lit(bindGuid)],
          ["as", lit(bindAlias)],
        ];
        const entry: Record<string, unknown> = { expand: bindGuid, as: bindAlias };
        const join = (stored as { join?: unknown }).join;
        if (typeof join === "string" && join !== "inner") {
          cells.push(["join", lit(join)]);
          entry.join = join;
        }
        const search = (stored as { search?: unknown }).search;
        if (!isUnauthored("search", search)) {
          const where = decodeWhere(a, search, "db.query bind[] expansion");
          if (!where) return null;
          cells.push(["where", where.expr]);
          entry.where = where.runtime;
        }
        bindExprs.push(obj(cells));
        bindRuntime.push(entry);
        continue;
      }
      // A join to an UNBOUND table — the join's table was deleted, and the
      // engine clears the id rather than recording a tombstone. `DbBind.table`
      // models this as `null` on the same contract the query's own `table`
      // holds, so it round-trips instead of taking the whole statement to
      // `raw()` for one broken join.
      const unbound = isUnboundId(bindGuid);
      const joined = unbound
        ? unboundTableArg(a, "db.query bind")
        : tableArg(a, bindGuid);
      const cells: Array<[string, Expr]> = [["table", joined.expr]];
      const entry: Record<string, unknown> = { table: joined.runtime };
      // The alias defaults to the joined table's own name — except on an unbound
      // join, which has no name to default from, so it is always authored. The
      // stored bytes show the alias outliving the table (`{as:"…", id:""}`).
      if (typeof bindAlias === "string" && (unbound || bindAlias !== joined.runtime?.name)) {
        cells.push(["as", lit(bindAlias)]);
        entry.as = bindAlias;
      }
      const join = (stored as { join?: unknown }).join;
      if (typeof join === "string" && join !== "inner") {
        cells.push(["join", lit(join)]);
        entry.join = join;
      }
      // A join's own filter gets the same "empty means unauthored" treatment the
      // query's top-level search has always had. Testing only `!== undefined`
      // sent the engine's unconditional `{expression: []}` into the condition
      // inverse, which cannot build an empty tree — so five joined queries in
      // the survey corpus fell back to `raw()` for filtering on nothing.
      const search = (stored as { search?: unknown }).search;
      if (!isUnauthored("search", search)) {
        const where = decodeWhere(a, search, "db.query bind[] join");
        if (!where) return null;
        cells.push(["where", where.expr]);
        entry.where = where.runtime;
      }
      bindExprs.push(obj(cells));
      bindRuntime.push(entry);
    }
    entries.push(["bind", arr(bindExprs)]);
    runtime.bind = bindRuntime;
  }

  if (!isUnauthored("eval", context.eval)) {
    const evals = decodeEvals(a, context.eval);
    if (!evals) return null;
    entries.push(["eval", evals.expr]);
    runtime.eval = evals.runtime;
  }

  if (context.lock !== undefined) {
    const lock = plainBool(context.lock);
    if (lock === null)
      return declineHere("db.query: context.lock is not a bare boolean constant");
    entries.push(["lock", lit(lock)]);
    runtime.lock = lock;
  }

  // Same story as `search`/`eval` above, and more common: the engine writes all
  // five `simpleExternal` facets at an empty `input` default on a query that binds
  // none of them. Read as authored, they would become five bound paging Values on
  // a query that binds nothing, and the recovered call would not match the stored
  // one. Measured: a large share of fallen-back queries stored exactly this pair.
  //
  // `external` alongside them is not a conflict: the engine branches on the
  // RESOLVED `external` and falls back to `simpleExternal` when it comes back
  // empty, so the two are a chain. The unauthored-default filter below is
  // load-bearing on its own.
  const simple = isUnauthored("simpleExternal", context.simpleExternal)
    ? {}
    : (context.simpleExternal as Record<string, unknown>);
  const pagingEntries: Array<[string, Expr]> = [];
  const pagingRuntime: Record<string, unknown> = {};
  let sortBlock: unknown;
  let distinct: unknown;
  /** The stored paging gate, for the return types that carry one. */
  let storedEnabled: boolean | undefined;

  if (returnType === "single") {
    sortBlock = getPath(ret, "single.sort");
  } else if (returnType === "stream") {
    sortBlock = getPath(ret, "stream.sort");
    distinct = getPath(ret, "stream.distinct");
    const block = (getPath(ret, "stream.paging") ?? {}) as Record<string, unknown>;
    storedEnabled = block.enabled === true;
    const paging = decodePaging(a, block, simple, [
      ["page", 1],
      ["per_page", 25],
    ]);
    if (!paging) return null;
    pagingEntries.push(...paging.entries);
    Object.assign(pagingRuntime, paging.runtime);
  } else if (returnType === "aggregate") {
    sortBlock = getPath(ret, "aggregate.sort");
  } else if (returnType === "list") {
    sortBlock = getPath(ret, "list.sort");
    distinct = getPath(ret, "list.distinct");
    const block = (getPath(ret, "list.paging") ?? {}) as Record<string, unknown>;
    storedEnabled = block.enabled === true;
    const paging = decodePaging(a, block, simple, [
      ["page", 1],
      ["per_page", 25],
      ["offset", 0],
    ]);
    if (!paging) return null;
    pagingEntries.push(...paging.entries);
    Object.assign(pagingRuntime, paging.runtime);
    if (block.metadata === false) {
      pagingEntries.push(["metadata", lit(false)]);
      pagingRuntime.metadata = false;
    }
    if (block.totals === true) {
      pagingEntries.push(["totals", lit(true)]);
      pagingRuntime.totals = true;
    }
  }

  // `search`/`sort` overrides are input-bound only — they have no static
  // counterpart, so they come straight off `simpleExternal`.
  for (const key of ["search", "sort"] as const) {
    if (simple[key] === undefined) continue;
    const value = toValue(simple[key]);
    if (!value)
      return declineHere(`db.query: context.simpleExternal.${key} is not a tagged value`);
    pagingEntries.push([key, decodeValue(a.ctx, value)]);
    pagingRuntime[key] = value;
  }

  // The gate is DERIVED by the encoder (a page field or an `external` blob turns it
  // on), so it is authored back only when the stored value disagrees — which real
  // workspaces routinely do: they persist a non-default `per_page` with the gate
  // off. Emitting it unconditionally would be noise on every query; not emitting it
  // at all is what cost ~158 statements their readability, since the same
  // derivation also decides where addons graft (`items[]`).
  //
  // An ABSENT gate is an off one: the engine reads a missing paging block, or a
  // block with no `enabled`, as paging disabled — so a query storing a bare
  // `{type: "list"}` beside an `external` blob (which the encoder would switch
  // the gate on for) decodes with `enabled: false`.
  if (storedEnabled !== undefined) {
    const derived =
      pagingRuntime.page !== undefined ||
      pagingRuntime.per_page !== undefined ||
      pagingRuntime.offset !== undefined ||
      context.external !== undefined;
    if (storedEnabled !== derived) {
      pagingEntries.push(["enabled", lit(storedEnabled)]);
      pagingRuntime.enabled = storedEnabled;
    }
  }

  if (returnType !== "aggregate") {
    // The encoder's joined-sort qualification (see `dbQuery`), inverted: on a
    // joined list/stream query of a bound table, an undotted key that is not an
    // eval alias is one it would qualify — so a stored bare one opts out.
    const joinedRowQuery =
      (returnType === "list" || returnType === "stream") &&
      (table.runtime?.name ?? "") !== "" &&
      Array.isArray(runtime.bind) &&
      runtime.bind.length > 0;
    const evalAliases = new Set(
      (Array.isArray(runtime.eval) ? runtime.eval : []).map((e) => (e as { as?: unknown }).as),
    );
    const sort = decodeSort(
      sortBlock,
      (sortBy) => joinedRowQuery && sortBy !== "" && !sortBy.includes(".") && !evalAliases.has(sortBy),
    );
    if (sort) {
      entries.push(["sort", sort.expr]);
      runtime.sort = sort.runtime;
    }
  }
  if (pagingEntries.length > 0) {
    entries.push(["paging", obj(pagingEntries)]);
    runtime.paging = pagingRuntime;
  }
  if (context.external !== undefined) {
    const external = decodeExternal(a, context.external);
    if (!external) return null; // `decodeExternal` records which part refused
    entries.push(["external", external.expr]);
    runtime.external = external.runtime;
  }
  // `auto` is the encoder's default and is written unconditionally.
  if (typeof distinct === "string" && distinct !== "auto") {
    entries.push(["distinct", lit(distinct)]);
    runtime.distinct = distinct;
  }

  if (returnType === "aggregate") {
    // An unbound table contributes no alias to qualify aggregate columns with,
    // matching the encoder's own `null` branch.
    const aggregate = decodeAggregate(a, ret, table.runtime?.name ?? "", sortBlock);
    if (!aggregate) return declineHere("db.query: context.return.aggregate is not decodable");
    entries.push(["aggregate", aggregate.expr]);
    runtime.aggregate = aggregate.runtime;
  }

  const cols = outputCols(a.stored);
  if (cols?.length) {
    entries.push(["output", outputArg(a, cols, table.runtime?.guid)]);
    runtime.output = cols;
  }
  const listPaging = getPath(ret, "list.paging") as { enabled?: unknown; metadata?: unknown } | undefined;
  const pagedEnvelope = returnType === "list" && listPaging?.enabled === true && listPaging.metadata !== false;
  const addons = decodeAddons(a, a.stored, pagedEnvelope);
  if (addons) {
    entries.push(["addon", addons.expr]);
    runtime.addon = addons.runtime;
  }
  const as = (a.stored as { as?: unknown }).as;
  if (typeof as === "string" && as !== "") {
    entries.push(["as", lit(as)]);
    runtime.as = as;
  }
  return prove(a.ctx, a.stored, "db.query", [runtime], [obj(entries)]);
};

/** Decode the classic single-blob `context.external` override. */
function decodeExternal(
  a: SpecialArgs,
  stored: unknown,
): { expr: Expr; runtime: Record<string, unknown> } | null {
  const value = toValue(stored);
  if (!value) return declineHere("db.query: context.external is not a tagged value");
  const entries: Array<[string, Expr]> = [["value", decodeValue(a.ctx, value)]];
  const runtime: Record<string, unknown> = { value };

  const permissions = (stored as { permissions?: unknown }).permissions as
    | Record<string, unknown>
    | undefined;
  // Engine defaults, written unconditionally by the encoder — only a deviation
  // needs to be authored back.
  const defaults: ReadonlyArray<readonly [string, boolean]> = [
    ["search", true],
    ["sort", true],
    ["page", true],
    ["per_page", false],
  ];
  if (permissions) {
    const cells: Array<[string, Expr]> = [];
    const gates: Record<string, boolean> = {};
    for (const [key, fallback] of defaults) {
      const gate = permissions[key];
      if (typeof gate !== "boolean")
        return declineHere(`db.query: context.external.permissions.${key} is not a boolean`);
      if (gate !== fallback) {
        cells.push([key, lit(gate)]);
        gates[key] = gate;
      }
    }
    if (cells.length > 0) {
      entries.push(["permissions", obj(cells)]);
      runtime.permissions = gates;
    }
  }
  return { expr: obj(entries), runtime };
}

/** Decode `context.return.aggregate` — group/eval aliases, sort, and paging. */
function decodeAggregate(
  a: SpecialArgs,
  ret: Record<string, unknown>,
  primaryAlias: string,
  sortBlock: unknown,
): { expr: Expr; runtime: Record<string, unknown> } | null {
  const entries: Array<[string, Expr]> = [];
  const runtime: Record<string, unknown> = {};

  const group = decodeEvals(a, getPath(ret, "aggregate.group"), primaryAlias);
  if (group) {
    entries.push(["group", group.expr]);
    runtime.group = group.runtime;
  }
  const evals = decodeEvals(a, getPath(ret, "aggregate.eval"), primaryAlias);
  if (evals) {
    entries.push(["eval", evals.expr]);
    runtime.eval = evals.runtime;
  }
  const sort = decodeSort(sortBlock);
  if (sort) {
    entries.push(["sort", sort.expr]);
    runtime.sort = sort.runtime;
  }
  const paging = getPath(ret, "aggregate.paging") as Record<string, unknown> | undefined;
  if (paging) {
    const cells: Array<[string, Expr]> = [];
    const values: Record<string, unknown> = {};
    if (typeof paging.page === "number" && paging.page !== 1) {
      cells.push(["page", lit(paging.page)]);
      values.page = paging.page;
    }
    if (typeof paging.per_page === "number" && paging.per_page !== 25) {
      cells.push(["per_page", lit(paging.per_page)]);
      values.per_page = paging.per_page;
    }
    if (paging.metadata === false) {
      cells.push(["metadata", lit(false)]);
      values.metadata = false;
    }
    // The gate defaults to on (a `paging` block is how you ask for paging), so
    // only a parked block — configured but switched back off — authors it.
    if (paging.enabled === false) {
      cells.push(["enabled", lit(false)]);
      values.enabled = false;
    }
    // An aggregate `paging` block exists only when it was authored, so the key
    // is emitted even when every field sits at its default.
    entries.push(["paging", obj(cells)]);
    runtime.paging = values;
  }
  return { expr: obj(entries), runtime };
}

/** Database-family decoders by stored name. */
export const DB_DECODERS: ReadonlyMap<string, SpecialDecoder> = new Map<string, SpecialDecoder>([
  [
    "mvp:dbo_getby",
    dboOp({
      path: "db.get",
      lookup: true,
      named: [{ entry: "lock", arg: "lock", bool: true, optional: true }],
      takesOutput: true,
      takesAddon: true,
    }),
  ],
  ["mvp:dbo_delby", dboOp({ path: "db.del", lookup: true })],
  ["mvp:dbo_hasby", dboOp({ path: "db.has", lookup: true })],
  [
    "mvp:dbo_patch",
    dboOp({
      path: "db.patch",
      lookup: true,
      named: [{ entry: "item", arg: "data" }],
      takesOutput: true,
      takesAddon: true,
    }),
  ],
  ["mvp:dbo_truncate", dboOp({ path: "db.truncate", named: [{ entry: "reset", arg: "reset", bool: true, optional: true }] })],
  ["mvp:dbo_get_schema", dboOp({ path: "db.schema", named: [{ entry: "path", arg: "path" }] })],
  ["mvp:dbo_add", dboOp({ path: "db.add", rowData: true, takesOutput: true, takesAddon: true })],
  [
    "mvp:dbo_editby",
    dboOp({ path: "db.edit", lookup: true, rowData: true, takesOutput: true, takesAddon: true }),
  ],
  ["mvp:dbo_addoreditby", dbAddOrEdit],
  [
    "mvp:dbo_bulkadd",
    dboOp({
      path: "db.bulk.add",
      named: [
        { entry: "allow_id_field", arg: "allowIdField", bool: true, optional: true },
        { entry: "items", arg: "items" },
      ],
    }),
  ],
  ["mvp:dbo_bulkpatch", dboOp({ path: "db.bulk.patch", named: [{ entry: "items", arg: "items" }] })],
  ["mvp:dbo_bulkupdate", dboOp({ path: "db.bulk.update", named: [{ entry: "items", arg: "items" }] })],
  ["mvp:dbo_bulkdelete", dbBulkDelete],
  ["mvp:dbo_increment", dbIncrement],
  ["mvp:dbo_direct_query", dbDirectQuery],
  ["mvp:db_transaction", dbTransaction],
  ["mvp:dbo_view", dbQuery],
  ...[...EXTERNAL_ENGINES].map(
    ([name, engine]) => [name, externalQuery(engine)] as [string, SpecialDecoder],
  ),
]);
