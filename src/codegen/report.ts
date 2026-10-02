/**
 * Decode reporting — one computation, three sinks.
 *
 * Anything the decoder could not represent faithfully has to reach the user
 * loudly and specifically. It reaches them three ways: as structured
 * entries, as a section in the generated README, and as the CLI summary. All
 * three read from a single `summarize()` so a README claiming "3 raw fallbacks"
 * can never disagree with a CLI claiming 4.
 */

/** What kind of problem an entry records. */
export type ReportCategory =
  /** A statement fell through to `raw()` instead of a typed call. */
  | "raw-fallback"
  /**
   * A RETIRED version of a versioned statement family, carried verbatim on
   * purpose. Informational — nothing failed: the platform keeps these running
   * for existing stacks but no longer offers them, so this SDK models only the
   * latest of each family (see `SUPERSEDED_STATEMENTS`).
   */
  | "superseded"
  /**
   * A statement the engine WRITES but will not read back, carried verbatim (see
   * `DECODE_ONLY_STATEMENTS`). Warning, and the split from `superseded` is the
   * whole point: a retired version keeps running exactly as stored, so a pulled
   * workspace holding one pushes straight back. One of these does not. The
   * decode is faithful and nothing is lost, but the workspace is NOT deployable
   * until the statement is replaced, and `export()` says so.
   */
  | "decode-only"
  /** A value was emitted as an annotated literal instead of a `c.*`/`ref` call. */
  | "value-fallback"
  /**
   * A guid referenced by an object is not present in the bundle, and the
   * reference is one this SDK would otherwise have resolved. Error severity:
   * the generated tree does not reproduce its source.
   *
   * Narrow on purpose. Three other causes — an unportable internal id, a
   * binding that is blank upstream, and a reference stored by name — each
   * round-trip exactly, so they are {@link ReportCategory}'s `unportable-id`,
   * `blank-binding`, and `name-bound-ref`. Sharing this one's severity would
   * let the loudest cause set the tone for all of them, and every such row
   * would read as "acting on this output is unsafe" when none of them means it.
   */
  | "unresolved-ref"
  /**
   * The SOURCE archive carried two records under one guid that are not the same
   * object. An error rather than a warning because nothing was generated for
   * either: one guid cannot describe two objects, and picking a side would
   * silently repoint every reference that resolves through it.
   *
   * Distinct from the exporter's same-name collision, which is a thing the
   * AUTHOR can fix by renaming. This one the author did not cause and cannot fix
   * that way — the repeat is in the archive.
   */
  | "duplicate-source-guid"
  /**
   * Equivalent repeats of one stored object were merged into the first. A notice
   * because nothing was lost and nothing needs doing — but it is reported rather
   * than silent, so a tree with fewer objects than the archive has records is
   * explained rather than merely smaller.
   */
  | "consolidated-duplicate"
  /**
   * A reference stored as an INTERNAL id rather than portable identity — a
   * `guid 0`, or a `customize` block naming its target by local row id.
   *
   * Notice severity, and the reason is that there is nothing to decide. An
   * internal row id is not identity that survives leaving the workspace, so
   * carrying it as `raw()`/unbound is the only faithful reading; no authoring
   * choice, no upstream fix, and no re-deploy would change it. It is reported
   * at all only because the output is otherwise indistinguishable from a
   * reference the decoder simply failed to follow.
   */
  | "unportable-id"
  /**
   * A statement or attachment whose binding is blank upstream — a `db.*`
   * pointing at no table, a `function.run` pointing at no fn, an addon
   * attachment pointing at no addon. Recovered as `null`.
   *
   * Warning severity, NOT notice. The decode is faithful and `null`
   * re-encodes to exactly what was stored, so nothing is lost — but the
   * workspace has a statement wired to a target that no longer exists, and
   * emitting that silently would let a lost binding pass as a deliberate
   * choice. The thing to fix is upstream rather than in the generated tree,
   * which is what makes it a warning and not an error.
   *
   * Coalesced per object by {@link COALESCE_BY_OBJECT}: one workspace in the
   * survey corpus carries 48 of these, and 48 lines saying the same sentence
   * about one workspace is not 48 times the signal.
   */
  | "blank-binding"
  /**
   * A reference stored by NAME rather than by guid, which this SDK resolves by
   * guid only. Carried verbatim, so the bytes are preserved.
   *
   * Warning severity: the output is faithful, but the reference is not linked
   * to its target's symbol and a re-deploy will not re-link it. Two readings
   * fit — an older workspace whose stored spelling the engine still honours, or
   * a target that was deleted or re-keyed — and the entry states both, because
   * nothing here can tell them apart.
   */
  | "name-bound-ref"
  /**
   * A non-empty payload section this SDK models no kind for, or a payload key it
   * has never seen. Warning: a real Xano object type is absent from the tree, so
   * the pull is incomplete and the reader should know it.
   */
  | "unsupported-section"
  /**
   * A payload section deliberately not carried into the tree because it belongs
   * to the instance, not the workspace — stored files, install history,
   * marketplace provenance, the current-branch pointer.
   *
   * Notice, and the split from `unsupported-section` is the point. "We chose not
   * to carry this" and "we don't know what this is" are different sentences, and
   * folding them together made 49 vault-and-history rows across the survey
   * corpus read as gaps in the pull. Codegen is not a backup tool; these are
   * recoverable only from the live workspace, and that is by design.
   */
  | "instance-owned"
  /**
   * A field that names a file in the source backend's file library — an MCP
   * icon read back as that backend's own `/vault/…` path, or a bundle's
   * `xanosdk-file://` placeholder — whose bytes the source did not carry. The
   * tree is faithful, but the address answers 404 on every other backend until
   * the file is put in the repo and referenced with `hostedFile()`.
   */
  | "file-not-recovered"
  /** Runtime verification found a re-export that does not match the source bundle. */
  | "verify-mismatch"
  /**
   * A secret or server-assigned value the SDK deliberately did not carry into
   * the generated tree. Informational — it does not mean anything went wrong.
   */
  | "expected-omission"
  /**
   * A body-bearing object arrived with no body, so its generated def is an
   * identity stub. Informational: the decode was faithful — the object really is
   * empty upstream. It is reported because the output is indistinguishable from
   * a decode failure, and without a line here the only way to tell them apart is
   * to go read the workspace.
   */
  | "empty-source"
  /**
   * A statement that stores an entirely empty context — added to a stack and
   * never configured. Emitted as `raw()`.
   *
   * Notice, and it is the statement-level twin of `empty-source`: the decode is
   * faithful, and there is nothing to recover because there is nothing there.
   * Filed as `raw-fallback` before, where six rows across the survey corpus
   * claimed a decoder had failed to reproduce a statement whose entire content
   * is `{}`. Reported at all for the same reason `empty-source` is — the output
   * is indistinguishable from a decode failure, and without a line here the only
   * way to tell them apart is to go read the workspace.
   */
  | "unconfigured-stub"
  /**
   * The stored form was a superseded one and the tree emits the CURRENT form
   * instead. Not a failure and not a silent cleanup: the whole reason this has
   * its own category is that a modernization can change what a value evaluates
   * to, so it has to be visible without being alarming. Warning severity —
   * "read this line and confirm you want it", not "this output is broken".
   */
  | "modernized"
  /**
   * A condition whose terms do not all join the same way (`a AND b OR c`). The
   * decode is EXACT — `mixed(...)` reproduces the stored joins term by term —
   * but the stored form does not record which grouping was meant, and the two
   * places such a condition can appear read it differently (a branch folds left
   * to right; a database query applies AND-before-OR precedence). Warning
   * severity: nothing is broken and nothing was lost, but the condition is worth
   * rewriting as nested `and(...)`/`or(...)` so it says what it means.
   */
  | "ambiguous-condition"
  /**
   * A `{param}` segment in an object's path had no input bound to it upstream,
   * and the generated def declares one so the tree builds.
   *
   * Xano treats an unbound `{param}` as an inert part of the route string, so
   * this is legal upstream — but Xano SDK refuses to author it, and emitting it
   * faithfully would produce a project that throws on import. The synthesized
   * input is the one place codegen deliberately does NOT reproduce its source,
   * which is exactly why it gets a line: deploying the generated tree back BINDS
   * that segment, and the reader has to know that.
   */
  | "path-param-bound"
  /**
   * The SOURCE WORKSPACE holds something that cannot work as stored — a lambda
   * reading a name nothing binds, an input with no name for anything to bind
   * to. The decode is faithful and the tree is usable; the defect is upstream.
   *
   * Its own category because the alternative is reporting these in the voice of
   * the decoder. Were the authoring guard to REJECT a lambda whose body reads
   * `$this` during decode, the statement would drop to `raw()` and be filed as
   * "the decoder could not reproduce this" — describing a live workspace bug as
   * a limitation of the tool that found it. The guard is right
   * and stays on the authoring path, where the author can act on it; on the
   * codegen path the author is not authoring, so the finding says what is
   * actually wrong instead.
   */
  | "workspace-defect";

/**
 * How much a category should worry the reader.
 *
 * The report used to carry categories only, which left every consumer to invent
 * its own split — the CLI hardcoded "everything except expected-omission is a
 * problem", and the sweep tool kept a second list that could disagree with it.
 * Severity is that judgment, made once, here.
 */
export type ReportSeverity =
  /** The generated tree does not reproduce its source. Acting on it is unsafe. */
  | "error"
  /** Faithful, but degraded or changed in a way that wants a human glance. */
  | "warning"
  /** Purely informational — nothing to decide, nothing to fix. */
  | "notice";

/**
 * WHO a finding is for — the axis a reader triages on.
 *
 * Severity says how loud a finding is; it does not say whose problem it is.
 * Without this, a large report interleaves three unrelated things under one set
 * of ERROR/WARN/note prefixes: statements this SDK could not model, defects live in
 * the workspace right now, and states where nothing is wrong at all. Only the
 * middle group is something the reader can act on, and it was the hardest to
 * find.
 */
export type ReportAudience =
  /** The source workspace has a problem. Fix it upstream; the tree is faithful. */
  | "workspace"
  /** This SDK could not model something. The output is exact but not typed. */
  | "modelling"
  /** Nothing is wrong — stated because the output would otherwise be ambiguous. */
  | "informational";

/** Section heading per audience, most actionable first. */
const AUDIENCE_ORDER: ReadonlyArray<readonly [ReportAudience, string]> = [
  ["workspace", "Problems in your workspace"],
  ["modelling", "Things Xano SDK could not model"],
  ["informational", "Stated so the output is not ambiguous"],
];

/**
 * Category display order, label, severity and audience — ordered by severity
 * within each audience, so the entries that mean "this output is wrong" sit
 * above the ones that mean "this output is ugly". Stable regardless of
 * insertion order.
 */
const CATEGORY_LABELS: ReadonlyArray<
  readonly [ReportCategory, string, ReportSeverity, ReportAudience]
> = [
  ["verify-mismatch", "Round-trip mismatches", "error", "modelling"],
  ["duplicate-source-guid", "Objects sharing one guid in the source", "error", "workspace"],
  ["unresolved-ref", "References that could not be resolved", "error", "workspace"],
  ["workspace-defect", "Defects in the source workspace", "warning", "workspace"],
  ["decode-only", "Statements the engine writes but will not import", "warning", "workspace"],
  ["blank-binding", "Bindings that are blank upstream", "warning", "workspace"],
  ["name-bound-ref", "References stored by name, not by guid", "warning", "workspace"],
  ["ambiguous-condition", "Conditions that mix AND and OR at one level", "warning", "workspace"],
  ["raw-fallback", "Statements emitted as raw() passthroughs", "warning", "modelling"],
  ["unsupported-section", "Unsupported payload sections", "warning", "modelling"],
  ["file-not-recovered", "Files referenced but not recovered", "warning", "modelling"],
  ["value-fallback", "Values emitted as annotated literals", "warning", "modelling"],
  ["modernized", "Updated to the current form (evaluates differently)", "warning", "modelling"],
  ["path-param-bound", "Unbound {param} segments given an input", "warning", "modelling"],
  ["superseded", "Retired statement versions, carried verbatim", "notice", "informational"],
  ["expected-omission", "Deliberately not carried into the tree", "notice", "informational"],
  ["empty-source", "Objects that were already empty in the source", "notice", "informational"],
  ["unconfigured-stub", "Statements that were never configured", "notice", "informational"],
  ["unportable-id", "Internal ids that are not portable identity", "notice", "informational"],
  ["consolidated-duplicate", "Repeated source records merged by guid", "notice", "informational"],
  ["instance-owned", "Instance state, deliberately not carried as source", "notice", "informational"],
];

/**
 * Categories rendered as one entry per OBJECT rather than one per site.
 *
 * A per-site entry is the right unit for a cause a reader acts on individually.
 * It is the wrong unit for a cause that repeats mechanically within one object —
 * every column of a lost table, every statement against a deleted fn — where the
 * count is a property of the object's size rather than of how much went wrong.
 *
 * Coalescing happens in {@link DecodeReport.summarize}, not at the call site, for
 * the same reason severity does: the decoder does not know when it is finished
 * with an object, and a second aggregation living in the CLI could disagree with
 * the README's. {@link DecodeReport.entries} is left untouched, so tooling that
 * wants every site still has it.
 */
const COALESCE_BY_OBJECT: ReadonlySet<ReportCategory> = new Set<ReportCategory>(["blank-binding"]);

/** How each severity is prefixed in the two renderings. */
const SEVERITY_LABEL: Readonly<Record<ReportSeverity, string>> = {
  error: "ERROR",
  warning: "WARN",
  notice: "note",
};

/** Severity for a category — the single source both the CLI and tooling read. */
export function severityOf(category: ReportCategory): ReportSeverity {
  return CATEGORY_LABELS.find(([c]) => c === category)?.[2] ?? "warning";
}

/** Audience for a category — whose problem a finding in it is. */
export function audienceOf(category: ReportCategory): ReportAudience {
  return CATEGORY_LABELS.find(([c]) => c === category)?.[3] ?? "modelling";
}

/** One thing the decoder could not represent faithfully. */
export interface ReportEntry {
  readonly category: ReportCategory;
  /** The object it happened in, e.g. `function:signup` (or `bundle`). */
  readonly object: string;
  /** Where inside that object, e.g. `stack[2].context.where`. */
  readonly path?: string;
  readonly detail: string;
  /**
   * What the entry is about, in one or two words — `db.query`, `function.run`,
   * `addon "comments"`. Optional, and only meaningful for a category in
   * {@link COALESCE_BY_OBJECT}, which lists the distinct subjects it saw rather
   * than repeating one sentence per site.
   *
   * Carried as a field rather than parsed back out of `detail`: the coalesced
   * line would otherwise be built by regexing prose that exists to be read by a
   * human, and every future rewording of that prose would silently degrade it.
   */
  readonly subject?: string;
}

/**
 * One ROOT CAUSE within a category: the sentence, and every place it was said.
 *
 * Grouping is on the detail text EXACTLY, never on a normalized or pattern-
 * matched version of it. A cause that repeats mechanically across objects says
 * the same sentence every time — 58 blank table references are 58 copies of one
 * string — so exact equality collapses them without anything having to parse
 * prose written to be read. A detail that embeds an object-specific fragment
 * simply does not group, which is the safe direction: the report is longer than
 * it could be, never wrong about what it is saying.
 */
export interface ReportCause {
  readonly detail: string;
  readonly count: number;
  /** The objects it was found in, first-seen order. */
  readonly objects: readonly string[];
  /** Every entry behind it, for the per-entry rendering. */
  readonly entries: readonly ReportEntry[];
}

/** Entries for one category, with its count. */
export interface ReportGroup {
  readonly category: ReportCategory;
  readonly label: string;
  readonly severity: ReportSeverity;
  readonly audience: ReportAudience;
  readonly count: number;
  readonly entries: readonly ReportEntry[];
  /** The distinct root causes behind those entries, first-seen order. */
  readonly causes: readonly ReportCause[];
}

/** The single computed view every rendering derives from. */
export interface ReportSummary {
  readonly total: number;
  /** Counts by severity, so a caller never has to enumerate categories itself. */
  readonly bySeverity: Readonly<Record<ReportSeverity, number>>;
  /** Counts by audience — what the headline and the section split are built on. */
  readonly byAudience: Readonly<Record<ReportAudience, number>>;
  /** Distinct root causes across every category. */
  readonly distinctCauses: number;
  /** Non-empty categories only, in `CATEGORY_LABELS` order. */
  readonly byCategory: readonly ReportGroup[];
}

/** `object` + optional `path`, as shown to the user. */
function location(entry: ReportEntry): string {
  return entry.path ? `${entry.object} → ${entry.path}` : entry.object;
}

/**
 * One entry per object, listing the distinct subjects seen within it.
 *
 * The `path` is dropped deliberately: it named a single site, and this entry no
 * longer stands for a single site. The count comes along so a reader can tell
 * one lost binding from twelve without the report printing twelve lines.
 *
 * Order is first-seen, matching the order the decoder walked the object — the
 * rest of this module preserves record order for the same reason, so a report
 * reads in the same sequence as the tree it describes.
 */
function coalesceByObject(entries: readonly ReportEntry[]): ReportEntry[] {
  const byObject = new Map<string, ReportEntry[]>();
  for (const entry of entries) {
    const found = byObject.get(entry.object);
    if (found) found.push(entry);
    else byObject.set(entry.object, [entry]);
  }
  return [...byObject].map(([object, group]) => {
    if (group.length === 1) return group[0]!;
    const subjects = [...new Set(group.map((e) => e.subject).filter((s) => s !== undefined))];
    const named = subjects.length > 0 ? `${subjects.join(", ")} — ` : "";
    return {
      category: group[0]!.category,
      object,
      detail: `${named}${group.length} references in this object are blank upstream, recovered as \`null\`. The targets were deleted, or the bindings were never made. Fix them upstream, or bind them in the generated source.`,
    };
  });
}

/**
 * Collapse entries whose detail is the same sentence.
 *
 * First-seen order throughout, matching the order the decoder walked the
 * bundle, so a grouped report reads in the same sequence as the tree it
 * describes.
 */
function groupByCause(entries: readonly ReportEntry[]): ReportCause[] {
  const byDetail = new Map<string, ReportEntry[]>();
  for (const entry of entries) {
    const found = byDetail.get(entry.detail);
    if (found) found.push(entry);
    else byDetail.set(entry.detail, [entry]);
  }
  return [...byDetail].map(([detail, group]) => ({
    detail,
    count: group.length,
    objects: [...new Set(group.map((e) => e.object))],
    entries: group,
  }));
}

/** How many objects a collapsed cause names before it says "and N more". */
const OBJECTS_SHOWN = 4;

/** `a, b, c and 12 more` — the collapsed object list on a grouped line. */
function collapseObjects(objects: readonly string[]): string {
  if (objects.length <= OBJECTS_SHOWN) return objects.join(", ");
  const shown = objects.slice(0, OBJECTS_SHOWN).join(", ");
  return `${shown} and ${objects.length - OBJECTS_SHOWN} more`;
}

/** Collects decode problems and renders them for every surface that shows them. */
export class DecodeReport {
  readonly #entries: ReportEntry[] = [];
  /** Object label → the generated file it was written to. See {@link locate}. */
  readonly #files = new Map<string, string>();

  /** Record a problem. */
  add(entry: ReportEntry): void {
    // The same problem at the same site, reported twice (an object decoded
    // again), is one problem: counted twice it printed "×2" beside one site.
    const key = JSON.stringify([entry.category, entry.object, entry.path, entry.detail, entry.subject]);
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    this.#entries.push(entry);
  }

  readonly #seen = new Set<string>();

  /**
   * Record which generated file an object was written to.
   *
   * A finding is keyed by the object it happened in (`query:dbo_direct_query`),
   * but the fix happens in the file the object was written to — and assembly
   * knows that path, because it just chose it. Recording it here is what lets
   * every finding name a file the reader can open.
   *
   * The path only; there is no line. A finding's `path` (`stack[5]`) is a
   * position in the STORED object, and mapping one to a line in the emitted
   * source would mean the printer carrying positions through every expression it
   * builds. The file is the part that makes a finding findable.
   */
  locate(object: string, file: string): void {
    this.#files.set(object, file);
  }

  /** The generated file an object was written to, when assembly recorded one. */
  #fileFor(object: string): string | undefined {
    return this.#files.get(object);
  }

  /** The generated file the object labelled `object` (`query:pick`) was written to, when assembly recorded one. */
  fileOf(object: string): string | undefined {
    return this.#fileFor(object);
  }

  /** A position in the entry log, for {@link rewind}. */
  mark(): number {
    return this.#entries.length;
  }

  /**
   * Drop every entry recorded since `mark`. Used to discard a speculative decode
   * attempt, so the report describes what was emitted rather than what was tried.
   */
  rewind(mark: number): void {
    this.#entries.length = mark;
  }

  /** Every entry, in the order it was recorded. */
  get entries(): readonly ReportEntry[] {
    return this.#entries;
  }

  /** Group and count. The one computation every rendering reads. */
  summarize(): ReportSummary {
    const byCategory: ReportGroup[] = [];
    const bySeverity: Record<ReportSeverity, number> = { error: 0, warning: 0, notice: 0 };
    const byAudience: Record<ReportAudience, number> = {
      workspace: 0,
      modelling: 0,
      informational: 0,
    };
    let total = 0;
    let distinctCauses = 0;
    for (const [category, label, severity, audience] of CATEGORY_LABELS) {
      const found = this.#entries.filter((e) => e.category === category);
      if (found.length === 0) continue;
      const entries = COALESCE_BY_OBJECT.has(category) ? coalesceByObject(found) : found;
      const causes = groupByCause(entries);
      byCategory.push({
        category,
        label,
        severity,
        audience,
        count: entries.length,
        entries,
        causes,
      });
      bySeverity[severity] += entries.length;
      byAudience[audience] += entries.length;
      distinctCauses += causes.length;
      total += entries.length;
    }
    return { total, bySeverity, byAudience, distinctCauses, byCategory };
  }

  /**
   * The headline, or an empty string when there is nothing to say.
   *
   * Answers the two questions a reader has before they start reading: how much
   * of this is repetition, and how much of it is theirs to fix.
   */
  headline(): string {
    const summary = this.summarize();
    if (summary.total === 0) return "";
    const causes = `${summary.distinctCauses} distinct issue${summary.distinctCauses === 1 ? "" : "s"}`;
    const findings = `${summary.total} finding${summary.total === 1 ? "" : "s"}`;
    const mine = summary.byAudience.workspace;
    // An ERROR outside the workspace audience — a round trip that did not
    // verify — is not the reader's source to fix, but it fails the command, so
    // "none need your attention" above it read as the opposite of the outcome.
    const errors = summary.byCategory
      .filter((g) => g.severity === "error" && g.audience !== "workspace")
      .reduce((n, g) => n + g.count, 0);
    const errorClause = (more: string) =>
      `${errors}${more} ${errors === 1 ? "is an error" : "are errors"}`;
    // A WARNING outside the workspace audience (a payload section this SDK does
    // not carry) is still something the tree lost — "none need your attention"
    // above it read as a clean decode (E2E pass 18).
    const warnings = summary.byCategory
      .filter((g) => g.severity === "warning" && g.audience !== "workspace")
      .reduce((n, g) => n + g.count, 0);
    const attention =
      mine === 0
        ? errors === 0
          ? warnings === 0
            ? "none need your attention"
            : `${warnings} ${warnings === 1 ? "is a warning" : "are warnings"}`
          : errorClause("")
        : `${mine} need${mine === 1 ? "s" : ""} your attention` +
          (errors === 0 ? "" : `; ${errorClause(" more")}`);
    return `${causes} across ${findings}; ${attention}`;
  }

  /** The findings as data — the shape `--report json` and the manifest carry. */
  toJson(): {
    headline: string;
    total: number;
    bySeverity: Record<ReportSeverity, number>;
    byAudience: Record<ReportAudience, number>;
    findings: Array<{
      category: ReportCategory;
      severity: ReportSeverity;
      audience: ReportAudience;
      object: string;
      path?: string;
      file?: string;
      detail: string;
    }>;
  } {
    const summary = this.summarize();
    return {
      headline: this.headline(),
      total: summary.total,
      bySeverity: summary.bySeverity,
      byAudience: summary.byAudience,
      findings: summary.byCategory.flatMap((group) =>
        group.entries.map((entry) => ({
          category: group.category,
          severity: group.severity,
          audience: group.audience,
          object: entry.object,
          ...(entry.path === undefined ? {} : { path: entry.path }),
          ...(this.#fileFor(entry.object) === undefined
            ? {}
            : { file: this.#fileFor(entry.object)! }),
          detail: entry.detail,
        })),
      ),
    };
  }

  /** The generated README's report section. Empty string when there is nothing to say. */
  renderMarkdown(): string {
    const summary = this.summarize();
    if (summary.total === 0) return "";
    const lines: string[] = ["## What did not round-trip cleanly", "", this.headline(), ""];
    for (const [audience, heading] of AUDIENCE_ORDER) {
      const groups = summary.byCategory.filter((g) => g.audience === audience);
      if (groups.length === 0) continue;
      lines.push(`### ${heading}`, "");
      for (const group of groups) {
        lines.push(
          `#### ${SEVERITY_LABEL[group.severity]} ${group.label} [${group.category}=${group.count}]`,
          "",
        );
        for (const entry of group.entries) {
          lines.push(`- \`${this.#locationOf(entry)}\` — ${entry.detail}`);
        }
        lines.push("");
      }
    }
    return lines.join("\n");
  }

  /**
   * The CLI summary. Empty string when there is nothing to say.
   *
   * Grouped by root cause by default: a cause that repeats across objects gets
   * one line carrying its count and a collapsed object list, because 58 lines
   * saying one sentence about 58 tools is not 58 times the signal. `full: true`
   * restores the per-entry form for anyone who wants every site; `categories`
   * limits it to those categories.
   */
  renderCli(opts: { full?: boolean; fileBase?: string; categories?: readonly string[] } = {}): string {
    const summary = this.summarize();
    if (summary.total === 0) return "";
    const lines: string[] = [];
    for (const [audience, heading] of AUDIENCE_ORDER) {
      const groups = summary.byCategory.filter(
        (g) => g.audience === audience && (opts.categories === undefined || opts.categories.includes(g.category)),
      );
      if (groups.length === 0) continue;
      lines.push(`  ${heading}`);
      for (const group of groups) {
        lines.push(
          `    ${SEVERITY_LABEL[group.severity]} ${group.label} [${group.category}=${group.count}]`,
        );
        if (opts.full === true) {
          for (const entry of group.entries) {
            lines.push(`      ${this.#locationOf(entry, opts.fileBase)} — ${entry.detail}`);
          }
          continue;
        }
        for (const cause of group.causes) {
          // A cause seen once is not a group, so it keeps the location it had
          // rather than being restated as "×1 in one object".
          if (cause.count === 1) {
            lines.push(`      ${this.#locationOf(cause.entries[0]!, opts.fileBase)} — ${cause.detail}`);
            continue;
          }
          lines.push(`      ×${cause.count} — ${cause.detail}`);
          // Fewer objects than sites: some object holds more than one, so each
          // site is named — one object beside "×2" read as a site left out.
          const sites =
            cause.objects.length === cause.count
              ? cause.objects.map((o) => this.#label(o, opts.fileBase))
              : cause.entries.map((e) => this.#locationOf(e, opts.fileBase));
          lines.push(`        in ${collapseObjects(sites)}`);
        }
      }
    }
    return lines.join("\n");
  }

  /**
   * `object → path (file)`, with the file only when assembly recorded one.
   *
   * `base` is what the reader's paths are relative TO. The README sits inside
   * the generated tree, so it prints the bare path; the CLI is read from the
   * project root, so it prints the tree directory too and the path is one a
   * terminal can open.
   */
  #locationOf(entry: ReportEntry, base?: string): string {
    const file = this.#fileFor(entry.object);
    return file === undefined ? location(entry) : `${location(entry)} (${base ?? ""}${file})`;
  }

  /** An object with its file appended, for the collapsed list on a grouped line. */
  #label(object: string, base?: string): string {
    const file = this.#fileFor(object);
    return file === undefined ? object : `${object} (${base ?? ""}${file})`;
  }
}
