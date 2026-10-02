/**
 * `xanosdk promote <release>` — land a release in your real workspace.
 *
 * The taught path to production, and a thin one. It hands the release to the
 * platform's own release-deploy rather than downloading it and merging it
 * client-side, so the landing is the server's: the release arrives as a new
 * branch, promoted to live only when asked.
 *
 * ## What it does not check, and what it has instead
 *
 * The client-side merge behind `deploy --to workspace` computes a plan preview
 * and a prune scope from an archive the CLI encoded and is holding. A promote
 * lands a release the server holds, so it runs neither, and it says so before
 * it writes rather than letting a quiet run read as a clean bill of health.
 * What it does read from the release's own archive: its table effects, and its
 * identities — the names and pinned public URL slugs `--to` checks before it
 * writes, checked the same way, because the platform's landing settles a taken
 * one by inventing a suffixed name or a minted slug and answering success.
 *
 * Stated as omissions alone that notice argues against the path the docs
 * recommend, so it names the compensating property too: a promote's input is a
 * named, listable, exportable artifact that came up and answered somewhere real,
 * and can be re-landed, handed on, or pointed at a second tenant. A
 * `deploy --to` writes something that existed only on one machine.
 *
 * ## Measured, not assumed
 *
 * A release deploy is additive for LOGIC: static hosting survives, the live
 * branch's logic is untouched without `--set-live`, and objects created after
 * the release was cut are not dropped. TABLES are another matter: they carry no
 * branch, so the landing applies the release's table definitions to the one set
 * live serves from, as soon as it lands. A dropped column's values go, a retype
 * re-reads them, a removed enum value reads null. So the release's tables are
 * read against the workspace's first, and a change that alters an existing
 * table is refused without `--allow-shared-schema-changes` — the gate
 * `deploy --to workspace --branch` has for the same change set. What the server
 * also handles badly is a branch label that already exists, which comes back as
 * a fatal 500, so the label is checked before anything is sent.
 *
 * ## What it reports
 *
 * The shared operation result (`operation-result.ts`), with steps `land`,
 * `verify` and — only when asked — `setLive`. `branch` is always the landing
 * label, derived or given, because it is the one handle a caller resolving an
 * unknown landing can look for. A run that ends `no` after the land succeeded
 * names the landed branch as residue: a promote never deletes one.
 */
import { assertOneName } from "./name-argument.js";
import type { ParsedArgs } from "./cli.js";
import { getAccessToken, type ResolvedAuth } from "../auth/token.js";
import { CliError, LocalFileNotFoundError, UsageError } from "./errors.js";
import { isMachineOutput } from "./output.js";
import { confirm } from "./prompt.js";
import {
  step,
  success,
  warn,
  error,
  info,
  blank,
  detail,
  credentialWriteTarget,
  discloseWriteTarget,
  withoutUrls,
  type WriteTarget,
} from "./ui.js";
import { createOperation, runOperation } from "./operation-result.js";
import { shellWord } from "./command-line.js";
import { withoutReadAftermath } from "../util/http.js";
import { resolveProjectEntry } from "./deploy-source.js";
import { pastePath } from "./typed-cwd.js";
import { existsSync, statSync } from "node:fs";
import { setDiagnosticSink } from "../workspace/diagnostics.js";
import { contextFlags } from "./context-flags.js";
import { classifyFailure } from "./operation-outcome.js";
import { parseSource } from "./source-selector.js";
import { resolveSource } from "./source-resolve.js";
import { reportEnvLanding } from "./env-landing-report.js";
import { liveBranchMismatch, liveMismatch } from "./branch-commands.js";
import {
  deployRelease,
  downloadRelease,
  promotableReleaseName,
  ReleaseHttpError,
  UNPROMOTABLE_RELEASE_PARTS,
  unpromotableReleasePart,
  untenantDeployableReleasePart,
} from "../deploy/release.js";
import {
  listBranchListing,
  liveBranchLabel,
  assertBranchAbsent,
  assertUsableBranchLabel,
  BranchTakenError,
  derivedLabelTail,
  findBranch,
  freeBranchLabel,
  setLiveBranch,
} from "../deploy/branch.js";
import { decodeWorkspaceArchive } from "../validate/archive.js";
import { asWorkspaceArchive } from "./deploy-source.js";
import { pipedYes, retryCommand, withheldNote } from "./retry-command.js";
import {
  assertReleaseIdentitiesFree,
  pinnedCanonicalGuids,
  setLiveRollback,
  type ReleaseIdentityCheck,
} from "./release-command.js";
import { readLockFile } from "../lock/io.js";
import { sdkKindName, type LockFile } from "../lock/lock.js";
import { fetchWorkspaceBundle } from "./codegen-command.js";
import { landingLockPath, recordForeignLanding, type LandingReport } from "./landing-record.js";
import { exportWorkspaceBundle, type ExportedBundle } from "../deploy/workspace-export.js";
import { SettledWriteFailure } from "./operation-outcome.js";
import {
  additiveChanges,
  discloseCanonicalMoves,
  droppedAndAdded,
  movesClause,
  releaseCanonicalMoves,
  renameHint,
  type CanonicalMove,
  alteringChanges,
  CONSTRAINT_FIX,
  CONSTRAINT_PHRASE,
  constraintStop,
  constraintWhere,
  assertStorageModesKept,
  discloseTableEffects,
  namedConstraint,
  readOnce,
  releaseTableEffects,
  tableEffectsPayload,
  type ConstraintStop,
  type TableEffects,
} from "./plan-disclosure.js";
import { tableRowCounter } from "../deploy/table.js";


/**
 * A branch label for a promote that named none.
 *
 * Not cosmetic. Measured against a live instance: a deploy body carrying no
 * `branch` does not make the engine choose one — it creates a branch with an
 * EMPTY label and lands every branch-scoped object there. `listBranches` drops
 * that row and the list shape carries no id, so nothing can select, promote or
 * delete it afterwards; the release's logic is stranded while the promote
 * answers 200. Tables are workspace-scoped and arrive regardless, which is what
 * makes the half-landing read as a clean run.
 *
 * `assertUsableBranchLabel` already refuses an empty label a caller TYPED. This
 * is the other door into the same outcome, so the CLI names the branch itself
 * rather than leaving the choice to a server that has no good default.
 *
 * Shaped like {@link ../emit/release-command.ts}'s backup labels — a stem plus
 * {@link derivedLabelTail} — so a workspace's branch list reads as one
 * convention, and neither a repeated promote of the same release nor two
 * concurrent ones collide.
 */
export function derivedPromoteLabel(releaseName: string, now: Date, random?: () => number): string {
  // The label has to survive a URL path segment and stay recognisable as the
  // release it carries, so anything outside the safe set collapses to a dash.
  // A label also has to START with a letter, digit or underscore — the rule
  // `assertUsableBranchLabel` holds every label to — so leading dots and dashes go too.
  return `${promoteLabelStem(releaseName)}-${derivedLabelTail(now, random)}`;
}

/** The part of a derived promote label that names its release. */
function promoteLabelStem(releaseName: string): string {
  const stem = releaseName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "");
  return stem === "" ? "release" : stem;
}

/** Whether `label` is one a promote of `releaseName` derived (see {@link derivedPromoteLabel}). */
export function isDerivedPromoteLabel(label: string, releaseName: string): boolean {
  const stem = promoteLabelStem(releaseName);
  return label.startsWith(`${stem}-`) && /^\d{8}T\d{6}Z-[0-9a-f]{4}$/.test(label.slice(stem.length + 1));
}

/**
 * Flags that scope a client-side merge and have nothing to act on here.
 *
 * Refused rather than ignored: silently accepting `--prune` on a promote would
 * teach that a prune scope was applied when none was computed.
 */
const MERGE_ONLY: ReadonlyArray<{ readonly key: keyof ParsedArgs; readonly flag: string }> = [
  { key: "prune", flag: "--prune" },
  { key: "replace", flag: "--replace" },
  { key: "resetData", flag: "--reset-data" },
  { key: "seed", flag: "--seed" },
  { key: "dryRun", flag: "--dry-run" },
];

/**
 * A promote never snapshots, so `--backup-branch` has nothing to take.
 *
 * Refused rather than ignored, and separately from {@link MERGE_ONLY} because
 * the reason differs: the merge flags scope a plan this command does not
 * compute, while this one asks for a rollback point that was never taken.
 * Accepting it taught that one existed.
 */
function assertNoBackupFlag(args: ParsedArgs): void {
  if (args.backupBranch === undefined) return;
  throw new UsageError(
    `\`--backup-branch\` snapshots the live branch before an import overwrites it, and a ` +
      `promote overwrites nothing: the release lands on a branch of its own and the live one ` +
      `keeps serving until \`--set-live\`. There is no point to snapshot.\n` +
      `\`xanosdk deploy --to workspace${contextFlags(args)}\` is the path that imports over live, and the one that has it.`,
    // Both flags parsed fine; the sentence says what to drop, so a pointer, not the block.
    { hintFor: { command: "promote" } },
  );
}

function assertNoMergeFlags(args: ParsedArgs): void {
  const passed = MERGE_ONLY.filter((f) => args[f.key] !== undefined && args[f.key] !== false);
  if (passed.length === 0) return;
  const names = passed.map((f) => f.flag);
  throw new UsageError(
    `${names.join(" and ")} ${names.length === 1 ? "scopes" : "scope"} a merge computed from a ` +
      `local build, and a promote lands a release the server already holds — there is nothing ` +
      `here for ${names.length === 1 ? "it" : "them"} to act on. ` +
      `\`xanosdk deploy --to workspace${contextFlags(args)}\` is the path that has ${names.length === 1 ? "it" : "them"}.`,
    { helpFor: { command: "promote" } },
  );
}

/**
 * What a promote exits with when the landing verifiably did not arrive.
 *
 * 2 is this CLI's "it ran and disagreed" — the same code a failed import
 * conflict and a failed preflight use. Carried on the error the run ends with,
 * never set on `process.exitCode`: the bin exits with the thrown error's own
 * code and nothing else, so a code set before a throw is silently replaced by 1.
 */
const EXIT_VERIFICATION_FAILED = 2;

/**
 * The three things a landing check can conclude, and why there are three.
 *
 * `passed` and `failed` are the obvious pair. `unverified` is the one worth
 * arguing for: an input the check needs could not be obtained, so the CLI knows
 * nothing about what landed — which is NOT the same as knowing something is
 * wrong, and must not read like it. It exits zero, because the write it is
 * reporting on did happen and refusing the run would be a lie in the other
 * direction; but it never renders as a tick.
 */
type VerificationOutcome = "passed" | "failed" | "unverified";

interface LandingVerification {
  readonly outcome: VerificationOutcome;
  /** Declared by the release, absent from the branch. Fails the landing, as an unserved pinned slug does. */
  readonly missing: readonly string[];
  /** On the branch, never declared by the release. Reported, never failed on. */
  readonly undeclared: readonly string[];
  /**
   * The subset of `undeclared` that looks like a suffixed rename of something
   * the release DID declare. Computed here rather than at the render site
   * because it needs the declared set, and on a passing verification that set
   * is exactly what `missing` is empty of.
   */
  readonly suffixed: readonly string[];
  /** How many objects the comparison actually looked at. */
  readonly compared: number;
  /**
   * Public URL slugs the landed branch serves under a value other than the one
   * the release declares. A `pinned` one fails the landing: a slug written in
   * code is a contract, and every route a frontend built from it answers 404.
   */
  readonly canonicals: readonly CanonicalMismatch[];
  /** Why the check could not run. Present only for `unverified`. */
  readonly reason?: string;
}

/** One public URL slug the landing did not serve as declared. */
interface CanonicalMismatch {
  /** The object's kind, as the SDK names it (`apiGroup`, `mcpServer`, …). */
  readonly kind: string;
  readonly name: string;
  readonly declared: string;
  /** What the landed branch serves for that object. */
  readonly served: string;
  /** The project pins this slug in code (its lock says so). */
  readonly pinned: boolean;
}

/** The payload sections whose rows carry a public URL slug (`canonical`). */
const CANONICAL_SECTIONS = ["app", "toolset", "realtime_server"] as const;

/** The rows of one payload section, or none. */
function sectionRows(bundle: unknown, key: string): Record<string, unknown>[] {
  const payload = (bundle as { payload?: unknown } | null | undefined)?.payload;
  if (payload === null || typeof payload !== "object") return [];
  const rows = (payload as Record<string, unknown>)[key];
  return Array.isArray(rows) ? rows.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object") : [];
}

/**
 * Every slug the release declares that the landed branch does not serve.
 *
 * Matched by guid, because the landing keeps the release's guids and a name can
 * be shared. An object the branch does not hold at all is not here: that is a
 * missing object, reported as one. A branch carrying several copies of one guid
 * (see the dedupe in {@link verifyLanding}) passes when any copy serves it.
 */
function canonicalMismatches(
  declared: unknown,
  landed: unknown,
  pinned: ReadonlySet<string>,
): CanonicalMismatch[] {
  const out: CanonicalMismatch[] = [];
  for (const key of CANONICAL_SECTIONS) {
    const served = new Map<string, string[]>();
    for (const row of sectionRows(landed, key)) {
      if (typeof row.guid !== "string" || typeof row.canonical !== "string") continue;
      served.set(row.guid, [...(served.get(row.guid) ?? []), row.canonical]);
    }
    for (const row of sectionRows(declared, key)) {
      const { guid, name, canonical } = row;
      if (typeof guid !== "string" || guid === "" || typeof name !== "string") continue;
      if (typeof canonical !== "string" || canonical === "") continue;
      const there = served.get(guid);
      if (there === undefined || there.includes(canonical)) continue;
      const kind = key === "toolset" ? (row.type === "agent" ? "agent" : "mcpServer") : sdkKindName(key);
      out.push({ kind, name, declared: canonical, served: there[0]!, pinned: pinned.has(guid) });
    }
  }
  return out;
}

/**
 * Read back what landed, and say whether the release's objects are there.
 *
 * ## Why this fails on MISSING objects (and unserved pins), not on extras
 *
 * A release deploy is additive — it adds a branch and drops nothing — so the
 * branch legitimately carries anything created since the release was cut. An
 * undeclared object is therefore routine, and failing on one would fire on
 * healthy promotes until the reader learned to ignore the line that means a
 * write went missing. That is the failure mode this whole check exists to
 * avoid, so `undeclared` is reported and never fails.
 *
 * `differing` is not a failing class either, and that is the less obvious half.
 * The two sides are both packageExport, but they are not the same KIND of
 * artifact: one is an archive cut at a point in time, the other is a live
 * branch read back through an export. The comparison also files a workspace
 * settings row, a non-array section, and any row it cannot read as `differing`
 * — none of which is evidence that a landing was partial. The report is "an
 * object the release declares did not arrive", and absence is the only thing
 * that answers it exactly.
 *
 * ## Slugs are read separately
 *
 * `compareToLive` is given no pins: without them it treats a non-empty slug as
 * pinned, which only ever moves objects into `differing` — a class this
 * function does not fail on. Slugs are compared on their own instead
 * ({@link canonicalMismatches}), by guid, and one the project pins in code
 * (its lock records it as written there) fails the landing when the branch
 * serves another value: the platform mints a slug rather than refuse a taken
 * one, so this read-back is what catches a pin that did not take.
 */
async function verifyLanding(
  auth: ResolvedAuth,
  opts: {
    /**
     * The decoded release archive, or `undefined` when the release carries no
     * id to read one from. Throws when the archive exists but could not be
     * fetched — the two are different outcomes and the caller distinguishes them.
     */
    loadArchive: () => Promise<unknown>;
    branch: string;
    /** The guids whose slug the project pins in code, from the archive. */
    pinned: (declared: unknown) => ReadonlySet<string>;
  },
): Promise<LandingVerification> {
  const unverified = (reason: string): LandingVerification => ({
    outcome: "unverified",
    missing: [],
    undeclared: [],
    suffixed: [],
    compared: 0,
    canonicals: [],
    reason,
  });

  // Both inputs are fetched inside the guard, because either being unobtainable
  // is the SAME outcome — the check could not run — and a throw escaping here
  // would abandon the success report for a landing that really happened.
  let declared: unknown;
  try {
    declared = await opts.loadArchive();
  } catch {
    // The message is DROPPED, never interpolated. A failure on this path can
    // carry the signed download link, which is a credential with its own
    // signature in the query string, and a transport that names the URL it
    // tried would put it on a terminal and into a run log.
    return unverified("the release archive could not be read");
  }
  // A release the listing gave no id for cannot be downloaded, so there is no
  // declared side to compare against. That is an input this check could not
  // obtain — the same class as a refused branch read, not a failed landing.
  if (declared === undefined) {
    return unverified("the release carries no id to read its archive from");
  }

  let landedBundle;
  try {
    landedBundle = await fetchWorkspaceBundle(auth, opts.branch);
  } catch (err) {
    // This one IS surfaced: the guard's refusal explains that the instance
    // ignores the branch parameter, which is the actionable half, and it names
    // no credential. SCRUBBED and BOUNDED anyway, because not every throw on
    // this path is that guard — a plain transport failure can carry a chunk of
    // the route's response body, and this reason now reaches the machine
    // channel as well as the terminal.
    return unverified(shortReason(err));
  }

  const { compareToLive, declaredLabels } = await import("../deploy/live-diff.js");
  // The comparison itself is inside the guard too. It reads two payloads this
  // function did not build, and a throw escaping here would abandon the success
  // report for a landing that really happened — the one outcome this whole
  // function exists to avoid.
  let result;
  try {
    // Everything, not the report's sample: "which of the eight did not arrive"
    // is the whole question, and a truncated list answers it for five of them.
    result = compareToLive(declared, landedBundle, undefined, { sample: "all" });
  } catch {
    return unverified("the release archive and the landed branch could not be compared");
  }

  // NOTHING COMPARED IS NOT A PASS. An archive that decodes but carries no
  // comparable section leaves `missing` empty, which would otherwise render as
  // "all 0 declared objects arrived" — a tick for a check that never checked
  // anything, on the one command whose job is to stop exactly that. The shared
  // comparison already encodes this rule in `converged` ("a bundle with nothing
  // comparable is not evidence of convergence — it is an absence of evidence");
  // this caller reads `missing` directly, so it has to carry the rule itself.
  if (result.compared === 0) {
    return unverified("the release archive declared no comparable objects");
  }
  // DEDUPED, and measured rather than assumed: a workspace landed before a
  // since-fixed platform defect carries an extra copy of each branch-scoped
  // object per earlier landing, with the same name and guid, and a release cut
  // from it repeats them all. Three functions landed twice before therefore
  // report as nine, so "9 functions did not arrive" describes three.
  const missing = [...new Set(result.missing)];
  const undeclared = [...new Set(result.liveOnly)];
  // A slug pinned in code that the landing did not serve fails it as surely as
  // a missing object: the platform's landing mints another rather than refuse,
  // and answers success.
  const canonicals = canonicalMismatches(declared, landedBundle, opts.pinned(declared));
  return {
    outcome: missing.length === 0 && !canonicals.some((c) => c.pinned) ? "passed" : "failed",
    missing,
    undeclared,
    suffixed: suffixedSiblings(declaredLabels(declared), undeclared),
    compared: result.compared,
    canonicals,
  };
}

/**
 * An error rendered as a one-line reason a run can print and a machine can read.
 *
 * Bounded and URL-free. The reason for an unverified landing reaches both the
 * terminal and the `--json` payload, and the throws behind it are not all this
 * CLI's own worded refusals — a transport failure can carry a slice of the
 * route's response body, and a signed link is URL-shaped by construction.
 */
function shortReason(err: unknown): string {
  // Without a read's "Nothing was changed — retry.": the landing already
  // happened, and a rerun of the promote lands a second branch.
  const raw = err instanceof Error ? withoutReadAftermath(err.message) : "the landed branch could not be read";
  const scrubbed = withoutUrls(raw)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");
  return scrubbed.length > 200 ? `${scrubbed.slice(0, 200)}…` : scrubbed;
}

/** The verification as a machine payload — one shape, however the run ended. */
function verificationPayload(v: LandingVerification): Record<string, unknown> {
  return {
    outcome: v.outcome,
    missing: v.missing,
    undeclared: v.undeclared,
    compared: v.compared,
    canonicals: v.canonicals,
    ...(v.reason === undefined ? {} : { reason: v.reason }),
  };
}

/**
 * An undeclared name that looks like the engine's own collision rename.
 *
 * When a landing cannot use the name it was given it keeps the stem and adds a
 * numeric suffix, so `authorize` arriving beside `authorize_01` is the shape of
 * a name that was taken — a materially different story from an unrelated object
 * someone added by hand, even though a name-keyed comparison files both as
 * undeclared. Called out as a suspicion, never as a verdict: this is as far as
 * comparing names can honestly go, and the reader is the one who can tell.
 */
function suffixedSiblings(declared: readonly string[], undeclared: readonly string[]): string[] {
  const stems = new Set(declared);
  return undeclared.filter((entry) => {
    // The suffix sits on the NAME, which a query's label follows with its group.
    const stripped = entry.replace(/_\d+( \(apiGroup .*\))?$/, "$1");
    return stripped !== entry && stems.has(stripped);
  });
}

/**
 * The omissions, and the property that makes the trade worth taking.
 *
 * The table check is not an omission: the release's tables are read against
 * the destination's before the confirmation, on both commands.
 */
function reportNotRun(
  target: "workspace" | "tenant" = "workspace",
  /** Whether a table finding follows; with none, the line says the check found nothing. */
  tablesBelow = true,
): void {
  // The table check is not among the omissions: both commands read the
  // release's tables against the destination's before confirming (see
  // `plan-disclosure.ts`).
  const lines = [
    tablesBelow
      ? "no plan preview, no prune scope — its table changes are checked against the destination below"
      : "no plan preview, no prune scope — its tables were checked against the destination, and it alters none there",
  ];
  // The same fact for the workspace row: the landing keeps the workspace's
  // name and description, but writes the release's workspace-level settings,
  // which no branch has its own copy of. `deploy --to workspace --branch`
  // withholds them; a promote cannot, because the server holds the archive.
  if (target === "workspace") {
    lines.push(
      "and the release's workspace settings (preferences, request history, realtime, workspace middleware) " +
        "apply to the whole workspace — they are shared by every branch; its name and description are kept",
    );
  }
  lines.push("what it has instead: a named release that came up and answered, and can be re-landed");
  // The lines as the warning's remedies, so `--json`'s message carries them
  // too (E2E pass 27: it stopped at the colon). Coded by the command it is
  // said for: `tenant deploy` said `promote.server-release`.
  warn(
    "This lands a release the server holds, so the local pre-flight did not run:",
    target === "tenant" ? "tenant.server-release" : "promote.server-release",
    lines,
  );
}

/**
 * One download of a release's archive, shared by everything in a run that needs
 * it — but cached ONLY once it has succeeded.
 *
 * A promote reads the same archive twice: once before the confirmation, to say
 * which env vars the landing would create, and once after, to check what
 * arrived. Those are the same immutable bytes addressed by the same id, so
 * fetching them twice is pure waste.
 *
 * A FAILURE is deliberately not cached. The first read is a courtesy that
 * degrades to one line and lets the promote continue; the second decides whether
 * the run can claim it knows what landed. Caching a rejection would let a
 * transient blip during the courtesy read — possibly minutes earlier, with a
 * confirmation prompt in between — deny the verification its own attempt and
 * report `unverified` on a landing that could have been checked.
 */
function archiveLoader(
  auth: ResolvedAuth,
  release: { id: number | undefined; name: string },
  host: { base: string; workspaceId: number },
): { decoded: () => Promise<unknown>; bytes: () => Promise<Uint8Array | undefined> } {
  let bytes: Uint8Array | undefined;
  let decoded: unknown;
  const loadBytes = async (): Promise<Uint8Array | undefined> => {
    if (bytes !== undefined) return bytes;
    if (release.id === undefined) return undefined;
    bytes = await downloadRelease(auth, {
      workspaceId: host.workspaceId,
      id: release.id,
      base: host.base,
    });
    return bytes;
  };
  return {
    bytes: loadBytes,
    decoded: async () => {
      if (decoded !== undefined) return decoded;
      const raw = await loadBytes();
      if (raw === undefined) return undefined;
      decoded = decodeWorkspaceArchive(raw);
      return decoded;
    },
  };
}

/**
 * The table changes a promote refuses without `--allow-shared-schema-changes`:
 * every one that alters a table live serves from, except a non-unique index
 * added or dropped — that changes how rows are found, not what they hold, so it
 * is said and lands like an addition. A UNIQUE index added stays gated: rows
 * that already share a value stop the landing.
 */
function gatedTableChanges(e: TableEffects): string[] {
  return alteringChanges({ ...e, indexChanges: e.indexChanges.filter((c) => c.action === "add" && c.unique) });
}

/** The steps a promote reports, in the order it runs them. `setLive` only when asked. */
type PromoteStep = "land" | "verify" | "setLive";

/** What a promote reports beside the shared result: what the landing check found. */
interface PromoteExtras {
  verification: Record<string, unknown>;
  /**
   * The tables whose rows the release carries and the landing does not write.
   * Present only for a seeded release. Names only — see the report beside
   * `reportEnvLanding` for why there is nothing to count.
   */
  seedRowsNotWritten: string[];
  /** Whether the confirmation was declined. Always present, so every ending reads one shape. */
  declined: boolean;
  /**
   * What the landing does to the tables every branch shares, live included
   * (see `plan-disclosure.ts`), or `null` when they could not be read.
   */
  tableEffects: Record<string, unknown> | null;
  /** The public URL slugs the landed branch serves elsewhere than live does — moved once it is live. */
  canonicalMoves: CanonicalMove[];
  /**
   * What the landing recorded in the project's lock for `deploy --to workspace
   * --prune` (see `lock/landed.ts`), or `null` — no lock here, or a release
   * whose identities do not match this project's lock.
   */
  landingRecord: LandingReport | null;
  /**
   * The branch that was live before `--set-live` switched to the landed one —
   * the label to set live again to roll back. Present only once the switch ran;
   * `null` when nothing addressable was live.
   */
  previousLive: string | null;
}

/**
 * The landing verifiably did not arrive whole. Thrown only after the result is
 * recorded, so it carries the exit code and nothing else — the wrapper emits the
 * result and rethrows this as itself.
 */
class LandingIncompleteError extends Error {
  override readonly name = "LandingIncompleteError";
  readonly exitCode = EXIT_VERIFICATION_FAILED;
}

/** What dropping `--branch` does on a promote, for the label refusals' last line. */
const PROMOTE_WITHOUT_BRANCH =
  "drop the flag to land on a new branch named after the release (add `--set-live` to make it live)";

/**
 * The names of the tables this project's entry seeds in code, or `undefined`
 * when there is no entry or it cannot be loaded. Read from the registry
 * (`tables()`), not compiled — the promote builds nothing.
 */
async function projectSeededTables(entry: string | undefined): Promise<ReadonlySet<string> | undefined> {
  if (entry === undefined) return undefined;
  const previous = setDiagnosticSink(() => {});
  try {
    const { loadDefault } = await import("./cli.js");
    const registry = (await loadDefault(entry)) as { tables?: () => ReadonlyArray<{ name?: unknown; seed?: unknown }> };
    if (typeof registry?.tables !== "function") return new Set();
    return new Set(
      registry
        .tables()
        .filter((t) => t.seed !== undefined && typeof t.name === "string")
        .map((t) => t.name as string),
    );
  } catch {
    return undefined;
  } finally {
    setDiagnosticSink(previous);
  }
}

/**
 * What to run for a promoted release's rows, which the promote does not write
 * (E2E pass 26). `workspace reset-tables` writes the rows the PROJECT seeds, so
 * it is offered only for the tables the project seeds — for any other it is
 * refused as "not a seeded table". The release's own rows land with a deploy
 * of the release: this project's ephemeral, or a tenant.
 *
 * `afterLanding` is the reset-tables line, said only once the landing
 * succeeded: before the confirmation it was a next step for a promote that a
 * decline then never made (E2E pass 27).
 */
async function seedRowRemedies(
  release: { readonly name: string },
  tables: ReadonlyArray<{ name: string; guid?: string | undefined }>,
  flags: string,
  /** `--entry`, when one named the project; else the project's own. */
  named: string | undefined,
): Promise<{ before: string[]; afterLanding?: string }> {
  const entry = named ?? resolveProjectEntry(process.cwd());
  const seededHere = await projectSeededTables(entry);
  const resettable = seededHere === undefined ? [] : tables.filter((t) => seededHere.has(t.name) && t.guid !== undefined);
  const r = shellWord(release.name);
  const before = [
    `The release's rows land with a deploy of the release: \`xanosdk deploy release:${r}${flags}\` on this ` +
      `project's ephemeral, or \`xanosdk tenant deploy <tenant> ${r}${flags}\` on a tenant.`,
  ];
  if (resettable.length === 0) return { before };
  const one = resettable.length === 1;
  return {
    before,
    afterLanding:
      `This project seeds ${resettable.map((t) => t.name).join(", ")} in code: ` +
      `\`xanosdk workspace reset-tables ${shellWord(pastePath(entry!))}` +
      `${resettable.map((t) => ` --table ${shellWord(t.guid!)}`).join("")} --write${flags}\` ` +
      `writes ${one ? "its" : "their"} project rows into the workspace.`,
  };
}

/**
 * Refuse a release whose name the landing route cannot address (see
 * `unpromotableReleasePart`) before anything is checked or sent: the landing
 * would end in a bare 404 or 400 after every check had passed. `release create`
 * refuses such names, so this one was cut by another client or an older CLI.
 */
function assertPromotableName(name: string, args: ParsedArgs): void {
  const part = unpromotableReleasePart(name);
  if (part === undefined) return;
  const flags = contextFlags(args);
  const renamed = promotableReleaseName(name);
  throw new UsageError(
    `Release "${name}" cannot be promoted: its name holds \`${part}\`, and the route a promote lands a ` +
      `release by cannot address a name holding ${UNPROMOTABLE_RELEASE_PARTS}. Nothing was sent.\n` +
      `Cut it again as \`xanosdk release create ${shellWord(renamed)}\` from the source \`xanosdk release show ` +
      `${shellWord(name)}${flags}\` names, and promote that.` +
      (untenantDeployableReleasePart(name) === undefined
        ? ` \`xanosdk tenant deploy <tenant> ${shellWord(name)}${flags}\` still lands this one on a tenant.`
        : ""),
    { hintFor: { command: "promote" } },
  );
}

export async function runPromoteCommand(args: ParsedArgs): Promise<void> {
  assertNoMergeFlags(args);
  assertNoBackupFlag(args);
  // Without `--set-live` a promote never touches live, so a precondition on
  // what live is would guard nothing — and an accepted guard that guards
  // nothing reads as protection the run did not have.
  if (args.expectLive !== undefined && args.setLive !== true) {
    throw new UsageError(
      `\`--expect-live\` guards the switch to live, and without \`--set-live\` a promote never ` +
        `switches: the release lands on a branch of its own and live keeps serving. ` +
        `Add \`--set-live\`, or drop \`--expect-live\`.`,
      { hintFor: { command: "promote" } },
    );
  }

  // A typed label is checked before anything is read — it costs nothing, and a
  // refusal after the credential and the release lookup would spend both on a
  // label that was never going to be sent.
  const typedBranch =
    args.branch === undefined ? undefined : assertUsableBranchLabel(args.branch, "--branch", PROMOTE_WITHOUT_BRANCH);

  const raw = args.positionals[0];
  if (raw === undefined || raw === "") {
    throw new UsageError(
      `\`xanosdk promote\` needs a release name. Run \`xanosdk release list${contextFlags(args)}\` to see them.`,
      { hintFor: { command: "promote" } },
    );
  }
  assertOneName(raw, "the release name", { args, helpFor: { command: "promote" } });
  // Exactly one kind is accepted, so a bare name is unambiguous and a `release:`
  // prefix is allowed but never required.
  const source = parseSource(raw, ["release"], { command: "promote" });
  // `--entry` names the project whose lock records the landing — a nested
  // backend from a directory that is no project itself. Checked before the
  // credential: a typo costs nothing to answer.
  if (args.entryPath !== undefined && (!existsSync(args.entryPath) || !statSync(args.entryPath).isFile())) {
    const Refusal = existsSync(args.entryPath) ? UsageError : LocalFileNotFoundError;
    throw new Refusal(
      `\`--entry ${pastePath(args.entryPath)}\` ${existsSync(args.entryPath) ? "is not a file" : "does not exist"}. ` +
        `Pass the backend's entry file (its \`index.ts\`). Nothing was sent.`,
      { hintFor: { command: "promote" } },
    );
  }
  const auth = await getAccessToken(args);
  const resolved = await resolveSource(source, async () => auth);
  const release = resolved.release;
  if (release === undefined) throw new Error(`promote: resolved no release for "${raw}".`);
  assertPromotableName(release.name, args);

  // `--set-live` does not need `--branch`: the label is derived, so
  // `--set-live` alone is the one-shot to production — land the release and
  // serve it. It stays behind the same confirmation as any other landing that
  // changes what the runtime serves.
  const setLiveRequested = args.setLive === true;

  // The destination, before anything else this command says. A promote lands on
  // the workspace the CREDENTIAL is bound to — `resolved.target` describes the
  // release being read, which lives on the same instance and workspace, and
  // `deployRelease` addresses that credential's binding — so this is the one
  // adopter where the two coincide. Named explicitly anyway, so the day a
  // promote can name a destination the line does not have to be rediscovered.
  const destination: WriteTarget = { ...credentialWriteTarget(auth), kind: "workspace" };
  // Under a headline: the indented "on …" line printed first, with nothing
  // above it, read as the tail of whatever the terminal showed before.
  step(`Promoting release ${release.name}`);
  discloseWriteTarget(destination);

  // The lock the landing is recorded in: beside `--entry`, else the project's.
  const lockPath = landingLockPath(args, args.entryPath === undefined ? {} : { entryFile: args.entryPath });
  // From a directory that is no project, with backends below it, nothing
  // would record the landing — said before it lands, with the flag that does.
  if (lockPath === undefined && args.noLock !== true) {
    const { nestedBackendEntries } = await import("./tracked-backend.js");
    const nested = nestedBackendEntries(process.cwd());
    if (nested.length > 0) {
      warn(
        `No landing will be recorded: this directory is no project, so no xano.lock records what lands ` +
          `(a later \`--prune\` deletes only what a lock records).`,
        "promote.no-landing-record",
        nested.length === 1
          ? [`The backend below it: \`--entry=${shellWord(nested[0]!)}\` records the landing in its lock, or run from its directory.`]
          : [`Backends below it: ${nested.join(", ")}. Name the one this release came from with \`--entry=<entry>\`, or run from its directory.`],
      );
    }
  }
  /** `--entry` as typed, carried into every rerun this promote prints. */
  const entryFlag = args.entryPath === undefined ? "" : ` --entry=${shellWord(pastePath(args.entryPath))}`;

  // Every promote lands on a NAMED branch, whether or not the caller named one:
  // an unnamed one is unaddressable (see `derivedPromoteLabel`). So the label is
  // resolved before anything is sent, and checked the same way either way.
  // A promote without `--branch` never lands on live — it derives a fresh label
  // — so the release path's "drop the flag to land on live" would be wrong here.
  // The TRIMMED, validated label is the one sent and reported: `--branch " x "`
  // lands on `x`, never on a padded branch nothing can name afterwards.
  const branch =
    typedBranch ?? assertUsableBranchLabel(derivedPromoteLabel(release.name, new Date()), "--branch", PROMOTE_WITHOUT_BRANCH);
  const listFrom = { baseUrl: resolved.target.base, workspaceId: resolved.target.workspaceId };

  // `branch` is the result's handle on what landed, and always the label —
  // derived or given — because a caller resolving an unknown landing has to
  // look for exactly that label.
  const op = createOperation<PromoteStep, PromoteExtras>({
    operation: "promote",
    destination,
    release: { instance: auth.instance, workspaceId: auth.workspaceId, id: release.id, name: release.name },
    branch,
    steps: setLiveRequested ? ["land", "verify", "setLive"] : ["land", "verify"],
    // Verification checks the landing; it does not produce it. One that could
    // not run leaves the landing done (and exit 0, as before), rather than
    // sending every caller on an instance with an unreadable export to resolve
    // a write that already answered.
    checks: ["verify"],
    extras: { declined: false, landingRecord: null, tableEffects: null, canonicalMoves: [] },
  });

  // What a landed branch costs a run that ended `no`: it is still there, and a
  // promote never deletes. Named with its removal so the caller does not have
  // to work out that a failed promote left something behind.
  // Every printed command carries the run's credential flags: a bare one acts on
  // the default profile's workspace, not the one this promote landed in.
  const flags = contextFlags(args);
  // A next step that asks before it writes, as it runs from here: with `--yes`
  // when this run was not asked either (see `pipedYes`).
  const yesFlags = `${pipedYes(args)}${flags}`;
  const residue = { name: branch, removeWith: `xanosdk workspace branch delete ${shellWord(branch)}${yesFlags}` };

  /** This promote with `--yes`, on `onBranch` (none: a bare rerun derives a fresh label). */
  const promoteRerun = (onBranch: string | undefined, allowShared = args.allowSharedSchemaChanges === true): string =>
    `xanosdk promote ${shellWord(release.name)}` +
    `${onBranch === undefined ? "" : ` --branch ${shellWord(onBranch)}`}` +
    `${setLiveRequested ? " --set-live" : ""}` +
    `${args.expectLive === undefined ? "" : ` --expect-live ${shellWord(args.expectLive)}`}` +
    `${allowShared ? " --allow-shared-schema-changes" : ""}` +
    ` --yes${args.json === true ? " --json" : ""}${entryFlag}${flags}`;

  /**
   * A landing the instance refused as a duplicate record: another landing
   * created the label between this run's check and its write. The refusal is
   * the label's uniqueness, and the landing is all-or-nothing, so nothing of
   * this run landed — a conflict (exit 2), not an unknown outcome.
   */
  const labelRace = async (err: unknown): Promise<unknown> => {
    if (!(err instanceof ReleaseHttpError) || err.status !== 500 || !/duplicate record/i.test(err.message)) return err;
    const now = await listBranchListing(auth, listFrom).catch(() => undefined);
    if (now === undefined || findBranch(now.branches, branch) === undefined) return err;
    const free = typedBranch === undefined ? undefined : freeBranchLabel(now.branches, branch);
    return new BranchTakenError(
      `Another landing created branch "${branch}" while this one was landing, and the instance refused the ` +
        `duplicate label. Nothing of release ${release.name} landed.\n` +
        (free === undefined
          ? `Re-run as \`${promoteRerun(undefined)}\` — it derives a fresh label.`
          : `Pick a label that is free: \`${promoteRerun(free)}\`.`),
      branch,
      free,
    );
  };

  // One read settles every unknown this command can end on, because the label
  // is fixed before anything is sent. Absent: nothing landed, and the re-run is
  // PINNED to the label — a derived one carries a timestamp, so a bare re-run
  // would land a second branch. Present but not live: it landed and was not
  // checked (or not switched), so it is read back before anything serves it.
  const resolveWith = `xanosdk workspace branch list --json${flags}`;
  const resolveSteps = [
    `If "${branch}" is absent, nothing landed: re-run as \`${promoteRerun(branch)}\`.`,
    `If it is present and not live, check it with \`xanosdk workspace export --branch ${shellWord(branch)}${flags}\` ` +
      `before \`xanosdk workspace branch set-live ${shellWord(branch)}${yesFlags}\`.`,
  ];

  /**
   * Refuse a landing that would alter tables live serves from, unless
   * `--allow-shared-schema-changes` says the reader knows. A refusal rather
   * than a prompt, as `deploy --to workspace --branch` refuses the same change
   * set: someone who typed `--yes` has already answered every prompt. An
   * unreadable target refuses too — not knowing is not evidence of none.
   * Additions (new tables and columns) alter nothing there and are only said.
   */
  const assertTablesAcknowledged = (read: { effects: TableEffects } | { failure: string }): void => {
    if (args.allowSharedSchemaChanges === true) return;
    const rerun = promoteRerun(typedBranch, true);
    if ("failure" in read) {
      throw new CliError(
        "SDK_SHARED_SCHEMA_CHANGE",
        `Refusing to promote "${release.name}": whether it changes your workspace's tables is unknown — ${read.failure}.\n` +
          `Tables are shared by every branch, so a promote applies the release's table definitions to live as ` +
          `soon as it lands, before any \`--set-live\`. A failed read is not evidence that it changes none.\n` +
          `Retry when the instance answers, or land it without the check: \`${rerun}\`.`,
        { exitCode: 2, details: { reason: "tables-unreadable", landed: false, declined: false, changes: null } },
      );
    }
    const gated = gatedTableChanges(read.effects);
    if (gated.length === 0) return;
    // The whole change set, additions included: a dropped column listed without
    // the column added beside it hides that the pair reads as a rename.
    const changes = [...gated, ...additiveChanges(read.effects)];
    const paired = droppedAndAdded(read.effects);
    const one = gated.length === 1;
    throw new CliError(
      "SDK_SHARED_SCHEMA_CHANGE",
      `Refusing to promote "${release.name}": it alters ${one ? "a table" : "tables"} your live ` +
        `workspace serves from. A promote lands logic on a branch of its own, but tables are shared by every ` +
        `branch — ${one ? "this applies" : "these apply"} to live as soon as it lands, before any ` +
        `\`--set-live\`, and are not undone by deleting the branch:\n` +
        `${changes.map((c) => `  ${c}`).join("\n")}\n` +
        paired.map((p) => `${renameHint(p)}\n`).join("") +
        `\`--yes\` does not cover this. Cut a release without ${one ? "it" : "them"}, or land ` +
        `${one ? "it" : "them"} knowing live changes too: \`${rerun}\`.`,
      {
        exitCode: 2,
        details: { reason: "shared-schema-changes", landed: false, declined: false, changes, pairedColumns: paired },
      },
    );
  };

  /**
   * A landing the instance stopped on a data constraint: the workspace's rows
   * break an index or a required field the release declares. The landing is
   * all-or-nothing — no branch is made and live is as it was — and it stops
   * the same way again until the rows change, so it is a conflict (exit 2),
   * not an unknown outcome.
   */
  const constraintRefusal = (err: unknown, stop: ConstraintStop): CliError => {
    const where = constraintWhere(stop);
    return new CliError(
      "SDK_CONSTRAINT_VIOLATION",
      `Release "${release.name}" did not land: your workspace's rows break ${CONSTRAINT_PHRASE[stop.kind]} it ` +
        `declares${where}. Nothing landed — no branch was made, and live is as it was.\n` +
        `${CONSTRAINT_FIX[stop.kind]}, then promote again.`,
      {
        exitCode: 2,
        cause: new SettledWriteFailure(err instanceof Error ? err.message : String(err), { cause: err }),
        details: {
          landed: false,
          declined: false,
          constraint: stop,
          ...(stop.kind === "unique" ? { uniqueViolation: true } : {}),
        },
      },
    );
  };

  /** The project's lock as on disk, or `undefined` (none, `--no-lock`, unreadable). */
  const projectLock = (): LockFile | undefined => {
    if (lockPath === undefined || !existsSync(lockPath)) return undefined;
    try {
      return readLockFile(lockPath);
    } catch {
      return undefined;
    }
  };
  /** The guids whose public URL slug the project pins in code, by its lock. */
  const pinnedIn = (declared: unknown): ReadonlySet<string> =>
    new Set(pinnedCanonicalGuids(JSON.stringify(declared), projectLock(), false));

  /**
   * Refuse a release whose names or pinned public URL slugs the workspace
   * already gives to other objects — the check `deploy --to workspace` runs,
   * run against the release's own archive and the branch it will land on.
   * The platform's landing settles both by inventing (a suffixed second
   * object, a minted slug) and answers success, so this is the only point at
   * which either can be refused. A check that cannot run is said, not refused:
   * the read-back after the landing still fails a pinned slug that did not take.
   */
  const assertIdentitiesFree = async (
    archive: ReturnType<typeof archiveLoader>,
    loadLive: () => Promise<ExportedBundle>,
  ): Promise<ReleaseIdentityCheck> => {
    let bytes: Uint8Array | undefined;
    let bundle: unknown;
    try {
      bytes = await archive.bytes();
      bundle = await archive.decoded();
    } catch {
      // Dropped, never printed: a failure here can carry the signed download link.
      bytes = undefined;
    }
    let check: ReleaseIdentityCheck;
    if (bytes === undefined || bundle === undefined) {
      check = { checked: false, reason: "the release archive could not be read" };
    } else {
      let typed: Uint8Array | undefined;
      try {
        typed = asWorkspaceArchive(bytes, release.name);
      } catch {
        typed = undefined;
      }
      check =
        typed === undefined
          ? { checked: false, reason: "the release archive carries no workspace to plan" }
          : await assertReleaseIdentitiesFree(args, auth, {
              archive: typed,
              bundle,
              branch,
              lockPath,
              live: await loadLive().catch(() => undefined),
              subject: `promote "${release.name}"`,
              verb: "promote",
              remedySuffix:
                `A release's names and slugs are fixed when it is cut: make the change in the project, deploy ` +
                `it, cut a new release from it with \`xanosdk release create\`, and promote that one.`,
            });
    }
    if (!check.checked) {
      warn(
        `Whether this release's names and pinned public URL slugs are free in your workspace was not checked — ${check.reason}.`,
        "promote.identities-unchecked",
        [
          `A name another object holds lands as a suffixed second object, and a pinned slug another workspace serves lands under a minted one.`,
          `The landed branch is read back afterwards, and a pinned slug it does not serve fails the promote.`,
        ],
      );
    }
    return check;
  };

  const machine = isMachineOutput(args);
  let declined = false;
  /** The release's table effects on the workspace, once read (see `assertTablesAcknowledged`). */
  let landingEffects: TableEffects | undefined;
  /** The reset-tables next step, said only after a landing succeeds (see `seedRowRemedies`). */
  let resetTablesAfterLanding: string | undefined;
  try {
    await runOperation(
      op,
      { machine, resolveWith, resolveSteps, what: `the landing of ${release.name}` },
      async () => {
        op.begin("land");
        // The server answers a label collision with a fatal 500, which reads as a
        // broken instance rather than a naming mistake. Ask first. The same read
        // answers `--expect-live`, so a mismatch is refused with nothing sent.
        const before = await listBranchListing(auth, listFrom).catch(async (err: unknown) => {
          throw await unansweredBranchRead(err, args);
        });
        // A taken label or an unmet `--expect-live` carries what it collided
        // with under `error.details.conflictsWith`.
        assertBranchAbsent(before.branches, branch);
        if (args.expectLive !== undefined) {
          const mismatch = liveMismatch(before, args.expectLive);
          if (mismatch !== undefined) {
            throw liveBranchMismatch(
              `\`--expect-live ${args.expectLive}\` does not hold: ${mismatch.why}. Nothing was landed.\n` +
                `Check what is serving with \`xanosdk workspace branch list${flags}\`, then promote again.`,
              mismatch.live,
            );
          }
        }

        // One download, shared with the landing check below — same release, same
        // id, same immutable bytes. One read of the workspace too, shared by the
        // env and table checks.
        const archive = archiveLoader(auth, release, resolved.target);
        const loadArchive = archive.decoded;
        const loadLive = readOnce(() =>
          exportWorkspaceBundle(auth, {
            base: auth.instance,
            workspaceId: auth.workspaceId,
            label: "reading your workspace",
            safeErrors: true,
          }),
        );

        // Read first, so the line that says the table changes are checked below
        // says so only when something IS below (as `tenant deploy` says it).
        const firstRead = await releaseTableEffects(loadArchive, loadLive);
        reportNotRun(
          "workspace",
          !("effects" in firstRead) ||
            alteringChanges(firstRead.effects).length + additiveChanges(firstRead.effects).length > 0,
        );

        // BEFORE the confirmation: the point is that the env vars this creates
        // are part of what the user is agreeing to, not something they read
        // afterwards.
        await reportEnvLanding(auth, {
          release: { id: release.id, name: release.name },
          releaseHost: resolved.target,
          target: { base: resolved.target.base, workspaceId: auth.workspaceId },
          targetLabel: "your workspace",
          envSetTo: ` --to workspace --yes${flags}`,
          loadArchive,
          loadLive,
        });

        // Also before the confirmation, and for the same reason: rows the release
        // carries are part of what the reader thinks they are landing. A promote
        // lands LOGIC on a branch of its own, and tables are shared by every
        // branch, so the landing writes none of them. Said rather than left as
        // an absence, because a seeded release that promoted without a word read
        // as rows delivered.
        // Only tables the manifest counts rows for (E2E pass 27: "rows for 2
        // tables" of a release whose second table held none); a table with no
        // recorded count is kept — absence of a count is not zero rows.
        const seededTables = (release.seededTables ?? []).filter((t) => t.count !== 0);
        const seeded = seededTables.map((t) => t.name);
        if (seeded.length > 0) {
          op.set("seedRowsNotWritten", seeded);
          const remedies = await seedRowRemedies(release, seededTables, flags, args.entryPath);
          resetTablesAfterLanding = remedies.afterLanding;
          warn(
            `"${release.name}" carries rows for ${seeded.length} table${seeded.length === 1 ? "" : "s"} ` +
              `(${seeded.join(", ")}), and they are not written: a promote lands logic on a branch, ` +
              `and tables are shared by every branch.`,
            "promote.seed-rows",
            remedies.before,
          );
        }

        // Before the table check and the confirmation: a name or a pinned slug
        // the workspace already gives to something else is a landing that
        // cannot be what the release says, whatever its tables do.
        await assertIdentitiesFree(archive, loadLive);

        // Tables carry no branch: the landing applies the release's table
        // definitions to the one set every branch — live included — serves
        // from, the moment it lands and whether or not it is ever made live.
        // Measured: a dropped column's values went, a retyped one re-read, a
        // removed enum value read null, all on live before any `set-live`.
        // A failed read is not kept: the check gets its own attempt.
        const tables = "effects" in firstRead ? firstRead : await releaseTableEffects(loadArchive, loadLive);
        // A read that got no answer is the instance's state, not the release's:
        // exit 8 with this run as the rerun, as the branch read above says it.
        if ("failure" in tables && tables.cause !== undefined && args.allowSharedSchemaChanges !== true) {
          const what = tables.read === "archive" ? `release "${release.name}"'s archive` : "your workspace";
          const unanswered = await unansweredBranchRead(tables.cause, args, what);
          if (unanswered !== tables.cause) throw unanswered;
        }
        landingEffects = "effects" in tables ? tables.effects : undefined;
        op.set("tableEffects", landingEffects === undefined ? null : tableEffectsPayload(landingEffects));
        assertTablesAcknowledged(tables);
        const tableChanges = landingEffects === undefined ? 0 : alteringChanges(landingEffects).length + additiveChanges(landingEffects).length;
        if (landingEffects !== undefined) {
          discloseTableEffects(landingEffects, {
            subject: "the promote",
            additiveWhere: "the tables every branch shares — live included, as soon as it lands",
          });
          await assertStorageModesKept(landingEffects.storageChanges, tableRowCounter(auth, { workspaceId: auth.workspaceId, base: auth.instance }), {
            target: "your workspace",
            subject: "the promote",
          });
        }

        // A public URL slug belongs to the branch: the move reaches clients the
        // moment the branch is live — at once under `--set-live`.
        const moves = await Promise.all([loadArchive(), loadLive()]).then(
          ([archive, live]) => releaseCanonicalMoves(archive, live),
          () => [],
        );
        op.set("canonicalMoves", moves);
        discloseCanonicalMoves(moves, {
          subject: "the promote",
          will: setLiveRequested ? "will" : "would",
          when: setLiveRequested ? "as it goes live" : "once its branch is made live",
        });

        if (args.yes !== true) {
          const ok = await confirm(
            `Land release "${release.name}" in your workspace` +
              `${typedBranch === undefined ? "" : ` on branch "${typedBranch}"`}` +
              `${setLiveRequested ? ", and make it live" : ""}` +
              `${tableChanges === 0 ? "" : `, applying its ${tableChanges === 1 ? "table change" : `${tableChanges} table changes`} to the live workspace too`}?` +
              movesClause(moves, setLiveRequested ? "It" : "Once live, it"),
            {
              flag: "--yes",
              // Off a terminal, the details `tenant deploy` and `deploy --to`
              // carry (E2E pass 29: a bare SDK_USAGE), and this promote with `--yes`.
              refusal: {
                details: { landed: false, declined: false },
                rerun: promoteRerun(typedBranch),
              },
            },
          );
          if (!ok) {
            // Returned with the land step open and unsent, which the result
            // records as `no` — true, and the reader's own choice, so the run
            // still exits cleanly below.
            info("Promote cancelled — nothing was written.");
            op.set("declined", true);
            declined = true;
            return;
          }
        }

        step(`Landing ${release.name} in your workspace on branch "${branch}"`);
        // ALWAYS with set-live off, even when the caller asked for it. Landing
        // and serving in one server call would put an empty branch in front of
        // traffic before anything could check it. Splitting it in two is what
        // makes a failed verification cost nothing: the live branch is still
        // serving because this call never touched it.
        //
        // A 5xx here stays `unknown`, not `no` (checked 2026-09-22 against the
        // engine). The landing is all-or-nothing, so no half-built branch is ever
        // left. But the server still does work after the branch commits, and a
        // failure there, a commit whose acknowledgement is lost, or a gateway
        // timeout on a long import all answer 5xx for a branch that DID land. So
        // a branch the resolver finds under the label is complete, and absence is
        // the only thing a 5xx cannot prove.
        op.sending();
        const landed = await deployRelease(auth, {
          workspaceId: auth.workspaceId,
          name: release.name,
          branch,
          setLive: false,
        }).catch(async (err: unknown) => {
          const stop = constraintStop(err);
          if (stop !== undefined) throw constraintRefusal(err, namedConstraint(stop, landingEffects));
          throw await labelRace(err);
        });
        op.finish("land");
        // The landing's own id when it reports one: it addresses the release by
        // NAME, and a name can be reused once its release is deleted.
        op.setRelease({
          instance: auth.instance,
          workspaceId: auth.workspaceId,
          id: landed.id ?? release.id,
          name: landed.name,
        });

        try {
          await afterLanding({ landedName: landed.name, loadArchive, liveBefore: liveBranchLabel(before.branches) });
        } catch (err) {
          // Anything after a landing of `yes` that ends the run `no` leaves the
          // branch behind. A write whose outcome is unknown does not: the branch
          // may be serving, and it is not this command's to call it residue.
          if (classifyFailure(err, { writeSent: op.inProgressSent }) === "no") op.setResidue(residue);
          throw err;
        }
      },
    );
  } catch (err) {
    if (declined) return;
    throw err;
  }

  /** Verify, switch when asked and allowed, and say what happened. */
  async function afterLanding(ctx: {
    landedName: string;
    loadArchive: () => Promise<unknown>;
    /** The live branch's label as read before the landing. */
    liveBefore: string | undefined;
  }): Promise<void> {
    op.begin("verify");
    const verification = await verifyLanding(auth, { loadArchive: ctx.loadArchive, branch, pinned: pinnedIn });
    op.set("verification", verificationPayload(verification));
    // `unverified` is `unknown`, not `no`: nothing is known to be wrong, and
    // what is unknown is exactly what `workspace export --branch` reads back.
    op.finish(
      "verify",
      verification.outcome === "passed" ? "yes" : verification.outcome === "failed" ? "no" : "unknown",
    );
    if (verification.outcome === "failed") op.setResidue(residue);

    // What this project now has on the workspace, for a later `--prune` — only
    // when the release is verifiably this project's (every identity it carries
    // matches the lock), and never for a landing known to be incomplete. A
    // promote is additive, so it adds to the record.
    if (verification.outcome !== "failed") {
      const archive = await ctx.loadArchive().catch(() => undefined);
      if (archive !== undefined) {
        op.set(
          "landingRecord",
          recordForeignLanding({
            lockPath,
            instance: auth.instance,
            dest: { kind: "workspace", workspaceId: auth.workspaceId },
            bundle: archive,
            mode: "merge",
          }),
        );
      }
    }

    // Serving requires a PASS, not merely the absence of a failure. `unverified`
    // means the check could not run, so a branch served on it reaches
    // production exactly as unchecked as it did before this command learned to
    // look — which is the hazard the two-step landing exists to remove. This
    // costs no capability: the operator can still serve it deliberately with
    // `workspace branch set-live`, which is one command and says what it does.
    let live = false;
    let rollback: string | undefined;
    if (setLiveRequested) {
      if (verification.outcome !== "passed") {
        // Declined, deliberately — recorded `no`, and the run as a whole is
        // `no`, so the landed branch is residue whichever check stopped it.
        op.finish("setLive", "no");
        op.setResidue(residue);
      } else {
        op.begin("setLive");
        let previousLive = ctx.liveBefore;
        if (args.expectLive !== undefined) {
          // Re-read as the last thing before the switch, because the first read
          // was before a landing and a verification that can take minutes. It
          // narrows the window; it does not close it — nothing on the server
          // makes a check and a switch one step.
          const now = await listBranchListing(auth, listFrom);
          previousLive = liveBranchLabel(now.branches);
          const drift = liveMismatch(now, args.expectLive);
          if (drift !== undefined) {
            op.finish("setLive", "no");
            op.setResidue(residue);
            throw liveBranchMismatch(
              `Landed and verified ${ctx.landedName} on branch "${branch}", but did not make it live: ` +
                `\`--expect-live ${args.expectLive}\` no longer holds — ${drift.why}. Live changed after the ` +
                `landing; the check is not atomic, so it is re-read before switching and the switch refused.\n` +
                `Nothing was switched. Serve it deliberately with \`xanosdk workspace branch set-live ${branch}${yesFlags}\`, ` +
                `or remove it with \`xanosdk workspace branch delete ${branch}${yesFlags}\`.`,
              drift.live,
            );
          }
        }
        step(`Making branch "${branch}" live`);
        op.sending();
        try {
          await setLiveBranch(auth, { baseUrl: auth.instance, workspaceId: auth.workspaceId, label: branch });
        } catch (err) {
          // Not a failed landing — the release arrived and verified, and only
          // the pointer move is in question. Said so before the throw reaches
          // the failure line, which would otherwise read as nothing happened.
          error(`Landed and verified ${ctx.landedName}, but making branch "${branch}" live failed.`);
          if (classifyFailure(err, { writeSent: true }) === "no") {
            detail(`The branch is there and checked; only the live pointer did not move.`);
            detail(`Retry with \`xanosdk workspace branch set-live ${branch}${yesFlags}\`.`);
          } else {
            detail(`Whether the live pointer moved is not known — \`xanosdk workspace branch list${flags}\` shows it.`);
          }
          throw err;
        }
        op.finish("setLive");
        live = true;
        // The branch serving before the switch, and the command that serves it again.
        op.set("previousLive", previousLive ?? null);
        rollback = previousLive === undefined ? undefined : setLiveRollback(previousLive, args);
      }
    }

    const substituted = verification.canonicals.filter((c) => !c.pinned);
    if (substituted.length > 0) {
      // Not pinned in code, so a preference the instance may settle — still
      // said, because anything built from the declared value points elsewhere.
      warn(
        `Public URL slug${substituted.length === 1 ? "" : `s (${substituted.length})`} the release declares ` +
          `${substituted.length === 1 ? "is" : "are"} served under another value (not pinned in code, so the instance chose):`,
        "promote.canonical-substituted",
        substituted.map((c) => `${c.kind} ${c.name}: serves "${c.served}", declared "${c.declared}"`),
      );
    }
    if (!machine) renderLanding({ landedName: ctx.landedName, verification, live, rollback });
    else if (verification.outcome !== "failed") {
      // The tick on stderr off a terminal too, as `tenant deploy` and `release
      // create` print theirs: the result on stdout carries the rest.
      success(`Landed ${ctx.landedName}`);
      detail(whereItLanded(live));
      if (rollback !== undefined) detail(rollback);
      if (verification.outcome === "unverified") warnUnverified(verification);
    }

    if (verification.outcome === "failed") {
      const unserved = verification.canonicals.filter((c) => c.pinned);
      const what = [
        ...(verification.missing.length === 0
          ? []
          : [`${verification.missing.length} declared object${verification.missing.length === 1 ? "" : "s"} did not arrive`]),
        ...(unserved.length === 0
          ? []
          : [
              `${unserved.length} public URL slug${unserved.length === 1 ? "" : "s"} pinned in code ` +
                `${unserved.length === 1 ? "is" : "are"} not served (${unserved.map((c) => `${c.kind} ${c.name}: "${c.served}", not "${c.declared}"`).join("; ")})`,
            ]),
      ];
      throw new LandingIncompleteError(`Landed ${ctx.landedName} on branch "${branch}", but ${what.join(", and ")}.`);
    }
  }

  /**
   * Where the release landed, and — when it is not live — the command that
   * serves it, so the line ends on a step the reader can run.
   */
  function whereItLanded(live: boolean): string {
    return live
      ? `live on branch ${branch}`
      : `on branch ${branch}, not live yet — serve it with \`xanosdk workspace branch set-live ${shellWord(branch)}${yesFlags}\` ` +
          `(a promote with \`--set-live\` lands and serves in one run)`;
  }

  /**
   * An unverified landing, said on both channels. Distinct from a tick,
   * deliberately: the landing happened; what is unknown is what is ON it, and
   * a reader who skims this must not come away thinking it was checked — nor
   * that running the promote again is the fix (that lands a second branch).
   */
  function warnUnverified(verification: LandingVerification): void {
    warn(
      `Contents NOT verified — the release landed, but verification could not run (${verification.reason}) — ` +
        `check what landed with \`xanosdk workspace export --branch ${shellWord(branch)} --path -${flags}\``,
      "promote.unverified",
      // The one place this command declines something the caller explicitly
      // asked for, so it says both halves: what it did not do, and the command
      // that does it anyway once they have decided the risk is theirs to take.
      setLiveRequested
        ? [
            `NOT made live — \`--set-live\` serves a landing that was checked, and this one could not be.`,
            `Serve it deliberately with \`xanosdk workspace branch set-live ${branch}${yesFlags}\`.`,
          ]
        : [],
    );
  }

  /** The human view of a finished landing. The machine view is the result. */
  function renderLanding(r: {
    landedName: string;
    verification: LandingVerification;
    live: boolean;
    rollback: string | undefined;
  }): void {
    const { verification } = r;
    if (verification.outcome === "failed") {
      // Not `success`. The landing is real but incomplete, and the one thing
      // the reader must not do is act on it. The headline is the thrown error,
      // printed last as the run's failure line.
      if (verification.missing.length > 0) {
        warn(
          `${verification.missing.length} declared object${verification.missing.length === 1 ? "" : "s"} did not arrive:`,
          "promote.missing-objects",
          verification.missing,
        );
      }
      const unserved = verification.canonicals.filter((c) => c.pinned);
      if (unserved.length > 0) {
        warn(
          `Public URL slug${unserved.length === 1 ? "" : `s (${unserved.length})`} pinned in code ` +
            `${unserved.length === 1 ? "is" : "are"} served under another value — every route a frontend builds from ` +
            `${unserved.length === 1 ? "it" : "them"} answers 404 there:`,
          "promote.canonical-not-served",
          [
            ...unserved.map((c) => `${c.kind} ${c.name}: serves "${c.served}", declared "${c.declared}"`),
            `The slug is held elsewhere on this instance (slugs are unique per instance). Change the \`canonical\` in ` +
              `code to one nothing serves, or free it where it is held; then deploy, cut a new release and promote that.`,
          ],
        );
      }
      blank();
      if (setLiveRequested) {
        // Said out loud rather than left as the absence of a line. A reader who
        // asked for `--set-live` and got an error needs to know the thing they
        // were afraid of did not happen.
        detail(`Nothing was made live — the branch that was serving before is still serving.`);
      }
      detail(`Nothing here is cleaned up automatically: the branch is the evidence for why the landing was partial.`);
      detail(`Remove it with \`xanosdk workspace branch delete ${branch}${yesFlags}\` once you have looked.`);
      return;
    }

    success(`Landed ${r.landedName}`);
    detail(whereItLanded(r.live));
    if (r.rollback !== undefined) detail(r.rollback);
    if (resetTablesAfterLanding !== undefined) info(resetTablesAfterLanding);
    if (verification.outcome === "unverified") {
      warnUnverified(verification);
    } else {
      detail(`Verified: all ${verification.compared} declared object(s) arrived.`);
    }
    if (verification.undeclared.length > 0) {
      // Never a failure. A release deploy adds a branch and drops nothing, so a
      // branch legitimately carries anything created since the release was cut.
      const suspicious = verification.suffixed;
      detail(
        `${verification.undeclared.length} object(s) on the branch the release did not declare: ` +
          verification.undeclared.join(", "),
      );
      if (suspicious.length > 0) {
        warn(`${suspicious.join(", ")} look${suspicious.length === 1 ? "s" : ""} like a suffixed rename of a declared name — check it is the object you meant.`, "promote.suffixed-rename");
      }
    }
    // What to do next, on every human promote rather than only on one of them.
    // The inspection pointer is possible at all because `branch` is always a
    // real, addressable label by the time this runs — derived when the caller
    // named none (see `derivedPromoteLabel`), so there is never a landing this
    // cannot name.
    //
    // It survives `--set-live` deliberately: someone who just put a branch in
    // front of traffic has MORE reason to read back what arrived than someone
    // who staged one. Only the set-live pointer is conditional, and only
    // because a branch that is already live has nothing left to promote.
    detail(`See what landed with \`xanosdk workspace export --branch ${branch}${flags}\`.`);
  }
}

/** Shared with `tenant deploy`, whose trade is identical. */
export { reportNotRun, assertNoMergeFlags };
export type { ResolvedAuth };

/**
 * A read a promote makes before it lands — the branch list, or the release
 * archive and workspace the table check compares — when it got no answer: a
 * network failure or a server error. Exit 8, nothing sent, and this run as the
 * rerun, as the other pre-landing reads say it. Anything else passes through.
 * With `what`, the failure is named by it and its message is not quoted (the
 * archive read's can carry a signed download link).
 */
async function unansweredBranchRead(err: unknown, args: ParsedArgs, what?: string): Promise<unknown> {
  const { LookupFailedError, isServerError, isTransportFailure, unansweredCause } = await import("./source-resolve.js");
  const transport = isTransportFailure(err);
  if (!transport && !isServerError(err)) return err;
  const first =
    what !== undefined
      ? `could not read ${what}`
      : ((err instanceof Error ? err.message : String(err)).trim().split("\n")[0] ?? "").replace(/[.:]$/, "");
  const retry = retryCommand(args, {
    add: pipedYes(args) === "" ? [] : ["--yes"],
    command: ["promote", ...args.positionals.map(shellWord)].join(" "),
  });
  const failed = new LookupFailedError(
    `${first[0]?.toUpperCase() ?? ""}${first.slice(1)}. ${unansweredCause(err)} before ` +
      `the landing — nothing was sent`,
    "unreachable",
    "workspace",
    `run \`${retry.command}\` again`,
  );
  failed.message += withheldNote(retry.withheld);
  return failed;
}
