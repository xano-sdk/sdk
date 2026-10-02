/**
 * The import plan in the SDK's words — how `deploy --to` shows a plan to a
 * reader and to a `--json` caller.
 *
 * The import route answers in the engine's vocabulary: storage type names
 * (`api_group`, `workflow_test`), wire flags (`mode=replace`, `delete=true`,
 * `records=false`) and sentences written for the route's own maintainers. None
 * of that is what an author typed: they wrote `apiGroup()`, `workflowTest()`,
 * `--replace`, `--prune`, `--seed`. So every plan leaves the CLI through here,
 * naming objects exactly as `workspace diff` and promote's verification do
 * (`query:GET ping (apiGroup notes)`), and saying why in the SDK's own flags.
 *
 * Presentation only. The plan the release logic reasons over — the prune scope,
 * the correspondence count — stays in the route's vocabulary, because that is
 * what the lock is keyed against.
 */
import { payloadOf, planTypeSection, rowLabeler, sectionKind } from "../deploy/live-diff.js";
import type { ImportOperation } from "../deploy/xanosdk-import.js";

/** What a plan is presented against: the bundle sent, the target read, and which kind of target. */
export interface PlanContext {
  /** The archive's bundle, as sent. Names what is created or updated. */
  readonly bundle: unknown;
  /** The target as it was read before the import, when it could be. Names what is deleted. */
  readonly live: unknown;
  /** A tenant, not a workspace: it has no branches, and is named as a tenant. */
  readonly tenant: boolean;
  /**
   * How the prose names the target, when it is not what {@link tenant} implies:
   * an ephemeral is a tenant on the wire (`--to tenant:<ephemeral>`), and the
   * plan said "drops every table in the tenant" under a headline naming an
   * ephemeral.
   */
  readonly noun?: TargetNoun;
  /**
   * What the project's records say about an object a prune deletes, so the plan
   * does not tell a reader "this project no longer declares it" about a table
   * it never had. Absent, or `undefined` from it, when nothing was read to say.
   */
  readonly provenance?: (op: ImportOperation, row: Row | undefined) => DeleteProvenance | undefined;
  /**
   * Where the archive came from and whether it carries rows, for the sentence
   * that says what a replace re-creates. Absent reads as this project's own
   * compile carrying its seed rows — the sentence as the route's callers first
   * wrote it. A `--bundle` or a fetched backend is not "this project", and an
   * archive without rows re-creates every table empty.
   */
  readonly rows?: PlanRows;
}

/** {@link PlanContext.rows}. */
export interface PlanRows {
  /** `project`: an entry this run compiled. `bundle`: a file or a backend someone exported. */
  readonly source: "project" | "bundle";
  /** Whether the archive writes rows (the plan's `hasRecords`). */
  readonly carried: boolean;
}

/**
 * Where an object a prune deletes came from, as the project's records say:
 * `landed` — this destination's landing record names it (this project put it
 * there and no longer declares it); `adopted` — the landing record names it,
 * but the lock entry came from `lock import` and the project's source never
 * declared it; `locked` — the lock names it but nothing recorded landing it
 * here; `never` — neither does, so it is another project's or was made by hand.
 */
export type DeleteProvenance = "landed" | "adopted" | "locked" | "never";

/** How a plan sentence names what it writes to. */
export type TargetNoun = "workspace" | "tenant" | "ephemeral";

/** The noun a {@link PlanContext} names its target by. */
export function nounOf(ctx: Pick<PlanContext, "tenant" | "noun">): TargetNoun {
  return ctx.noun ?? (ctx.tenant ? "tenant" : "workspace");
}

/** One plan operation, named the way the author wrote the object. */
export interface PresentedOperation {
  /** The SDK kind: `table`, `apiGroup`, `workflowTest`, `query`, `agent`, … */
  readonly type: string;
  readonly name: string;
  /** A query's verb, when the bundle or the target says. */
  readonly verb?: string;
  /** A query's api group, when the bundle or the target says. */
  readonly apiGroup?: string;
  /** `<kind>:<name>`, the spelling `workspace diff` prints for the same object. */
  readonly label: string;
  readonly action: string;
  readonly details?: string;
  readonly reason?: string;
}

export type Row = Record<string, unknown>;

function rowsOf(payload: Record<string, unknown>, section: string): Row[] {
  const rows = payload[section];
  return Array.isArray(rows) ? rows.filter((r): r is Row => r !== null && typeof r === "object") : [];
}

/**
 * The SDK kind for a plan's `type` (or a canonical report's `kind`), read off the
 * matching row when the section holds more than one kind (`toolset`).
 */
export function sdkKindForPlanType(type: string, row?: Row): string {
  return sectionKind(planTypeSection(type), row);
}

function guidOf(row: Row): string | undefined {
  return typeof row.guid === "string" && row.guid !== "" ? row.guid : undefined;
}

/**
 * The TARGET row each delete operation removes, index for index with `ops`
 * (`undefined` for anything that is not a delete, or that cannot be placed).
 *
 * The route names a deleted object by its name alone, and a name is not an
 * identity: `GET ping` and `POST ping` share one, and so do two `ping`s in two
 * api groups. What the route actually deletes under a merge is a target row
 * whose guid the bundle does NOT carry — a row the bundle matches by guid is
 * updated, never deleted. So a delete is placed among the target's rows of that
 * section and name whose guid the bundle lacks, each row used once. Only when no
 * such row is left (a replace, which deletes every row) does it fall back to any
 * unused row of that name.
 *
 * This is the one place a delete is tied to an object, and both the plan a
 * reader confirms and `--prune`'s ownership check read it — so the object named
 * is the object judged, and the object judged is the object removed.
 */
export function deletedRows(ops: readonly ImportOperation[], ctx: Pick<PlanContext, "bundle" | "live">): (Row | undefined)[] {
  const ours = payloadOf(ctx.bundle);
  const theirs = payloadOf(ctx.live);
  const used = new Set<Row>();
  const carried = new Map<string, Set<string>>();
  const carriedIn = (section: string): Set<string> => {
    let set = carried.get(section);
    if (set === undefined) {
      set = new Set(rowsOf(ours, section).map(guidOf).filter((g): g is string => g !== undefined));
      carried.set(section, set);
    }
    return set;
  };
  return ops.map((op) => {
    if (op.action !== "delete") return undefined;
    const section = planTypeSection(op.type);
    const kept = carriedIn(section);
    const named = rowsOf(theirs, section).filter((r) => !used.has(r) && r.name === op.name);
    const row =
      named.find((r) => {
        const guid = guidOf(r);
        return guid === undefined || !kept.has(guid);
      }) ?? named[0];
    if (row !== undefined) used.add(row);
    return row;
  });
}

/**
 * The plan's operations, presented.
 *
 * A create or update names a row of the BUNDLE, a delete a row of the TARGET,
 * and that is where each one's verb and api group are read. The route emits the
 * bundle's rows in payload order — every row exactly one create or update — so
 * the n-th query create-or-update is the n-th query row, which tells two
 * same-named queries apart. A delete is placed by {@link deletedRows}: among the
 * target's rows the bundle does not carry, never one it is about to update.
 */
export function presentOperations(ops: readonly ImportOperation[], ctx: PlanContext): PresentedOperation[] {
  const ours = payloadOf(ctx.bundle);
  const theirs = payloadOf(ctx.live);
  const ourLabel = rowLabeler(ours);
  const theirLabel = rowLabeler(theirs);
  const cursor = new Map<string, number>();
  const deleted = deletedRows(ops, ctx);
  // A replace plans every table twice — dropped by the clear, then created from
  // the archive. A delete with a create of the same kind and name beside it is
  // re-created, not "dropped, not re-created" (E2E pass 16).
  const created = new Set(ops.filter((o) => o.action === "create").map((o) => `${o.type}\u0000${o.name}`));

  return ops.map((op, index) => {
    const section = planTypeSection(op.type);
    let row: Row | undefined;
    let labeler = ourLabel;
    if (op.action === "delete") {
      labeler = theirLabel;
      row = deleted[index];
    } else if (op.action === "create" || op.action === "update") {
      const rows = rowsOf(ours, section);
      const at = cursor.get(section) ?? 0;
      // The positional match is trusted only while it agrees on the name — a
      // route that ever reorders falls back to the first row of that name.
      row = rows[at]?.name === op.name ? rows[at] : rows.find((r) => r.name === op.name);
      cursor.set(section, at + 1);
    } else {
      row = rowsOf(ours, section).find((r) => r.name === op.name);
    }

    const type = sdkKindForPlanType(op.type, row);
    const query = section === "query" && row !== undefined ? queryParts(row, labeler(section, row)) : {};
    const label = row !== undefined && section !== "workspace" ? labeler(section, row) : `${type}:${op.name}`;
    const provenance = op.action === "delete" ? ctx.provenance?.(op, row) : undefined;
    const worded = op.action === "delete" && created.has(`${op.type}\u0000${op.name}`) ? "recreate" : op.action;
    const details = sdkWords(op.details, nounOf(ctx), provenance, ctx.rows, worded);
    const reason = sdkWords(op.reason, nounOf(ctx), provenance, ctx.rows, worded);
    return {
      type,
      name: op.name,
      ...query,
      label,
      action: op.action,
      ...(details === undefined ? {} : { details }),
      ...(reason === undefined ? {} : { reason }),
    };
  });
}

/**
 * Tables the bundle carries under a guid the target holds by another name. A
 * merge matches tables on guid, so it renames each and keeps its rows — and the
 * route's plan reports that as a routine update of the NEW name.
 */
export function tableRenames(bundle: unknown, live: unknown): { from: string; to: string }[] {
  const liveNames = new Map<string, string>();
  for (const row of rowsOf(payloadOf(live), "dbo")) {
    const guid = guidOf(row);
    if (guid !== undefined && typeof row.name === "string") liveNames.set(guid, row.name);
  }
  const out: { from: string; to: string }[] = [];
  for (const row of rowsOf(payloadOf(bundle), "dbo")) {
    const guid = guidOf(row);
    if (guid === undefined || typeof row.name !== "string") continue;
    const from = liveNames.get(guid);
    if (from !== undefined && from !== row.name) out.push({ from, to: row.name });
  }
  return out;
}

/** A query's verb and group, read back out of the label `rowLabeler` built from the same payload. */
function queryParts(row: Row, label: string): { verb?: string; apiGroup?: string } {
  const verb = typeof row.verb === "string" && row.verb !== "" ? row.verb : undefined;
  const group = / \(apiGroup (.+)\)$/.exec(label)?.[1];
  return { ...(verb === undefined ? {} : { verb }), ...(group === undefined ? {} : { apiGroup: group }) };
}

/** Action counts, recounted from the presented operations so the totals and the list agree. */
export function countActions(ops: readonly PresentedOperation[]): Record<string, number> {
  const out: Record<string, number> = { create: 0, update: 0, delete: 0, truncate: 0 };
  for (const op of ops) out[op.action] = (out[op.action] ?? 0) + 1;
  return out;
}

/** Per-kind action counts, recounted from the presented operations so they use the same kind names. */
export function countTypes(ops: readonly PresentedOperation[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const op of ops) {
    const counts = (out[op.type] ??= { create: 0, update: 0, delete: 0, truncate: 0 });
    counts[op.action] = (counts[op.action] ?? 0) + 1;
  }
  return out;
}

/** The route's `rows` block in the SDK's key spelling. */
export function presentRows(rows: unknown): Record<string, unknown> | undefined {
  if (rows === null || typeof rows !== "object" || Array.isArray(rows)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rows as Record<string, unknown>)) {
    out[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return out;
}

/**
 * An engine sentence (`details`, `reason`) in the SDK's words, or `undefined`
 * when it cannot be shown.
 *
 * The sentences the route writes today are each said again here: the flags as
 * the author types them, and a tenant named as a tenant. Anything else is shown
 * as written when it names no wire flag or internal identifier, and withheld
 * when it does — `details` and `reason` are commentary on an operation whose
 * type, name and action are still there.
 */
export function sdkWords(
  text: string | undefined,
  target: TargetNoun,
  /** For a prune's delete: what the project's records say about the object. */
  provenance?: DeleteProvenance,
  /** For a replace's ROW LOSS: where the archive came from and whether it carries rows. */
  rows?: PlanRows,
  /**
   * The operation the sentence is attached to: a replace's ROW LOSS on a
   * `delete` is a table not re-created; `recreate` is a delete the same plan
   * creates again (the archive carries it), worded as re-created.
   */
  action?: string,
): string | undefined {
  if (text === undefined || text === "") return undefined;
  const known = KNOWN_SENTENCES.find(([match]) => match.test(text));
  if (known !== undefined) return known[1](target, provenance, rows, action);
  return ENGINE_VOCABULARY.test(text) ? undefined : text;
}

/** What a replace brings back, by where the archive came from and whether it carries rows. */
function recreated(rows: PlanRows | undefined): string {
  const source = rows?.source ?? "project";
  const carried = rows?.carried ?? true;
  if (source === "bundle") {
    return carried
      ? "The bundle's tables are re-created with the rows it carries; anything it does not carry is gone."
      : "The bundle carries no rows — every table comes back empty.";
  }
  return carried
    ? "This project's own tables are re-created with its seed rows; anything it does not declare is gone."
    : "This project's own tables are re-created empty — this deploy carries no seed rows; anything it does not declare is gone.";
}

/** A table the replace drops and nothing re-creates: the archive does not carry it. */
function notRecreated(rows: PlanRows | undefined): string {
  return (rows?.source ?? "project") === "bundle"
    ? "The bundle does not carry this table, so it is dropped, not re-created."
    : "This project does not declare this table, so it is dropped, not re-created.";
}

/** Wire flags and internal identifiers: `mode=replace`, `delete=true`, `obj_type`, `ns:op_name`. */
const ENGINE_VOCABULARY = /\b(?:mode|delete|records|truncate)=|\bobj_type\b|\b[a-z]+:[a-z_]+\b/;

/**
 * Each sentence the route writes, recognised by what it says, and said again.
 * Ordered most specific first — the replace variants of a sentence extend the
 * merge one.
 */
const KNOWN_SENTENCES: ReadonlyArray<
  readonly [RegExp, (target: string, provenance?: DeleteProvenance, rows?: PlanRows, action?: string) => string]
> = [
  [
    /^Workspace settings and environment variables will be updated from the archive, and the workspace will be CLEARED/,
    (t) => `Settings are updated from the archive, after the ${t} is CLEARED`,
  ],
  [/^Workspace settings and environment variables will be updated from the archive/, () => "Settings are updated from the archive"],
  [/^mode=replace wipes the destination workspace/, (t) => `\`--replace\` clears the ${t} before importing`],
  [
    /^Will be created: no object in this workspace carries the archive's guid/,
    (t) => `Created: nothing in the ${t} carries this object's identity`,
  ],
  [/^Will be deleted by the workspace clear that mode=replace performs/, () => "Deleted by the clear `--replace` runs before importing"],
  [
    /^Will be deleted: the archive does not carry this object and delete=true/,
    (_t, provenance) => `Deleted: ${whyPruned(provenance)}, and \`--prune\` removes what the project omits`,
  ],
  [
    /^ROW LOSS: mode=replace drops every table/,
    (t, _provenance, rows, action) =>
      `ROW LOSS: \`--replace\` drops every table in the ${t} before importing, destroying its rows. ` +
      // On a table being DELETED — one the archive does not carry — nothing
      // brings it back; "every table comes back empty" described a table that
      // does not come back at all.
      (action === "delete" ? notRecreated(rows) : recreated(rows)),
  ],
  [
    /^ROW LOSS: this table is deleted because the archive does not carry it/,
    (_t, provenance) =>
      `ROW LOSS: \`--prune\` deletes this table because ${whyPruned(provenance)}, and its rows ` +
      "go with it. Leaving out `--seed` does NOT protect them. Nothing in this deploy restores them.",
  ],
  [
    /^truncate=true empties the tables the archive carries, and records=true/,
    () => "`--reset-data` empties the tables this project declares, and `--seed` then loads its seed rows into them",
  ],
  [
    /^truncate=true empties the tables the archive carries/,
    () => "`--reset-data` empties the tables this project declares, and without `--seed` nothing is loaded back",
  ],
  [
    /^Matched by obj_type, not by guid/,
    (t) =>
      `Matched as the ${t}'s one error trigger rather than by identity, which the import replaces with ` +
      `the ${t}'s own. It is updated in place, not replaced.`,
  ],
];

/**
 * Why a prune deletes an object, worded by what the records show. "No longer
 * declares it" is said only of what the records say this project had: said of
 * another project's table it was false, and read as this project's own doing.
 */
function whyPruned(provenance: DeleteProvenance | undefined): string {
  switch (provenance) {
    case "landed":
      return "this project no longer declares it";
    case "adopted":
      return "it was adopted by `lock import`, not declared by this project";
    case "locked":
      return "this project no longer declares it, though it never landed it here — it may be another project's of the same name";
    case "never":
      return "this project never declared it — it is another project's or was made by hand";
    default:
      return "this project does not declare it";
  }
}
