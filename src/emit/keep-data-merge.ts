/**
 * The merge half of `deploy --keep-data`, shared by the ephemeral and the
 * local arms: preview what the merge drops, then apply it, through the
 * route that can prove it merged.
 *
 * ## Why the SDK import route and not the general one
 *
 * The general-purpose import resolves a name collision by inventing `<name>_01`
 * and answering 200, and an instance that predates merge ignores `mode=merge`,
 * full-replaces, and still answers 200. Both are silent data loss or silent
 * duplication — the one outcome a flag named "keep data" must not have. The SDK
 * route refuses a collision by name and fails closed on a response it cannot
 * verify, so its presence is the capability and nothing here falls back.
 *
 * ## Never a replace after a failed merge
 *
 * Whatever happens below, this never retries as a replace: that would empty the
 * tables the caller asked to keep. A refusal (the route declined; nothing was
 * written) says the data is intact. A transport failure on the apply keeps the
 * transport's own aftermath wording, because the write may have committed and
 * "intact" would be a guess.
 *
 * Node-only, lazily imported by the command layer.
 */
import type { BearerTarget } from "../auth/token.js";
import type { SourceKind } from "./source-selector.js";
import { renderSlugSteps, slugMoveSteps, type SlugMove, type SlugStep } from "./canonical-steps.js";
import { encodeWorkspaceArchive, type ArchiveEntry } from "../validate/archive.js";
import { seedRowsByTableGuid, type SeedContentFile } from "../workspace/seed.js";
import {
  detectXanoSdkImportRoute,
  xanosdkImport,
  XanoSdkImportRefusal,
  XANOSDK_IMPORT_UNIQUENESS_CODE,
  type ImportOperation,
  type XanoSdkCanonicalReport,
  type XanoSdkImportConflict,
} from "../deploy/xanosdk-import.js";
import { exportWorkspaceBundle } from "../deploy/workspace-export.js";
import {
  diffAgainstLive,
  storedColumnsAfter,
  type StoredColumnTypes,
  tableAdditions,
  payloadOf,
  planTypeSection,
  rowLabeler,
  sectionKind,
  type IndexChange,
  type LiveDiff,
  type RetypedColumn,
  type NarrowedEnum,
  type RetargetedRef,
  type TightenedColumn,
} from "../deploy/live-diff.js";
import { detail, warn, withSpinner } from "./ui.js";
import {
  assertStorageModesKept,
  discloseTableEffects,
  droppedAndAdded,
  tableEffectFields,
  tableEffectsOf,
  type PairedColumns,
} from "./plan-disclosure.js";
import { tableRowCounter } from "../deploy/table.js";
import { CliError } from "./errors.js";
import { shellQuote } from "../util/shell-quote.js";
import { shellWord } from "./command-line.js";
import { displayPath } from "../util/rel-path.js";
import { LOCK_PAYLOAD_KEYS, type CodePinnedTable } from "../lock/lock.js";
import { UNTRUSTED_CERTIFICATE } from "../util/http.js";

/** Where the merge goes, and what it merges. */
export interface KeepDataMergeRequest {
  /** The environment's own bearer — a hosted credential or a Xano Engine's. */
  auth: BearerTarget;
  baseUrl: string;
  workspaceId: number;
  /** Human name for the environment, for errors ("ephemeral e4f2", "Xano Engine xanosdk-…"). */
  label: string;
  /** The outgoing bundle text. Packed WITHOUT seed content: a merge writes no rows. */
  bundle: string;
  /**
   * The seed content the replace arm would have sent. Read only to name the
   * tables a merge creates without seeding; never uploaded.
   */
  content: readonly SeedContentFile[];
  /**
   * Hosted-file members (`vault/…`) to pack beside the bundle. Unlike seed
   * content they ARE sent: the bundle's file library names them, and the
   * fields that point at them need the files whether or not rows are written.
   */
  files?: readonly ArchiveEntry[];
  /**
   * The guids this project's landing record names for the environment — how a
   * delete is told apart: an object the record names is one the project no
   * longer declares; any other is not this project's at all (another source
   * landed it), and the merge removes it because it mirrors this project's
   * source. Omitted where the environment is only ever this project's (a local
   * engine), so every delete is one the project no longer declares.
   */
  landedGuids?: ReadonlySet<string>;
  /**
   * Per table guid, the type each column's values are stored as, from this
   * project's landing record — what the retype notes predict inserts by.
   * Omitted (or a column missing) where it is not known, and those notes hedge.
   */
  storedColumns?: StoredColumnTypes;
  /** How to see what the environment holds after a merge whose outcome is unknown (see `XanoSdkImportTarget.stateCheck`). */
  stateCheck?: string;
  /**
   * What a printed `xanosdk env set` needs after its value to reach this
   * environment — ` --to ephemeral:<name>` plus the run's credential flags.
   */
  envSetTo?: string;
  /** Which backend kind this is, for an unreachable probe's exit-8 error. */
  kind?: "ephemeral" | "local";
  /** This run as a paste-ready rerun, and any withheld-secret note, for that error. */
  rerun?: { command: string; note: string };
  /**
   * The tables the project's lock pins, for the rename gate: a drop of a table
   * the lock still pins, beside a new table, is a rename the lock was not told
   * about. Absent where no lock was read (`--bundle`, `--no-lock`, a fetched source).
   */
  lockPins?: LockPins;
  /**
   * Guids whose public URL slug (api group, toolset or realtime server
   * `canonical`) the project pins in code. Sent with the merge, so the
   * environment serves each one as declared — re-slugging an object whose slug
   * changed — or refuses. Without them a merge keeps whatever slug each object
   * already serves.
   */
  pinned?: readonly string[];
  /**
   * `--yes`: delete what the landing record does not name without asking. The
   * merge always prunes, so this is its only opt-in for another source's objects.
   */
  allowForeignDeletes?: boolean;
  /** Ask on the terminal; absent when nobody can answer (no TTY, `--json`). */
  confirm?: (question: string) => Promise<boolean>;
  /**
   * Runs once every refusal the merge can make has passed, just before the
   * apply — where the caller commits its deferred `xano.lock` write, so a
   * refused merge (a pending rename, a collision, another source's objects)
   * leaves the lock as it found it. Awaited: an ephemeral's `--name` rename is
   * a write too, and lands here rather than before a refusal. What it returns
   * replaces `label` and `stateCheck` for the apply and its failure lines: a
   * rename here changed what the environment is called.
   */
  beforeWrite?: () => void | Partial<Pick<KeepDataMergeRequest, "label" | "stateCheck">> | Promise<void | Partial<Pick<KeepDataMergeRequest, "label" | "stateCheck">>>;
  /** Injected transport for tests. */
  fetchFn?: typeof fetch;
}

/** What {@link KeepDataMergeRequest.lockPins} carries. */
export interface LockPins {
  /** Table guid → the name its lock entry is under. */
  tables: ReadonlyMap<string, string>;
  /**
   * The paste-ready `lock rename` / `lock prune` commands for the table entry
   * `name` — the rename naming `newName` when there is exactly one candidate.
   */
  fixUps: (name: string, newName: string | undefined) => { rename: string; prune: string };
  /**
   * The same pair for any other lock entry (`app:hooks`), or `undefined` when
   * the lock has no entry under that key.
   */
  keyFixUps?: (key: string, newName: string | undefined) => { rename: string; prune: string } | undefined;
  /**
   * Every lock entry's guid by its key (`channel:collab|lobby`) — how a name
   * collision on a child is traced to the parent whose name composes its key.
   */
  entries?: ReadonlyMap<string, string>;
  /**
   * The tables whose def pins a `guid:` of its own, by name (see
   * `codePinnedTables`): a `lock rename` onto one is undone by the next
   * export, so a rename into one is fixed in the def instead.
   */
  codePinned?: ReadonlyMap<string, CodePinnedTable>;
  /**
   * The paste-ready command that drops table entry `name` — and the guids its
   * def's `guid:` replaced with it — when a dropped table holds one of those:
   * the entry is still exported, so only an identity-only prune reaches it, and
   * the next export records the def's guid again with no history.
   */
  clearReplaced?: (name: string) => string;
  /** Every guid a table entry's def replaced (its `replaced`), by the name of the entry. */
  replaced?: ReadonlyMap<string, string>;
}

/** A public URL slug the merge moves: what the object served before, and what it serves after. */
export interface CanonicalChange {
  /** The SDK kind: `apiGroup`, `mcpServer`, `agent`, `realtimeServer`. */
  kind: string;
  name: string;
  from: string;
  to: string;
}

/** What the merge found and did, for the caller's summary. */
export interface KeepDataMergeResult {
  droppedTables: string[];
  droppedColumns: string[];
  /** Each column whose type the merge changes, as the live read saw it; its values stay, unconverted. */
  retypedColumns: RetypedColumn[];
  /** Columns made nullable whose NOT NULL the merge keeps (`table.column`). */
  notNullKept: string[];
  /** Enum columns the merge keeps with values removed; a row holding one reads null. */
  narrowedEnums: NarrowedEnum[];
  /** Table references the merge points at another table; the ids rows hold are kept. */
  retargetedRefs: RetargetedRef[];
  /** Indexes the merge adds or drops. */
  indexChanges: IndexChange[];
  /** Columns the merge makes non-nullable; a row holding null reads the type's empty value. */
  notNullTightened: TightenedColumn[];
  /**
   * Every other object the merge deletes because the project no longer
   * declares it, labelled `<sdkKind>:<name>` (`query:GET ping (apiGroup shop)`).
   */
  removed: string[];
  /**
   * The live guids of what the merge deletes that this project landed (its
   * dropped tables and removed objects) — the identities a caller drops from
   * the lock's `objects`, as a prune's are.
   */
  removedGuids: string[];
  /**
   * Of `droppedTables` (as `table:<name>`) and `removed`, the ones this
   * project's landing record does not name — not this project's objects, removed
   * because a keep-data merge mirrors this project's source. Empty without a record.
   */
  notLanded: string[];
  unseededTables: string[];
  /** Tables the merge renames in place (guid matched, name changed) — rows kept. */
  renamedTables: { from: string; to: string }[];
  keptEnv: string[];
  /** Workspace documentation fields the merge leaves as they are live. */
  unappliedDocumentation: ("require_token" | "token")[];
  /**
   * Public URL slugs the merge moves — a pinned `canonical` changed in code.
   * Every endpoint under the old slug stops answering.
   */
  canonicalChanges: CanonicalChange[];
  /**
   * Tables the merge drops columns from and adds others to — what reads as a
   * rename and is not one: the dropped values are destroyed, the added start empty.
   */
  pairedColumns: PairedColumns[];
  /**
   * Per table guid, the column storage known once the merge landed — what the
   * landing record keeps for the next merge's retype notes. Set only by a merge
   * that applied.
   */
  storedColumns?: Map<string, Record<string, string>>;
}

/** The server's kind for a table in a plan operation. */
const TABLE_KINDS = new Set(["table", "dbo"]);

/**
 * The target has no SDK import route — and nothing was sent. Cause and fix.
 *
 * No "drop `--keep-data`" advice: a replacing deploy goes through the same
 * route, so it would fail on this environment the same way. The only fix is a
 * newer environment.
 */
export function cannotMergeError(label: string): Error {
  return new Error(
    `\`--keep-data\` cannot keep ${label}'s rows: this environment predates the SDK import route, ` +
      `which every deploy writes through. Nothing was sent, and its data is untouched.\n` +
      `Update it: \`xanosdk local update\` for a Xano Engine, or update the Xano instance ` +
      `behind an ephemeral environment. Dropping \`--keep-data\` will not help — a replacing ` +
      `deploy uses the same route.`,
  );
}

/**
 * The capability probe got no answer — a network failure, before anything was
 * sent: exit 8 with the exact rerun, as a lookup that got none says it (E2E
 * pass 24: exit 1, "retry the deploy"). Any other probe failure (an answer it
 * could not decide on) passes through as it is.
 */
export async function unreachableProbeError(
  err: unknown,
  req: Pick<KeepDataMergeRequest, "label" | "rerun"> & { kind?: SourceKind },
): Promise<unknown> {
  const reach = err instanceof Error ? /: could not reach it \((.*)\)\.\n/.exec(err.message) : null;
  // A server error (5xx) or the rate limit (429) is no answer either (E2E pass 28: a 502/503 exited 1).
  const status = (err as { status?: unknown } | null)?.status;
  const answered = err instanceof Error ? /: the probe answered (.*)\n/.exec(err.message) : null;
  // Except 501, which is an answer: this backend does not implement the
  // merge, and running the same command again gets the same one. The way on is
  // a deploy that does not keep the data.
  if (status === 501 && answered !== null) {
    const label = `${req.label[0]!.toUpperCase()}${req.label.slice(1)}`;
    const replace =
      req.rerun === undefined
        ? "deploy without `--keep-data`"
        : `\`${req.rerun.command.split(" ").filter((w) => w !== "--keep-data").join(" ")}\``;
    return new Error(
      `${label} answered the check whether it can merge with ${answered[1]!.replace(/\.$/, "")}: it does not support ` +
        `a \`--keep-data\` merge. Nothing was sent, and its data is untouched. To deploy anyway, ${replace} — a ` +
        `replace, which also replaces its rows with the seed rows.${req.rerun?.note ?? ""}`,
    );
  }
  const serverError = typeof status === "number" && (status >= 500 || status === 429) && answered !== null;
  if ((reach === null && !serverError) || req.rerun === undefined) return err;
  const { LookupFailedError, rateLimitedCause } = await import("./source-resolve.js");
  const failed = new LookupFailedError(
    reach !== null
      ? `Could not reach ${req.label} to ask whether it can merge (${reach[1]}). ` +
          `${reach[1]!.includes(UNTRUSTED_CERTIFICATE) ? "A certificate problem" : "A network failure"} — nothing was ` +
          `sent and its data is untouched`
      : `${req.label[0]!.toUpperCase()}${req.label.slice(1)} answered the check whether it can merge with ${status === 429 ? "its rate limit" : "a server error"} ` +
          `(${answered![1]!.replace(/\.$/, "")}). ${status === 429 ? `${rateLimitedCause()}: nothing` : "Nothing"} was sent and its data is untouched`,
    "unreachable",
    req.kind ?? "ephemeral",
    `run \`${req.rerun.command}\` again`,
    status === 429 ? "Once the wait is over" : undefined,
  );
  failed.message += req.rerun.note;
  return failed;
}

/**
 * A READ on the way to the merge — the live read, or the dry run — that got no
 * answer: a network failure or a server error (5xx). Nothing has been written
 * yet, so it is exit 8 with the exact rerun, as the probe's is (E2E pass 29: a
 * 503 on either exited 1, "live read failed (503 ): injected", no rerun). Any
 * other failure passes through as it is, as does one with no rerun to print.
 */
export async function unansweredReadError(
  err: unknown,
  req: Pick<KeepDataMergeRequest, "kind" | "rerun">,
): Promise<unknown> {
  if (req.rerun === undefined) return err;
  const { LookupFailedError, isRateLimited, isServerError, isTransportFailure, unansweredCause } = await import("./source-resolve.js");
  const transport = isTransportFailure(err);
  if (!transport && !isServerError(err)) return err;
  // Only the failure's first line: a transport error's own aftermath ("retry
  // when…") is replaced by the one this error states.
  const first = ((err instanceof Error ? err.message : String(err)).trim().split("\n")[0] ?? "").replace(/[.:]$/, "");
  const failed = new LookupFailedError(
    `${first[0]?.toUpperCase() ?? ""}${first.slice(1)}. ${unansweredCause(err)} — ` +
      `nothing was written and its data is untouched`,
    "unreachable",
    req.kind ?? "ephemeral",
    `run \`${req.rerun.command}\` again`,
    isRateLimited(err) ? "Once the wait is over" : undefined,
  );
  failed.message += req.rerun.note;
  return failed;
}

/** The exit code of a refusal that names a state conflict: running it again changes nothing. */
const EXIT_CONFLICT = 2;

/**
 * The details every keep-data refusal carries, every key present, so a
 * wrapper reads `details.refused` and the list that goes with it.
 */
function refusalDetails(
  refused: "identityConflict" | "renamePending" | "pruneOutOfScope" | "uniqueViolation",
  lists: {
    conflicts?: readonly unknown[];
    renames?: readonly unknown[];
    outOfScope?: readonly OutOfScopeObject[];
    serverCode?: string;
  },
): Record<string, unknown> {
  return {
    refused,
    ...(lists.serverCode === undefined ? {} : { serverCode: lists.serverCode }),
    conflicts: lists.conflicts ?? [],
    renames: lists.renames ?? [],
    outOfScope: lists.outOfScope ?? [],
  };
}

/**
 * The route declined the merge and wrote nothing.
 *
 * Deploy-specific rather than release's rendering: release's advice is about
 * the lock and the workspace's history, and here the environment is this
 * project's own, so the useful remedy is the one that rebuilds it. A refusal
 * naming collisions is an identity conflict — `SDK_IDENTITY_CONFLICT`, exit 2,
 * each under `details.conflicts` (E2E pass 25: `SDK_ERROR`, exit 1, no
 * details); any other stays as the route said it.
 */
/** Exit code of a failure worth running again unchanged: nothing was written, and the cause is transient. */
const EXIT_TRANSIENT = 8;

/**
 * The destination was busy with another import — the one refusal that is
 * transient: nothing was written, and the same command run again in a moment
 * goes through. Exit 8 with that command, never a remedy that changes anything
 * (least of all a `--reset`). The server's own sentence is not quoted: it
 * repeats "nothing written" and states a scope wider than the collisions
 * measured (two deploys into one environment collide; into two do not). Shared
 * by every import path: the merge, the replace, and `deploy --to`.
 */
export function importInProgressError(label: string, rerun: { command: string; note: string } | undefined, refusal: XanoSdkImportRefusal): CliError {
  const again = rerun === undefined ? "run the same command again" : `run \`${rerun.command}\` again`;
  return new CliError(
    "SDK_IMPORT_REFUSED",
    `${label.charAt(0).toUpperCase()}${label.slice(1)} was busy with another import, so this one did not start.\n` +
      `Nothing was written — its data is intact, and nothing in the project has to change: ${again} in a moment.${rerun?.note ?? ""}`,
    {
      exitCode: EXIT_TRANSIENT,
      details: { refused: "importInProgress", landed: false, serverCode: refusal.code, ...(rerun === undefined ? {} : { rerun: rerun.command }) },
    },
  );
}

function refusedError(
  label: string,
  refusal: XanoSdkImportRefusal,
  indexChanges: readonly IndexChange[] = [],
  rerun?: { command: string; note: string },
): Error {
  if (refusal.retryable) return importInProgressError(label, rerun, refusal);
  const conflicts = refusal.conflicts.map(
    (c) => `  ${c.kind} "${c.identity}"${c.owner.guid === undefined ? "" : ` (held by guid ${c.owner.guid})`}`,
  );
  // The route's uniqueness refusal names no table; the unique indexes this
  // merge adds are what it can be about (E2E pass 33).
  const uniqueAdds = indexChanges.filter((c) => c.action === "add" && c.unique);
  const unique =
    refusal.code === XANOSDK_IMPORT_UNIQUENESS_CODE && uniqueAdds.length > 0
      ? `The merge adds ${uniqueAdds.length === 1 ? "a unique index" : "unique indexes"} the rows already there may ` +
        `hold duplicates for:\n${uniqueAdds.map((c) => `  table ${c.table}: ${c.index}`).join("\n")}\n` +
        `Remove the duplicate rows or the index.\n`
      : "";
  const message =
    `${label} refused the merge: ${refusal.reason}\n` +
    (conflicts.length > 0 ? `${conflicts.join("\n")}\n` : "") +
    unique +
    `Nothing was written — the environment's data is intact.\n` +
    `Fix what it names and deploy again, or rebuild the environment from the project with ` +
    `\`${rerun === undefined ? "xanosdk deploy --keep-data --reset" : withFlag(rerun.command, "--reset")}\` ` +
    `(that replaces its rows with the seed rows).${rerun?.note ?? ""}`;
  if (refusal.code === XANOSDK_IMPORT_UNIQUENESS_CODE) {
    const err = new CliError("SDK_IMPORT_REFUSED", message, {
      exitCode: EXIT_CONFLICT,
      details: {
        ...refusalDetails("uniqueViolation", { serverCode: refusal.code }),
        landed: false,
        indexes: uniqueAdds.map((c) => ({ table: c.table, index: c.index })),
      },
    });
    return Object.assign(err, { cause: refusal });
  }
  if (refusal.conflicts.length === 0) return new Error(message, { cause: refusal });
  const err = new CliError("SDK_IDENTITY_CONFLICT", message, {
    exitCode: EXIT_CONFLICT,
    details: refusalDetails("identityConflict", {
      serverCode: refusal.code,
      conflicts: refusal.conflicts.map((c) => ({
        kind: sectionKind(planTypeSection(c.kind)),
        name: c.identity,
        liveGuid: c.owner.guid ?? null,
        projectGuid: c.archiveGuid ?? null,
      })),
    }),
  });
  return Object.assign(err, { cause: refusal });
}

/** A table trigger the environment holds, by name and the table it watches. */
export interface LiveTableTrigger {
  name: string;
  /** The watched table's live name, or its guid when the read does not carry the table. */
  table: string;
}

/** The table triggers a live read holds (`obj_type: "database"`). */
export function liveTableTriggers(live: unknown): LiveTableTrigger[] {
  const tables = new Map<string, string>();
  for (const row of payloadRows(live, "dbo")) {
    if (typeof row.guid === "string" && typeof row.name === "string") tables.set(row.guid, row.name);
  }
  return payloadRows(live, "trigger")
    .filter((row) => row.obj_type === "database")
    .map((row) => {
      const table = typeof row.obj_id === "string" ? row.obj_id : "";
      return { name: typeof row.name === "string" ? row.name : "", table: tables.get(table) ?? table };
    });
}

/**
 * A merge into a tenant-hosted environment (an ephemeral or a tenant) that
 * holds a table trigger fails there: the instance answers 500, and part of the
 * merge may already have landed. A replace succeeds, and so does a merge into a
 * workspace. So the merge is refused before anything is sent — exit 2, a state
 * conflict: running it again unchanged refuses again.
 *
 * `remedy` is the paste-ready replace for where the user typed: `--reset` on a
 * `deploy --keep-data`, `--replace` on a `deploy --to`.
 */
export function tableTriggerMergeError(
  label: string,
  triggers: readonly LiveTableTrigger[],
  remedy: { command: string; note: string },
): CliError {
  const one = triggers.length === 1;
  const lines = triggers.map((t) => `  ${t.name} (table ${t.table})`);
  return new CliError(
    "SDK_IMPORT_REFUSED",
    `${label.charAt(0).toUpperCase()}${label.slice(1)} was not merged: it holds ${one ? "a table trigger" : `${triggers.length} table triggers`}, and a merge ` +
      `into an ephemeral or a tenant fails while one is there (the instance answers 500, after part of the merge ` +
      `may have landed):\n${lines.join("\n")}\n` +
      `Nothing was written — the environment's data is intact. Removing the trigger from the project does not ` +
      `help while the environment holds it. A replace works; it replaces the rows with the seed rows: ` +
      `\`${remedy.command}\`.${remedy.note}`,
    {
      exitCode: EXIT_CONFLICT,
      details: { refused: "tableTrigger", landed: false, triggers: triggers.map((t) => ({ ...t })) },
    },
  );
}

/** One object the environment holds under a name the project sends under another guid. */
interface NameCollision {
  kind: string;
  name: string;
  liveGuid: string | null;
  projectGuid: string | null;
}

/**
 * The same-name, different-guid collisions the preview can see and the route's
 * dry run does not: the plan deletes an object and creates one of the same kind
 * and name, because a merge matches on guid — and the apply then refuses the
 * create by name (E2E pass 25: the preview printed "DROP things" and "new table
 * things", and only the write refused). Matched through the labels every report
 * uses, so two endpoints sharing a path under different verbs are not one.
 */
function nameCollisions(operations: readonly ImportOperation[], live: unknown, outgoing: unknown): NameCollision[] {
  const deleted = new Set(operations.filter((o) => o.action === "delete").map((o) => `${o.type}\0${o.name}`));
  const pairs = operations.filter((o) => o.action === "create" && deleted.has(`${o.type}\0${o.name}`));
  if (pairs.length === 0) return [];
  const liveLabel = rowLabeler(payloadOf(live));
  const outLabel = rowLabeler(payloadOf(outgoing));
  const guids = (rows: Record<string, unknown>[]) => new Set(rows.map((r) => r.guid));
  const out: NameCollision[] = [];
  for (const op of pairs) {
    const section = planTypeSection(op.type);
    const liveRows = payloadRows(live, section);
    const outRows = payloadRows(outgoing, section);
    const liveGuids = guids(liveRows);
    const outGuids = guids(outRows);
    const gone = liveRows.filter((r) => r.name === op.name && !outGuids.has(r.guid));
    for (const row of outRows.filter((r) => r.name === op.name && !liveGuids.has(r.guid))) {
      const label = outLabel(section, row);
      const held = gone.find((g) => liveLabel(section, g) === label);
      if (held === undefined) continue;
      out.push({
        kind: sectionKind(section, row),
        name: label.slice(label.indexOf(":") + 1),
        liveGuid: typeof held.guid === "string" ? held.guid : null,
        projectGuid: typeof row.guid === "string" ? row.guid : null,
      });
    }
  }
  return out;
}

function collisionError(label: string, collisions: readonly NameCollision[], resetRerun: string): CliError {
  const one = collisions.length === 1;
  const lines = collisions.map(
    (c) => `  ${c.kind} "${c.name}" — live guid ${c.liveGuid ?? "unknown"}, the project's ${c.projectGuid ?? "unknown"}`,
  );
  return new CliError(
    "SDK_IDENTITY_CONFLICT",
    `${label} cannot merge: it holds ${one ? "an object" : "objects"} under ${one ? "a name" : "names"} the project ` +
      `sends under another identity. A merge matches on guid, so it would delete the live one and create the ` +
      `project's beside it, which the environment refuses by name:\n${lines.join("\n")}\n` +
      `Nothing was written — the environment's data is intact.\n` +
      `Rebuild the environment from the project with \`${resetRerun}\` (that replaces its rows with the seed rows), ` +
      `or give one of ${one ? "the two" : "each pair"} another name.`,
    { exitCode: EXIT_CONFLICT, details: refusalDetails("identityConflict", { conflicts: collisions }) },
  );
}

/**
 * The lock payload keys whose names compose a child's key, nearest first: a
 * realtime message is keyed `message:<server>|<channel>|<name>`, an endpoint
 * `query:<group>|<VERB>|<path>`.
 */
const COMPOSING_PARENTS: Readonly<Record<string, readonly string[]>> = {
  message: ["channel", "realtime_server"],
  channel: ["realtime_server"],
  query: ["app"],
};

/** A parent renamed in code while xano.lock still pins its old name, and the children that collide because of it. */
interface ParentRename {
  /** The SDK kind (`realtimeChannel`). */
  kind: string;
  /** Its name as the lock keys it (`collab|lobby`). */
  name: string;
  guid: string;
  /** The lock names of the same kind new to this environment — its new name, if it was renamed. */
  candidates: string[];
  rename: string;
  children: NameCollision[];
  /** The entry is the colliding object's own, not a parent's: its key moved with a parent's name the lock no longer pins. */
  self?: true;
}

/**
 * Collisions a parent rename the lock was not told about explains. A child's
 * key composes its parent's name, so renaming a realtime channel in code gives
 * each of its messages a new identity under the same name — and the merge then
 * deletes the live message and creates the project's beside it, which the
 * environment refuses by name (E2E pass 36: `realtimeMessage "chat"` refused,
 * with `--reset` as the only remedy, for a channel rename). The parent's
 * `lock rename` moves the children's entries with it, and the merge then
 * renames the parent in place.
 */
function parentRenames(
  collisions: readonly NameCollision[],
  live: unknown,
  outgoing: unknown,
  pins: LockPins | undefined,
): ParentRename[] {
  const entries = pins?.entries;
  if (entries === undefined || pins?.keyFixUps === undefined) return [];
  const keyOf = new Map<string, string>();
  for (const [key, guid] of entries) keyOf.set(guid, key);
  const guidsIn = (bundle: unknown, section: string) =>
    new Set(payloadRows(bundle, section).map((r) => r.guid).filter((g): g is string => typeof g === "string"));
  const out = new Map<string, ParentRename>();
  for (const collision of collisions) {
    const key = collision.liveGuid === null ? undefined : keyOf.get(collision.liveGuid);
    if (key === undefined) continue;
    const sep = key.indexOf(":");
    const parts = key.slice(sep + 1).split("|");
    let found: { section: string; name: string; guid: string } | undefined;
    for (let n = parts.length - 1; n >= 1 && found === undefined; n--) {
      const name = parts.slice(0, n).join("|");
      for (const section of COMPOSING_PARENTS[key.slice(0, sep)] ?? []) {
        const guid = entries.get(`${section}:${name}`);
        // Renamed: the environment holds it, and the project no longer sends it.
        if (guid === undefined || !guidsIn(live, section).has(guid) || guidsIn(outgoing, section).has(guid)) continue;
        found = { section, name, guid };
        break;
      }
    }
    if (found === undefined) continue;
    const parentKey = `${found.section}:${found.name}`;
    const existing = out.get(parentKey);
    if (existing !== undefined) {
      existing.children.push(collision);
      continue;
    }
    // The same kind, under the same grandparent, new to this environment.
    const scope = found.name.includes("|") ? found.name.slice(0, found.name.lastIndexOf("|") + 1) : "";
    const liveGuids = guidsIn(live, found.section);
    const sent = guidsIn(outgoing, found.section);
    const candidates = [...entries]
      .filter(([k, g]) => k.startsWith(`${found.section}:${scope}`) && sent.has(g) && !liveGuids.has(g))
      .map(([k]) => k.slice(found.section.length + 1))
      .filter((name) => scope === "" ? !name.includes("|") : !name.slice(scope.length).includes("|"));
    const fix = pins.keyFixUps(parentKey, candidates.length === 1 ? candidates[0] : undefined);
    if (fix === undefined) continue;
    out.set(parentKey, {
      kind: sectionKind(found.section),
      name: found.name,
      guid: found.guid,
      candidates,
      rename: fix.rename,
      children: [collision],
    });
  }
  // A child whose own entry is left under a parent name the lock no longer
  // pins — a channel renamed with `lock rename` and then renamed back drops
  // the channel's stale entry, while a message added in between stays keyed
  // under the name it was added under. The project sends that message under a
  // new identity; the entry's own `lock rename` gives it back.
  const explained = new Set([...out.values()].flatMap((p) => p.children));
  for (const collision of collisions) {
    if (explained.has(collision) || collision.liveGuid === null || collision.projectGuid === null) continue;
    const key = keyOf.get(collision.liveGuid);
    const target = keyOf.get(collision.projectGuid);
    if (key === undefined || target === undefined || key === target) continue;
    const section = key.slice(0, key.indexOf(":"));
    if (!target.startsWith(`${section}:`) || guidsIn(outgoing, section).has(collision.liveGuid)) continue;
    const name = key.slice(section.length + 1);
    const newName = target.slice(section.length + 1);
    const fix = pins.keyFixUps(key, newName);
    if (fix === undefined) continue;
    out.set(key, {
      kind: sectionKind(section),
      name,
      guid: collision.liveGuid,
      candidates: [newName],
      rename: fix.rename,
      children: [collision],
      self: true,
    });
  }
  return [...out.values()];
}

function parentRenameError(
  label: string,
  parents: readonly ParentRename[],
  collisions: readonly NameCollision[],
  resetRerun: string,
): CliError {
  const explained = new Set(parents.flatMap((p) => p.children));
  const others = collisions.filter((c) => !explained.has(c));
  const collisionLine = (c: NameCollision, indent: string) =>
    `${indent}${c.kind} "${c.name}" — live guid ${c.liveGuid ?? "unknown"}, the project's ${c.projectGuid ?? "unknown"}`;
  const lines: string[] = [];
  for (const p of parents) {
    lines.push(
      `  ${p.kind} "${p.name}" (guid ${p.guid}) — xano.lock still pins it, ` +
        (p.candidates.length === 0
          ? "and the project no longer declares it"
          : `and the project now adds ${p.candidates.map((c) => `"${c}"`).join(", ")}`) +
        (p.self === true ? "; the project sends it under a new identity:" : `; what it holds took new identities with its name:`),
      ...p.children.map((c) => collisionLine(c, "    ")),
      `    renamed? run: ${p.rename}`,
    );
  }
  if (others.length > 0) lines.push(...others.map((c) => collisionLine(c, "  ")));
  const one = parents.length === 1;
  return new CliError(
    "SDK_IDENTITY_CONFLICT",
    `${label} was not merged: ${one ? "an object" : "objects"} renamed in code that xano.lock still pins under the ` +
      `old name — a rename the lock was not told about. What ${one ? "it holds is" : "they hold is"} keyed by ` +
      `${one ? "its" : "their"} name, so the merge would delete each live child and create the project's under the ` +
      `same name, which the environment refuses:\n${lines.join("\n")}\n` +
      `Nothing was written — the environment's data is intact. Run the \`lock rename\`, then deploy again: the merge ` +
      (parents.every((p) => p.self === true)
        ? `then updates ${one ? "it" : "them"} in place, keeping ${one ? "its" : "their"} identity. If`
        : `then renames ${one ? "it" : "them"} in place and what ${one ? "it holds keeps its" : "they hold keeps their"} ` +
          `identity. If`) +
      ` it was not a rename, rebuild the environment with \`${resetRerun}\` (that replaces its rows with ` +
      `the seed rows), or give one of each pair another name.`,
    {
      exitCode: EXIT_CONFLICT,
      details: refusalDetails("renamePending", {
        conflicts: collisions,
        renames: parents.map((p) => ({
          kind: p.kind,
          name: p.name,
          guid: p.guid,
          candidates: p.candidates,
          rename: p.rename,
          conflicts: p.children.map((c) => `${c.kind}:${c.name}`),
        })),
      }),
    },
  );
}

/** A dropped table the lock still pins, beside the new tables that may be its new name. */
export interface PendingRename {
  table: string;
  guid: string;
  candidates: string[];
  /** The `lock rename` — absent when every candidate pins its own guid in code ({@link setGuid}). */
  rename?: string;
  prune: string;
  /**
   * Every new table pins a `guid:` of its own in code, so a lock entry moved
   * onto it is replaced at the next export and the old table is dropped with
   * its rows: the rename is made in the def, by pinning the old guid there.
   * `table` is the one candidate, absent when there are several.
   */
  setGuid?: { table?: string; guid: string; pins: string[] };
}

/**
 * The remedy for a drop the lock still pins, when every candidate pins its own
 * guid in code — or `undefined`, when a `lock rename` can carry the identity.
 */
export function setGuidRemedy(
  guid: string,
  candidates: readonly string[],
  codePinned: ReadonlyMap<string, CodePinnedTable> | undefined,
): PendingRename["setGuid"] {
  if (codePinned === undefined || candidates.length === 0) return undefined;
  const pins = candidates.map((c) => codePinned.get(c)?.guid);
  if (pins.some((g) => g === undefined || g === guid)) return undefined;
  return { ...(candidates.length === 1 ? { table: candidates[0] } : {}), guid, pins: pins as string[] };
}

/**
 * The identity-only prune of table entry `name` — the one command that drops
 * the guids its def's `guid:` replaced, since the entry is still exported.
 */
export function clearReplacedCommand(name: string, lockPath: string): string {
  return `xanosdk lock prune --identity-only ${shellWord(`table:${name}`)} --lock=${shellWord(displayPath(lockPath))} --yes`;
}

/**
 * One pending rename as the refusal lists it: the table, then each way on.
 * `still` is what a `lock rename` would leave happening where the def pins its
 * own guid — a keep-data merge drops the table; a merge without `--prune`
 * creates the new one empty beside it.
 */
export function pendingRenameLines(
  p: PendingRename,
  still = "the table would still be dropped",
  sameName: { rebuild?: string; addFlag?: string } = {},
): string[] {
  const adds = p.candidates.map((c) => `"${c}"`).join(", ");
  if (sameNameRepin(p)) {
    // Measured (E2E pass 41): after the prune, the merge is refused by name —
    // a table cannot give way to another under its own name. A temporary name
    // splits it into a drop-and-create, then a rename by guid.
    const temp = `${p.table}_tmp`;
    const { rebuild, addFlag } = sameName;
    const deploy = addFlag === undefined ? "deploy" : `deploy with \`${addFlag}\``;
    return [
      `  table "${p.table}" (guid ${p.guid}) — its def now pins another guid (${p.setGuid!.pins[0]}) under the same ` +
        `name, and a merge cannot replace a table with another of its own name: the environment refuses it by name.`,
      `    same table? set the def of "${p.table}" back to \`guid: "${p.guid}"\` — the merge keeps it and its rows`,
      `    not wanted? run: ${p.prune} — then rename the def to "${temp}" and ${deploy} (the merge drops the old ` +
        `table with its rows and creates this one), rename it back to "${p.table}" and deploy again (the merge renames it)`,
      ...(rebuild === undefined ? [] : [`    or rebuild the environment from the project: \`${rebuild}\` (replaces every table's rows with the seed rows)`]),
    ];
  }
  if (p.setGuid === undefined) {
    return [
      `  table "${p.table}" (guid ${p.guid}) — xano.lock still pins it, and the project now adds ${adds}:`,
      `    renamed? run: ${p.rename ?? ""}`,
      `    deleted? run: ${p.prune}`,
    ];
  }
  const one = p.setGuid.table !== undefined;
  if (p.setGuid.pins.length === 0) {
    // Only a table entry's `replaced` history holds the guid: no entry pins it.
    return [
      `  table "${p.table}" (guid ${p.guid}) — xano.lock keeps it as a guid a def's \`guid:\` replaced, and the ` +
        `project now adds ${adds}:`,
      `    renamed? set ${one ? `the def of "${p.setGuid.table}"` : "the def of the table it became"} to \`guid: "${p.guid}"\``,
      `    deleted? run: ${p.prune}`,
    ];
  }
  return [
    `  table "${p.table}" (guid ${p.guid}) — xano.lock still pins it, and the project now adds ${adds}, ` +
      `${one ? `whose def pins its own guid (${p.setGuid.pins[0]})` : "each pinning its own guid in its def"}:`,
    `    renamed? set ${one ? `the def of "${p.setGuid.table}"` : "the def of the table it became"} to ` +
      `\`guid: "${p.guid}"\` — not a \`lock rename\`: the def's own guid replaces any lock entry, so ${still}`,
    `    deleted? run: ${p.prune}`,
  ];
}

/**
 * A def that pins a new guid under the name its table already has: no rename
 * is pending, and no prune lets a merge drop the old table by itself.
 */
export function sameNameRepin(p: PendingRename): boolean {
  return p.setGuid !== undefined && p.setGuid.pins.length === 1 && p.candidates.length === 1 && p.candidates[0] === p.table;
}

/** What follows the pending renames: which remedy keeps the rows. `afterPrune` ends it. */
export function pendingRenameFollowUp(all: readonly PendingRename[], afterPrune: string): string {
  const pending = all.filter((p) => !sameNameRepin(p));
  if (pending.length === 0) return "Do one, then deploy again.";
  const inCode = pending.filter((p) => p.setGuid !== undefined).length;
  const kept =
    inCode === 0
      ? "after `lock rename` the merge renames the table"
      : inCode === pending.length
        ? "with the def's `guid:` set to the old guid the merge renames the table"
        : "after `lock rename` (or, where the def pins its own guid, the def's `guid:` set to the old one) the merge renames the table";
  return `${inCode === 0 ? "Run" : "Do"} one, then deploy again: ${kept} and keeps its rows; after \`lock prune\` ${afterPrune}`;
}

/**
 * The drops that look like a rename the lock was not told about: a table the
 * lock still pins (its entry matched nothing this export — the orphan the build
 * warned about), dropped with its rows while the same merge creates a table.
 * The `lock rename` the build printed only works BEFORE the drop (E2E pass 25:
 * run after, the next merge collided by name and only `--reset` recovered).
 *
 * A table whose def pins its own guid replaced the lock entry the build read
 * for it: the guid that entry held is still the lock's, under that name.
 */
function pendingRenames(
  operations: readonly ImportOperation[],
  nameDelete: DeleteNamer,
  pins: LockPins | undefined,
): PendingRename[] {
  if (pins === undefined) return [];
  const created = operations.filter((o) => o.action === "create" && TABLE_KINDS.has(o.type)).map((o) => o.name);
  if (created.length === 0) return [];
  const replacedBy = new Map([...(pins.codePinned ?? [])].flatMap(([name, t]) => (t.replaces ?? []).map((g) => [g, name] as const)));
  const out: PendingRename[] = [];
  for (const op of operations.filter((o) => o.action === "delete" && TABLE_KINDS.has(o.type))) {
    const guid = nameDelete(op).guid;
    if (guid === undefined) continue;
    const orphan = pins.tables.get(guid);
    const pinned = orphan ?? replacedBy.get(guid) ?? pins.replaced?.get(guid);
    if (pinned === undefined) continue;
    const fix = pins.fixUps(pinned, created.length === 1 ? created[0] : undefined);
    // Held only as a guid the def replaced: its entry is still exported.
    const prune = orphan === undefined && pins.clearReplaced !== undefined ? pins.clearReplaced(pinned) : fix.prune;
    // No entry holds a guid only a `replaced` history keeps, so no `lock rename` can move it.
    const setGuid =
      setGuidRemedy(guid, created, pins.codePinned) ??
      (orphan === undefined ? { ...(created.length === 1 ? { table: created[0] } : {}), guid, pins: [] } : undefined);
    out.push({ table: op.name, guid, candidates: created, ...(setGuid === undefined ? { rename: fix.rename } : { setGuid }), prune });
  }
  return out;
}

/** A pending rename as `details.renames` carries it. */
export function pendingRenameDetail(p: PendingRename): Record<string, unknown> {
  return {
    table: p.table,
    guid: p.guid,
    candidates: [...p.candidates],
    ...(p.rename !== undefined ? { rename: p.rename } : {}),
    ...(p.setGuid !== undefined ? { setGuid: { ...p.setGuid, pins: [...p.setGuid.pins] } } : {}),
    ...(sameNameRepin(p) ? { sameName: true } : {}),
    prune: p.prune,
  };
}

function pendingRenameError(label: string, pending: readonly PendingRename[], resetRerun: string): CliError {
  const lines = pending.flatMap((p) => pendingRenameLines(p, undefined, { rebuild: resetRerun }));
  const one = pending.length === 1;
  const lead = pending.every(sameNameRepin)
    ? `${label} was not merged: ${one ? "a table's def pins" : "table defs pin"} a new guid under the name the ` +
      `table already has, and a merge matches on guid, so it would delete the old table with every row.`
    : `${label} was not merged: it would DROP ${one ? "a table" : "tables"} xano.lock still pins, with every row, ` +
      `while the project adds a new table — a rename the lock was not told about. A merge matches on guid, so ` +
      `it would delete the old table and create an empty one.`;
  return new CliError(
    "SDK_IDENTITY_CONFLICT",
    `${lead}\n${lines.join("\n")}\n` +
      `Nothing was written — the environment's data is intact. ` +
      pendingRenameFollowUp(pending, `it drops ${one ? "it" : "them"} as a deletion.`),
    {
      exitCode: EXIT_CONFLICT,
      details: refusalDetails("renamePending", { renames: pending.map(pendingRenameDetail) }),
    },
  );
}

/** The live row a canonical report entry names: by guid, else — for a live row carrying none — by name. */
function liveCanonicalRow(live: unknown, kind: string, guid: string | undefined, name: string): Record<string, unknown> | undefined {
  const rows = payloadRows(live, planTypeSection(kind));
  if (guid !== undefined) {
    const byGuid = rows.find((r) => r.guid === guid);
    if (byGuid !== undefined) return byGuid;
  }
  return rows.find((r) => r.name === name && (typeof r.guid !== "string" || r.guid === ""));
}

/** The slug a row serves, or `undefined` for none. */
function slugOf(row: Record<string, unknown> | undefined): string | undefined {
  return typeof row?.canonical === "string" && row.canonical !== "" ? row.canonical : undefined;
}

/**
 * The slugs a merge moves: each object the route serves under a slug other
 * than the one the environment serves it under now. A new object moves
 * nothing — it had no URL to lose.
 */
function canonicalChanges(canonicals: readonly XanoSdkCanonicalReport[], live: unknown): CanonicalChange[] {
  const out: CanonicalChange[] = [];
  for (const c of canonicals) {
    const row = liveCanonicalRow(live, c.kind, c.guid, c.name);
    const from = slugOf(row);
    if (row === undefined || from === undefined || c.served === undefined || c.served === from) continue;
    out.push({ kind: sectionKind(planTypeSection(c.kind), row), name: c.name, from, to: c.served });
  }
  return out;
}

/** One pinned slug the environment cannot give the object that pins it. */
interface CanonicalConflict {
  kind: string;
  name: string;
  canonical: string;
  /** The live object holding the slug, when it is in this environment and the merge deletes it. */
  heldBy?: { kind: string; name: string; guid: string | null };
  /** The holder, when it is another of this environment's objects that the project keeps and moves off the slug. */
  sibling?: { kind: string; name: string; guid: string; to: string };
  ownerGuid: string | null;
  /** The holder is in another workspace than this environment's. */
  elsewhere?: number;
  rename?: string;
}

/**
 * A pinned slug the route will not serve, as the dry run reports it. The usual
 * cause is a rename the lock was not told about: a merge matches on guid, so it
 * creates the renamed object beside the old one — which still holds the slug
 * when the new one asks for it — and then deletes the old one.
 */
function canonicalConflicts(
  conflicts: readonly XanoSdkImportConflict[],
  canonicals: readonly XanoSdkCanonicalReport[],
  operations: readonly ImportOperation[],
  live: unknown,
  pins: LockPins | undefined,
  workspaceId: number,
): CanonicalConflict[] {
  const out: CanonicalConflict[] = [];
  for (const conflict of conflicts.filter((c) => c.kind === "canonical")) {
    const wanted = canonicals.find((c) => c.guid !== undefined && c.guid === conflict.archiveGuid) ??
      canonicals.find((c) => c.outcome === "conflict" && c.requested === conflict.identity);
    const kind = wanted === undefined ? "object" : sectionKind(planTypeSection(wanted.kind));
    const name = wanted?.name ?? conflict.archiveGuid ?? conflict.identity;
    const section = wanted === undefined ? undefined : planTypeSection(wanted.kind);
    // The holder, when it is this environment's own object the merge deletes.
    const holder =
      section === undefined
        ? undefined
        : payloadRows(live, section).find(
            (r) =>
              (conflict.owner.guid !== undefined && r.guid === conflict.owner.guid) ||
              (slugOf(r) === conflict.identity && r.name !== name),
          );
    const deleted =
      holder !== undefined &&
      operations.some((o) => o.action === "delete" && planTypeSection(o.type) === section && o.name === holder.name);
    const entry: CanonicalConflict = {
      kind,
      name,
      canonical: conflict.identity,
      ownerGuid: conflict.owner.guid ?? null,
    };
    if (deleted && holder !== undefined && typeof holder.name === "string") {
      entry.heldBy = {
        kind: sectionKind(section!, holder),
        name: holder.name,
        guid: typeof holder.guid === "string" ? holder.guid : (conflict.owner.guid ?? null),
      };
      const fix = pins?.keyFixUps?.(`${section}:${holder.name}`, name);
      if (fix !== undefined) entry.rename = fix.rename;
    } else if (conflict.owner.workspaceId !== workspaceId) {
      entry.elsewhere = conflict.owner.workspaceId;
    } else {
      // The holder is an object the project declares too, moving off the slug.
      const kept = canonicals.find(
        (c) => c.guid !== undefined && c.guid === conflict.owner.guid && c.guid !== conflict.archiveGuid,
      );
      if (kept?.guid !== undefined && kept.requested !== undefined && kept.requested !== conflict.identity) {
        const row = liveCanonicalRow(live, kept.kind, kept.guid, kept.name);
        entry.sibling = { kind: sectionKind(planTypeSection(kept.kind), row), name: kept.name, guid: kept.guid, to: kept.requested };
      }
    }
    out.push(entry);
  }
  return out;
}

/**
 * The deploys that move the slugs when every conflict is a slug changing hands
 * between this environment's own objects (see {@link slugMoveSteps}).
 */
function siblingSlugSteps(
  conflicts: readonly CanonicalConflict[],
  canonicals: readonly XanoSdkCanonicalReport[],
  live: unknown,
): SlugStep[] | undefined {
  if (conflicts.length === 0 || conflicts.some((c) => c.sibling === undefined)) return undefined;
  const held = new Map<string, string>();
  for (const section of new Set(["app", ...canonicals.map((c) => planTypeSection(c.kind))])) {
    for (const row of payloadRows(live, section)) {
      const slug = slugOf(row);
      if (slug !== undefined && typeof row.guid === "string") held.set(slug, row.guid);
    }
  }
  const moves: SlugMove[] = [];
  for (const c of canonicals) {
    if (c.guid === undefined || c.requested === undefined) continue;
    const row = liveCanonicalRow(live, c.kind, c.guid, c.name);
    const from = slugOf(row);
    if (from === c.requested) continue;
    moves.push({ kind: sectionKind(planTypeSection(c.kind), row), name: c.name, guid: c.guid, from, to: c.requested });
  }
  return slugMoveSteps(moves, held);
}

function canonicalConflictError(
  label: string,
  conflicts: readonly CanonicalConflict[],
  resetRerun: string,
  steps: { list: readonly SlugStep[]; rerun: string } | undefined,
): CliError {
  const lines: string[] = [];
  for (const c of conflicts) {
    if (c.sibling !== undefined) {
      lines.push(
        `  ${c.kind} "${c.name}" pins canonical "${c.canonical}", which ${c.sibling.kind} "${c.sibling.name}" of this ` +
          `environment serves now and this deploy moves to "${c.sibling.to}".`,
      );
    } else if (c.heldBy !== undefined) {
      lines.push(
        `  ${c.kind} "${c.name}" pins canonical "${c.canonical}", which ${c.heldBy.kind} "${c.heldBy.name}" serves — ` +
          `the merge would create "${c.name}" beside it and delete "${c.heldBy.name}" after, so the slug is not free when it is asked for.`,
      );
      if (c.rename !== undefined) lines.push(`    renamed? run: ${c.rename}`);
    } else {
      lines.push(
        `  ${c.kind} "${c.name}" pins canonical "${c.canonical}", which ` +
          (c.elsewhere === undefined
            ? "another object in this environment serves"
            : `an object in workspace ${c.elsewhere} on the same backend serves`) +
          `${c.ownerGuid === null ? "" : ` (guid ${c.ownerGuid})`}.`,
      );
    }
  }
  const renames = conflicts.some((c) => c.rename !== undefined);
  return new CliError(
    "SDK_IDENTITY_CONFLICT",
    `${label} was not merged: ${conflicts.length === 1 ? "a public URL slug" : "public URL slugs"} the project pins ` +
      `cannot be served as declared:\n${lines.join("\n")}\n` +
      `Nothing was written — the environment's data is intact.\n` +
      (steps !== undefined
        ? `One deploy cannot hand a slug from one object to another: each pinned slug is checked against what the ` +
          `environment serves when the deploy starts. Move them in ${steps.list.length} deploys, each keeping the data:\n` +
          renderSlugSteps(steps.list, steps.rerun).join("\n")
        : renames
        ? "If it is a rename, run the `lock rename` and deploy again: the merge then renames the object in place and " +
          "it keeps its URL. If not, pick another `canonical`, or rebuild the environment with " +
          `\`${resetRerun}\` (that replaces its rows with the seed rows).`
        : `Pick another \`canonical\`, or — when the holder is this environment's own object — rebuild the ` +
          `environment with \`${resetRerun}\` (that replaces its rows with the seed rows).`),
    {
      exitCode: EXIT_CONFLICT,
      details: {
        ...refusalDetails("identityConflict", {
          conflicts: conflicts.map((c) => {
            const holder = c.sibling ?? c.heldBy;
            return {
              kind: c.kind,
              name: c.name,
              canonical: c.canonical,
              liveGuid: holder?.guid ?? c.ownerGuid,
              ...(holder === undefined ? {} : { heldBy: `${holder.kind}:${holder.name}` }),
              ...(c.rename === undefined ? {} : { rename: c.rename }),
            };
          }),
        }),
        ...(steps === undefined
          ? {}
          : {
              steps: steps.list.map((step) => ({
                set: step.map((o) => ({ object: `${o.kind}:${o.name}`, canonical: o.slug, why: o.why })),
                run: steps.rerun,
              })),
            }),
      },
    },
  );
}

/**
 * A merge that landed without serving a pinned slug as declared. The route
 * serves a pin or refuses the whole import, so this is a route that broke that
 * contract — said, with what each object serves now, never reported as a
 * refreshed environment.
 */
function canonicalNotServedError(label: string, missed: readonly XanoSdkCanonicalReport[], resetRerun: string): CliError {
  const lines = missed.map(
    (c) =>
      `  ${sectionKind(planTypeSection(c.kind))} "${c.name}" — pinned "${c.requested ?? ""}", serves ` +
      `${c.served === undefined ? "a slug the environment chose" : `"${c.served}"`} (${c.outcome})`,
  );
  return new CliError(
    "SDK_ERROR",
    `${label} merged, but ${missed.length === 1 ? "a pinned public URL is" : "pinned public URLs are"} not served as ` +
      `declared — every endpoint under the declared slug answers 404:\n${lines.join("\n")}\n` +
      `Rebuild the environment from the project with \`${resetRerun}\` (that replaces its rows with the seed rows).`,
    {
      details: {
        landed: true,
        canonicals: missed.map((c) => ({
          kind: sectionKind(planTypeSection(c.kind)),
          name: c.name,
          requested: c.requested ?? null,
          served: c.served ?? null,
          outcome: c.outcome,
        })),
      },
    },
  );
}

/**
 * A no to the foreign-delete question: nothing was written, and the reader
 * chose that — a decline, exit 0, as every other command's decline is (E2E
 * pass 27: it exited 2 as a refusal). The deploy says so and stops.
 */
export class KeepDataDeclined extends Error {
  readonly declined = true;
  constructor(label: string, verb = "merged") {
    super(`Nothing was ${verb} — ${label} and its data are as they were.`);
    this.name = "KeepDataDeclined";
  }
}

/** What {@link gateForeignReplace} needs: where, what goes out, and who may answer. */
export type ForeignReplaceRequest = Pick<
  KeepDataMergeRequest,
  "auth" | "baseUrl" | "workspaceId" | "label" | "bundle" | "allowForeignDeletes" | "confirm" | "kind" | "rerun" | "fetchFn"
> & {
  /** The guids this project's landing record names for the environment. */
  landedGuids: ReadonlySet<string>;
};

/**
 * The replace arm's half of the foreign-delete gate: a replace clears
 * everything the environment holds, so an object another source landed there —
 * another project's `deploy --to tenant:<it>` — goes with it. The merge asks
 * before deleting one ({@link gateForeignDeletes}); a plain replace deleted
 * them silently (E2E pass 30). Asked the same way now: `--yes`, a yes on the
 * terminal, or refused (`SDK_PRUNE_OUT_OF_SCOPE`, exit 2) with nothing written.
 *
 * Another source's object is one the environment holds under a guid that
 * neither the outgoing bundle carries (that one is replaced by this project's)
 * nor this project's landing record names (that one the project landed and no
 * longer declares). Read before any write; a read that got no answer is exit 8
 * with the rerun, as the merge's is.
 */
export async function gateForeignReplace(req: ForeignReplaceRequest): Promise<void> {
  // `--yes` answers the question, never the listing: what a replace removes
  // that this project did not land is named either way.
  const answered = req.allowForeignDeletes === true;
  let live: unknown;
  try {
    live = await withSpinner("Reading the environment to check what the replace clears…", () =>
      exportWorkspaceBundle(req.auth, { base: req.baseUrl, workspaceId: req.workspaceId, label: `${req.label} live read` }),
    );
  } catch (err) {
    // Answered already, the read only lists: its failure costs the listing, not the deploy.
    if (answered) {
      warn(
        `Could not read ${req.label} to list what the replace clears that this project did not land; \`--yes\` deletes it unlisted.`,
        "plan.object-remove-unlisted",
        [err instanceof Error ? err.message : String(err)],
      );
      return;
    }
    throw await unansweredReadError(err, req);
  }
  const foreign = foreignObjects(live, JSON.parse(req.bundle) as unknown, req.landedGuids);
  if (foreign.length === 0) return;
  const one = foreign.length === 1;
  const what = `${plural(foreign.length, "object", "objects")} ${NOT_LANDED}`;
  warn(
    answered
      ? `The replace DELETES ${what} — a replace clears everything ${req.label} holds:`
      : `The replace would DELETE ${what} — a replace clears everything ${req.label} holds:`,
    "plan.object-remove",
    foreign.map((o) => o.label),
  );
  if (answered) return;
  if (req.confirm !== undefined) {
    if (await req.confirm(`Delete ${what} from ${req.label}?`)) return;
    throw new KeepDataDeclined(req.label, "deployed");
  }
  const rerun = req.rerun === undefined ? undefined : withFlag(req.rerun.command, "--yes", "-y");
  throw new CliError(
    "SDK_PRUNE_OUT_OF_SCOPE",
    `${req.label} was not replaced: the replace would delete ${what} (${foreign.map((o) => o.label).join(", ")}) — ` +
      `this project's landing record does not name ${one ? "it" : "them"}. Nothing was written.\n` +
      `To delete ${one ? "it" : "them"}, ${rerun === undefined ? "pass `--yes`" : `run \`${rerun}\``}` +
      `${req.rerun?.note ?? ""}; to keep ${one ? "it" : "them"}, declare ${one ? "it" : "them"} in this project.`,
    { exitCode: EXIT_CONFLICT, details: refusalDetails("pruneOutOfScope", { outOfScope: foreign }) },
  );
}

/** The live objects a replace clears that are neither sent again nor this project's landing. */
function foreignObjects(live: unknown, outgoing: unknown, landedGuids: ReadonlySet<string>): OutOfScopeObject[] {
  const sent = new Set<string>();
  for (const key of LOCK_PAYLOAD_KEYS) {
    for (const row of payloadRows(outgoing, key)) if (typeof row.guid === "string") sent.add(row.guid);
  }
  const label = rowLabeler(payloadOf(live));
  const out: OutOfScopeObject[] = [];
  for (const key of LOCK_PAYLOAD_KEYS) {
    for (const row of payloadRows(live, key)) {
      // A row with no guid cannot be told apart, and is not claimed as anyone's.
      if (typeof row.guid !== "string" || row.guid === "" || sent.has(row.guid) || landedGuids.has(row.guid)) continue;
      out.push({ type: sectionKind(key, row), name: typeof row.name === "string" ? row.name : "", label: label(key, row) });
    }
  }
  return out;
}

/**
 * Deletes the landing record does not name — another source's objects — go
 * only with an answer: `--yes`, or a yes on the terminal. Refused without one,
 * as `--prune` refuses the same deletion (`SDK_PRUNE_OUT_OF_SCOPE`, exit 2);
 * a no is a decline ({@link KeepDataDeclined}).
 * Before this a merge warned and deleted them (E2E pass 25).
 */
async function gateForeignDeletes(req: KeepDataMergeRequest, notLanded: readonly OutOfScopeObject[]): Promise<void> {
  if (notLanded.length === 0 || req.allowForeignDeletes === true) return;
  const one = notLanded.length === 1;
  const what = `${plural(notLanded.length, "object", "objects")} ${NOT_LANDED} (${notLanded.map((o) => o.label).join(", ")})`;
  if (req.confirm !== undefined) {
    if (await req.confirm(`Delete ${what} from ${req.label}?`)) return;
    throw new KeepDataDeclined(req.label);
  }
  const rerun = req.rerun === undefined ? undefined : withFlag(req.rerun.command, "--yes", "-y");
  throw new CliError(
    "SDK_PRUNE_OUT_OF_SCOPE",
    `${req.label} was not merged: the merge would delete ${what} — this project's landing record does not name ` +
      `${one ? "it" : "them"}. Nothing was written.\n` +
      `To delete ${one ? "it" : "them"}, ${rerun === undefined ? "pass `--yes`" : `run \`${rerun}\``}` +
      `${req.rerun?.note ?? ""}; to keep ${one ? "it" : "them"}, declare ${one ? "it" : "them"} in this project.`,
    { exitCode: EXIT_CONFLICT, details: refusalDetails("pruneOutOfScope", { outOfScope: [...notLanded] }) },
  );
}

/** A printed rerun with `flag` added once. */
function withFlag(command: string, flag: string, alias?: string): string {
  const words = command.split(" ");
  if (words.some((w) => w === flag || w === alias)) return command;
  // `--reset` beside the mode flag it changes, not after `--json`.
  const mode = flag === "--reset" ? words.indexOf("--keep-data") : -1;
  if (mode === -1) return `${command} ${flag}`;
  words.splice(mode + 1, 0, flag);
  return words.join(" ");
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Table names the outgoing bundle carries seed rows for, via each table's guid. */
function seededTableNames(bundle: unknown, content: readonly SeedContentFile[]): Set<string> {
  const seeded = new Set(seedRowsByTableGuid(content).keys());
  const out = new Set<string>();
  const dbo = (bundle as { payload?: { dbo?: unknown } } | null)?.payload?.dbo;
  if (!Array.isArray(dbo)) return out;
  for (const table of dbo) {
    const { guid, name } = (table ?? {}) as { guid?: unknown; name?: unknown };
    if (typeof guid === "string" && typeof name === "string" && seeded.has(guid)) out.add(name);
  }
  return out;
}

/**
 * Tables the outgoing bundle carries under a guid the environment holds by
 * another name: a merge matches on guid, so it renames the table and keeps
 * its rows — what a `lock rename` before the deploy buys (E2E pass 27: the
 * preview said nothing about it).
 */
function renamedTables(live: unknown, outgoing: unknown): { from: string; to: string }[] {
  return renamedRows(live, outgoing, "dbo");
}

/** Rows of `section` the outgoing bundle carries under a guid the environment holds by another name. */
function renamedRows(live: unknown, outgoing: unknown, section: string): { from: string; to: string }[] {
  const liveNames = new Map<string, string>();
  for (const row of payloadRows(live, section)) {
    if (typeof row.guid === "string" && typeof row.name === "string") liveNames.set(row.guid, row.name);
  }
  const out: { from: string; to: string }[] = [];
  for (const row of payloadRows(outgoing, section)) {
    if (typeof row.guid !== "string" || typeof row.name !== "string") continue;
    const from = liveNames.get(row.guid);
    if (from !== undefined && from !== row.name) out.push({ from, to: row.name });
  }
  return out;
}

/** `payload.<key>` as an array of records, whatever the bundle carries there. */
function payloadRows(bundle: unknown, key: string): Record<string, unknown>[] {
  const rows = (bundle as { payload?: Record<string, unknown> } | null)?.payload?.[key];
  return Array.isArray(rows) ? rows.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object") : [];
}

/**
 * A plan operation named without the live read: its SDK kind and its name, in
 * the `<kind>:<name>` form every other report uses. The plan's own `type` is
 * the engine's storage vocabulary (`api_group`, `workflow_test`), which is not
 * what the author wrote.
 */
function planLabel(op: ImportOperation): string {
  return `${sectionKind(planTypeSection(op.type))}:${op.name}`;
}

/**
 * How the removal line names a deleted object, and which live row it is.
 *
 * Through the live read already in hand, labelled the way the diff and promote
 * label a row. That matters most for an endpoint: the plan names one by its
 * path alone, and a path is shared by every verb on it and across groups — so
 * two deleted endpoints printed as "query widgets, query widgets", which says
 * neither which went nor that they differ. A deleted object is a live row of
 * that section and name whose guid the outgoing bundle no longer carries (a
 * merge matches on guid). Each live row is claimed once, so two deletes on one
 * path name two endpoints. Anything it cannot place is named from the plan,
 * with no guid.
 */
type DeleteNamer = (op: ImportOperation) => { type: string; label: string; guid?: string };

function deleteNamer(live: unknown, outgoing: unknown): DeleteNamer {
  const label = rowLabeler(payloadOf(live));
  const claimed = new Set<Record<string, unknown>>();
  return (op) => {
    const section = planTypeSection(op.type);
    const kept = new Set(
      payloadRows(outgoing, section).map((r) => r.guid).filter((g): g is string => typeof g === "string"),
    );
    const row = payloadRows(live, section).find(
      (r) => !claimed.has(r) && r.name === op.name && (typeof r.guid !== "string" || !kept.has(r.guid)),
    );
    if (row === undefined) return { type: sectionKind(section), label: planLabel(op) };
    claimed.add(row);
    return {
      type: sectionKind(section, row),
      label: label(section, row),
      ...(typeof row.guid === "string" ? { guid: row.guid } : {}),
    };
  };
}

/** What an object the landing record does not name is. */
const NOT_LANDED = "not in this project (landed by another source)";
/** Why a merge deletes one anyway. */
const MIRRORS = "keep-data mirrors this project's source";

/**
 * An object another source landed, as `details.outOfScope` names it — the
 * shape `deploy --to --prune`'s refusal uses, so one reader serves both.
 */
export interface OutOfScopeObject {
  /** The SDK kind: `table`, `query`, `function`, … */
  type: string;
  name: string;
  /** `<kind>:<name>`, as every report spells it (`query:GET ping (apiGroup shop)`). */
  label: string;
}

/** The plan's deletes, each named and told apart by the landing record. */
interface ClassifiedDeletes {
  tables: { name: string; ours: boolean; guid?: string }[];
  others: { label: string; ours: boolean; guid?: string }[];
  /** Tables and other objects the landing record does not name. */
  notLanded: OutOfScopeObject[];
}

function classifyDeletes(
  operations: readonly ImportOperation[],
  nameDelete: DeleteNamer,
  landedGuids: ReadonlySet<string> | undefined,
): ClassifiedDeletes {
  const deletes = operations.filter((o) => o.action === "delete");
  // Provenance: with a landing record, a delete it does not name is not an
  // object the project "no longer declares" — the project never had it.
  const landed = (guid: string | undefined) =>
    landedGuids === undefined || (guid !== undefined && landedGuids.has(guid));
  const tables = deletes
    .filter((o) => TABLE_KINDS.has(o.type))
    .map((o) => ({ name: o.name, guid: nameDelete(o).guid }))
    .map((t) => ({ name: t.name, ours: landed(t.guid), ...(t.guid === undefined ? {} : { guid: t.guid }) }));
  const others = deletes
    .filter((o) => !TABLE_KINDS.has(o.type))
    .map((o) => ({ op: o, ...nameDelete(o) }))
    .map((d) => ({ label: d.label, ours: landed(d.guid), type: d.type, name: d.op.name, ...(d.guid === undefined ? {} : { guid: d.guid }) }));
  const notLanded: OutOfScopeObject[] = [
    ...tables.filter((t) => !t.ours).map((t) => ({ type: "table", name: t.name, label: `table:${t.name}` })),
    ...others.filter((o) => !o.ours).map((o) => ({ type: o.type, name: o.name, label: o.label })),
  ];
  return { tables, others, notLanded };
}

/**
 * Print what the merge will cost, before it writes. Disclosure, not a prompt:
 * `--keep-data` serves a scripted redeploy loop, which a prompt would break.
 * The one exception is another source's objects, which wait on an answer
 * ({@link gateForeignDeletes}): with `asking`, every line says what the merge
 * WOULD do, since the answer may still be no.
 */
function discloseMerge(
  operations: readonly ImportOperation[],
  diff: LiveDiff,
  seeded: Set<string>,
  deletes: ClassifiedDeletes,
  renamed: { from: string; to: string }[],
  /** See {@link KeepDataMergeRequest.envSetTo}. */
  envSetTo = "",
  /** This run with `--reset` added — the precise replace to print. */
  resetRerun = "xanosdk deploy --keep-data --reset",
  asking = false,
  slugMoves: readonly CanonicalChange[] = [],
  /** Realtime channels the merge renames in place (guid matched, path changed). */
  channelRenames: readonly { from: string; to: string }[] = [],
  /** Columns the merge adds to tables already there (`table.column`), for the dropped-and-added hint. */
  addedColumns: readonly string[] = [],
): KeepDataMergeResult {
  const tableDeletes = deletes.tables;
  const droppedTables = tableDeletes.map((t) => t.name);
  const will = asking ? "would" : "will";
  // Added columns only: the merge says its table renames itself, and creates no table it discloses.
  const effects = tableEffectsOf(diff, { createdTables: [], addedColumns: [...addedColumns], addedDefaults: {}, renamedTables: [] }, { mode: "merge" });
  const unseededTables = operations
    .filter((o) => o.action === "create" && TABLE_KINDS.has(o.type) && seeded.has(o.name))
    .map((o) => o.name);
  const keptEnv = diff.unchangedEnv.map((e) => e.name);

  for (const { from, to } of renamed) detail(`The merge ${will} rename table ${from} → ${to} (rows kept).`);
  if (slugMoves.length > 0) {
    warn(
      `The merge ${will} move ${plural(slugMoves.length, "public URL", "public URLs")} — the project pins another ` +
        `\`canonical\`, and every endpoint under the old slug stops answering:`,
      "plan.canonical-change",
      slugMoves.map((m) => `${m.kind} "${m.name}": ${m.from} → ${m.to}`),
    );
  }
  const detached = [
    ...slugMoves.filter((m) => m.kind === "realtimeServer").map((m) => `${m.kind} "${m.name}": ${m.from} → ${m.to}`),
    ...channelRenames.map((c) => `realtimeChannel "${c.from}" → "${c.to}"`),
  ];
  if (detached.length > 0) {
    warn(
      `The merge ${will} detach realtime history: sockets on the old ` +
        `${channelRenames.length === 0 ? "slug" : slugMoves.some((m) => m.kind === "realtimeServer") ? "slug or channel" : "channel"} ` +
        `stop connecting, and the \`conversation\` transcript and the \`at_least_once\` replay stay under the old ` +
        `name — a client joins with no history. Moving the name back restores them:`,
      "plan.realtime-history-detached",
      detached,
    );
  }

  for (const ours of [true, false]) {
    const tables = tableDeletes.filter((t) => t.ours === ours).map((t) => t.name);
    if (tables.length === 0) continue;
    const rows = `with every row in ${tables.length === 1 ? "it" : "them"}`;
    warn(
      ours
        ? `The merge ${will} DROP ${plural(tables.length, "table", "tables")} the project no longer declares, ${rows}:`
        : `The merge ${will} DROP ${plural(tables.length, "table", "tables")} ${NOT_LANDED}, ${rows} — ${MIRRORS}:`,
      "plan.table-drop",
      tables,
    );
  }
  // One disclosure for every landing path (see `plan-disclosure.ts`): the plan
  // reports each of these as a routine in-place update; only the live read sees them.
  discloseTableEffects(effects, {
    subject: "the merge",
    stages: "deploys",
    will,
    remedies: {
      "plan.column-retype": "`--reset` re-seeds instead.",
      "plan.enum-values-removed": "`--reset` re-seeds instead.",
      "plan.not-null-kept":
        `A replace recreates the table, which relaxes it (and replaces its rows with the seed rows): ` +
        `\`${resetRerun}\`, or a deploy without \`--keep-data\`.`,
      "plan.not-null-tightened":
        `Give ${effects.notNullTightened.length === 1 ? "it" : "them"} a value in each row, or keep ` +
        `\`nullable: true\`; a replace re-seeds instead (\`${resetRerun}\`).`,
    },
  });
  // Said before the write, so in the future tense: "Also removed" read as done
  // ahead of a refusal that removed nothing (E2E pass 26) — and in the
  // conditional while an answer is pending, every line alike (E2E pass 27:
  // "will also remove" beside "would also remove").
  const removed = deletes.others.map((d) => d.label);
  const removedOurs = deletes.others.filter((d) => d.ours).map((d) => d.label);
  const removedOthers = deletes.others.filter((d) => !d.ours).map((d) => d.label);
  // Warnings of their own, each list as its remedy lines, so `--json` carries
  // them (E2E pass 29: printed as detail() under whatever warned last, the
  // document lost them).
  if (removedOurs.length > 0) {
    warn(
      `The merge ${will} also remove, as the project no longer declares ${removedOurs.length === 1 ? "it" : "them"}:`,
      "plan.object-remove",
      removedOurs,
    );
  }
  if (removedOthers.length > 0) {
    warn(`The merge ${will} also remove, ${NOT_LANDED} — ${MIRRORS}:`, "plan.object-remove", removedOthers);
  }
  const notLanded = deletes.notLanded.map((o) => o.label);
  if (unseededTables.length > 0) {
    warn(
      `${plural(unseededTables.length, "new table declares", "new tables declare")} seed rows a merge does ` +
        `not write — ${unseededTables.join(", ")}. \`--reset\` seeds ${unseededTables.length === 1 ? "it" : "them"}, ` +
        `and replaces every other table's rows with its seeds too.`,
      "plan.seed-not-written",
    );
  }
  // Names only: a value is a secret, and this output lands in CI logs. A name
  // the project holds NO value for is said apart: `--reset` would apply the
  // empty value and clear the live one, which is not the fix (E2E pass 22).
  const differing = diff.unchangedEnv.filter((e) => !e.empty).map((e) => e.name);
  const unfilled = diff.unchangedEnv.filter((e) => e.empty).map((e) => e.name);
  if (differing.length > 0) {
    // The single-name write first: `--reset` applies the project's value too,
    // but also replaces every table's rows with its seeds.
    const one = differing.length === 1;
    warn(
      `${plural(differing.length, "environment variable keeps its", "environment variables keep their")} live ` +
        `value — the project's differs, and a merge does not update values: ${differing.join(", ")}. To apply ` +
        `the project's, run:`,
      "plan.env-kept",
      [
        ...differing.map((name) => envSetFromStdin(name, envSetTo)),
        `or deploy with \`--reset\`, which applies ${one ? "it" : "them"} and also replaces the rows with the seed rows.`,
      ],
    );
  }
  if (unfilled.length > 0) {
    // What works under a merge, which never updates a value (E2E pass 24: the
    // old "fill it in `.env`" advice led to a redeploy that still kept it).
    const one = unfilled.length === 1;
    warn(
      `${plural(unfilled.length, "environment variable keeps its", "environment variables keep their")} live ` +
        `value — the project's is empty: ${unfilled.join(", ")}. A merge never updates a value; to change ` +
        `${one ? "it" : "them"}, run:`,
      "plan.env-kept",
      [
        ...unfilled.map((name) => envSetFromStdin(name, envSetTo)),
        `or fill ${one ? "it" : "them"} in the backend's \`.env\` and deploy with \`--reset\` (which also replaces ` +
          `the rows with the seed rows).`,
      ],
    );
  }

  // The token resolved and the import answers "applied", so without this a
  // `--keep-data --doc-token` reports success over a token it never wrote.
  const unappliedDocumentation = [...diff.unappliedDocumentation];
  if (unappliedDocumentation.length > 0) {
    const what = unappliedDocumentation.includes("require_token")
      ? unappliedDocumentation.includes("token") ? "documentation gate and token" : "documentation gate"
      : "documentation token";
    warn(
      `The workspace ${what} ${will} NOT be updated — a merge does not write the workspace's ` +
        `\`documentation\` block. \`--reset\` writes it.`,
      "plan.doc-not-updated",
    );
  }

  return {
    droppedTables,
    ...tableEffectFields(effects),
    removed,
    removedGuids: [...deletes.tables, ...deletes.others].filter((d) => d.ours && d.guid !== undefined).map((d) => d.guid!),
    notLanded,
    unseededTables,
    renamedTables: renamed,
    keptEnv,
    unappliedDocumentation,
    canonicalChanges: [...slugMoves],
    pairedColumns: droppedAndAdded(effects),
  };
}

/**
 * Merge the bundle into the environment, keeping its rows.
 *
 * Probe, live read, dry run and disclosure, then the same request with
 * `dry_run` flipped — so the preview is a truthful one. `mode=merge` and
 * `prune=true` (objects the project removed are deleted), and no `records`,
 * `truncate` or `preserve_guids`: a merge already matches on the archive's
 * guids, and the route rejects the replace-only flag under merge.
 */
export async function mergeKeepingData(req: KeepDataMergeRequest): Promise<KeepDataMergeResult> {
  const target = {
    baseUrl: req.baseUrl,
    workspaceId: req.workspaceId,
    label: req.label,
    ...(req.stateCheck === undefined ? {} : { stateCheck: req.stateCheck }),
    ...(req.fetchFn === undefined ? {} : { fetchFn: req.fetchFn }),
  };

  let capable: boolean;
  try {
    capable = await detectXanoSdkImportRoute(req.auth, target);
  } catch (err) {
    throw await unreachableProbeError(err, req);
  }
  if (!capable) throw cannotMergeError(req.label);

  const outgoing = JSON.parse(req.bundle) as unknown;
  let live;
  try {
    live = await withSpinner("Reading the environment to preview the merge…", () =>
      exportWorkspaceBundle(req.auth, { base: req.baseUrl, workspaceId: req.workspaceId, label: `${req.label} live read` }),
    );
  } catch (err) {
    throw await unansweredReadError(err, req);
  }
  // Every keep-data environment that is not a Xano Engine is tenant-hosted.
  const triggers = req.kind === "local" ? [] : liveTableTriggers(live);
  if (triggers.length > 0) {
    const reset = req.rerun === undefined ? "xanosdk deploy --keep-data --reset" : withFlag(req.rerun.command, "--reset");
    throw tableTriggerMergeError(req.label, triggers, { command: reset, note: req.rerun?.note ?? "" });
  }
  const diff = diffAgainstLive(outgoing, live, { mode: "merge", ...(req.storedColumns === undefined ? {} : { stored: req.storedColumns }) });
  const resetRerun = req.rerun === undefined ? "xanosdk deploy --keep-data --reset" : withFlag(req.rerun.command, "--reset");
  if (req.kind !== "local") {
    await assertStorageModesKept(diff.storageChanges, tableRowCounter(req.auth, { workspaceId: req.workspaceId, base: req.baseUrl }), {
      target: req.label,
      subject: "the merge",
      remedy:
        `rebuild the environment with \`${resetRerun}\` ` +
        (req.content.length > 0
          ? "(that replaces its rows with the seed rows)."
          : "(that leaves its tables EMPTY — this deploy carries no seed rows to put back).") +
        (req.rerun?.note ?? ""),
    });
  }

  // No content entries: the route is told to write no rows, and an archive that
  // carried them anyway would ship seed data nobody asked to send. Hosted files
  // are not rows, so they ride along.
  const archive = encodeWorkspaceArchive(req.bundle, req.files ?? []);
  const pinned = req.pinned ?? [];
  const request = { ...target, archive, mode: "merge" as const, prune: true, pinned };

  let plan;
  try {
    plan = await withSpinner("Previewing the merge…", () => xanosdkImport(req.auth, { ...request, dryRun: true }));
  } catch (err) {
    if (err instanceof XanoSdkImportRefusal) throw refusedError(req.label, err, diff.indexChanges, req.rerun);
    const unanswered = await unansweredReadError(err, req);
    if (unanswered !== err) throw unanswered;
    // A dry run writes nothing, whatever went wrong with it — said here only
    // when the error does not already say it (a transport failure does: E2E
    // pass 26 printed it twice).
    if (!(err instanceof Error && /writes nothing|untouched|intact/.test(err.message))) {
      detail("The preview writes nothing, so the environment's data is untouched.");
    }
    throw err;
  }

  // Refused before the disclosure: a "will DROP" followed by "not merged" reads
  // as two outcomes. A rename first — its remedy settles a collision too.
  const operations = plan.plan.operations;
  const renames = pendingRenames(operations, deleteNamer(live, outgoing), req.lockPins);
  if (renames.length > 0) throw pendingRenameError(req.label, renames, resetRerun);
  const collisions = nameCollisions(operations, live, outgoing);
  if (collisions.length > 0) {
    const parents = parentRenames(collisions, live, outgoing, req.lockPins);
    throw parents.length > 0 ? parentRenameError(req.label, parents, collisions, resetRerun) : collisionError(req.label, collisions, resetRerun);
  }
  // A dry run answers a pinned slug it cannot serve as a conflict, where the
  // write would refuse: refused here, before a disclosure of a merge that will not happen.
  const slugConflicts = canonicalConflicts(plan.conflicts, plan.canonicals, operations, live, req.lockPins, req.workspaceId);
  if (slugConflicts.length > 0) {
    const steps = siblingSlugSteps(slugConflicts, plan.canonicals, live);
    const again = req.rerun?.command ?? "xanosdk deploy --keep-data";
    throw canonicalConflictError(req.label, slugConflicts, resetRerun, steps === undefined ? undefined : { list: steps, rerun: again });
  }

  const deletes = classifyDeletes(operations, deleteNamer(live, outgoing), req.landedGuids);
  // Another source's objects with nobody to ask and no `--yes`: refused now,
  // before a disclosure that would list them as removed (E2E pass 26).
  const foreign = deletes.notLanded.length > 0 && req.allowForeignDeletes !== true;
  if (foreign && req.confirm === undefined) await gateForeignDeletes(req, deletes.notLanded);

  const result = discloseMerge(
    operations,
    diff,
    seededTableNames(outgoing, req.content),
    deletes,
    renamedTables(live, outgoing),
    req.envSetTo,
    req.rerun === undefined ? undefined : withFlag(req.rerun.command, "--reset"),
    foreign,
    canonicalChanges(plan.canonicals, live),
    renamedRows(live, outgoing, "channel"),
    tableAdditions(outgoing, live).addedColumns,
  );
  await gateForeignDeletes(req, deletes.notLanded);
  // Every refusal is behind us: the caller's deferred writes land now, before the apply.
  const relabel = (await req.beforeWrite?.()) ?? {};
  const label = relabel.label ?? req.label;
  const stateCheck = relabel.stateCheck ?? req.stateCheck;

  let applied;
  try {
    applied = await withSpinner("Merging the workspace, keeping its data…", () =>
      xanosdkImport(req.auth, { ...request, label, ...(stateCheck === undefined ? {} : { stateCheck }), dryRun: false }),
    );
  } catch (err) {
    if (err instanceof XanoSdkImportRefusal) throw refusedError(label, err, diff.indexChanges, req.rerun);
    // Not a refusal — the write may have committed, so no claim about the data.
    // Its own message already says what to check before retrying.
    throw err;
  }
  // What the write served, not what the preview predicted: every pin served as
  // declared, and the moves the summary reports are the ones that happened.
  const missed = applied.canonicals.filter(
    (c) => c.guid !== undefined && pinned.includes(c.guid) && c.outcome !== "honored",
  );
  if (missed.length > 0) throw canonicalNotServedError(label, missed, resetRerun);
  return {
    ...result,
    canonicalChanges: canonicalChanges(applied.canonicals, live),
    storedColumns: storedColumnsAfter(outgoing, live, req.storedColumns ?? new Map(), "merge"),
  };
}

/**
 * One `env set` as a remedy prints it: the value piped on stdin, the form that
 * keeps a secret out of shell history. A `<value>` placeholder pasted into a
 * shell is a redirect from a file named `value`.
 */
function envSetFromStdin(name: string, to: string): string {
  return `printf %s "$VALUE" | xanosdk env set ${shellQuote(name)}${to}`;
}
