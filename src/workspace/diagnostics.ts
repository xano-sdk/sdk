/**
 * Build-time diagnostics: one place that formats a finding, decides whether it
 * throws or warns, and lets a caller capture the whole set.
 *
 * Guards record a {@link Diagnostic} rather than calling `console.warn` inline,
 * which would make each one individually untestable (spy on the console),
 * inconsistently formatted, and impossible to silence as a group:
 *
 * - **error** — the engine rejects this shape 100% of the time, so the only
 *   thing an import can produce is a 500 after provisioning has begun.
 * - **warning** — the shape is usually-wrong (it loses data or disables a guard
 *   under the reading most authors intend) but has legitimate uses, following
 *   the `auth()`-on-a-public-host precedent.
 * - **notice** — nothing is wrong and nothing needs fixing, but the export did
 *   something the author has to KNOW about to handle correctly elsewhere: it
 *   wrote a live credential into the bundle. `strict` never promotes a notice,
 *   because the condition it reports is a legitimate end state — failing CI on
 *   it would mean a private-registry microservice could not ship at all.
 *
 * A {@link DiagnosticBag} collects a whole `export()` so an author sees *every*
 * violation at once rather than fixing one, re-running, and finding the next.
 */

import type { AnyWarningCode, DiagnosticCode } from "../codes.js";

export type DiagnosticSeverity = "error" | "warning" | "notice";

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  /** Stable slug for the check (e.g. `"table.use-xdo"`), for tests and filtering. */
  readonly code: AnyWarningCode;
  /** Author-facing text, WITHOUT the `xanosdk:` prefix — {@link formatDiagnostic} adds it. */
  readonly message: string;
  /** The def it is about, when it is about one — the key a `diagnostics.allow` would sit on. */
  readonly subject?: DiagnosticSubject;
  /** Set on an entry that stands for this many further problems a refusal does not list; it is not one itself. */
  readonly unlisted?: number;
}

/** A def as authored: its SDK kind (`function`, `table`, `workflowTest`) and its name. */
export interface DiagnosticSubject {
  readonly kind: string;
  readonly name: string;
}

/**
 * A def's accepted warnings: `diagnostics: { allow: ["query.path-segment-candidate"] }`.
 *
 * The in-source way to say "this shape is intended", reviewed with the def it
 * is about, so `export --strict` can pass without a flag that silences every
 * object at once. Each def kind offers only the codes that concern it.
 */
export interface DefDiagnostics<Code extends string> {
  /**
   * Warning codes accepted for this def: not printed, and not failed under
   * `--strict`, but still listed in `export({ accepted })`. A code the export
   * did not raise about this def warns `diagnostics.allow-unused`.
   */
  allow?: readonly Code[];
}

const ENV = "stack.env-undeclared";
/** A `mixed(...)` condition — accepted by a pulled tree, which carries one as stored. */
const MIXED = "condition.mixed";
const DOCS_PUBLIC = "api-group.docs-public";
/** A write before an `s.mcp.elicit` — accepted where the write is idempotent or meant to repeat. */
const ELICIT = "mcp.write-before-elicit";

/**
 * The warnings about a VALUE rather than a statement — raised by the walkers
 * that read every node of a def, so any def that carries inputs, conditions or
 * settings can raise them, stack or not.
 */
const VALUES = [
  "expression.ignore-empty-static-empty",
  "value.interpolated-object",
  "value.regex-operands-reversed",
  "value.timezone-unknown",
  "field.default-not-text",
  "field.enum-default-not-a-value",
  "field.email-default-invalid",
  "field.input-default-invalid",
  "field.input-required-default-ignored",
  "value.obj-zero-based-numeric-keys",
  "value.int-out-of-range",
] as const;

/**
 * The warnings a def's STACK can raise, whatever its kind: every statement
 * walker in the export reads any def that runs one.
 */
const STACK = /* @__PURE__ */ (() => [
  ENV,
  MIXED,
  "stack.blank-table",
  "stack.inp-undeclared",
  "stack.unbound-var",
  "storage.stored-file-input",
  "stack.password-input-double-hash",
  "stack.zip-password-absent",
  "stack.to-throw-isolated-var",
  "stack.loop-control-outside-loop",
  "statement.reserved-input-name",
  "statement.omitted-input",
  "statement.unknown-input",
  "db.addon-unknown-input",
  "db.addon-unknown-column",
  "db.addon-duplicate-alias",
  "db.bulk-update-partial-item",
  "db.internal-column-read",
  "db.query-output-mixed-roots",
  "db.query-output-totals-off",
  "db.query-output-joined-column",
  "db.query-output-unknown-column",
  "db.output-unknown-column",
  "db.query-output-not-envelope-rooted",
  "db.query-envelope-read-unpaged",
  "db.safe-ref-match-arg",
  "db.null-match-arg",
  "db.filter-operand-invalid",
  "search.request-only-filter",
  "switch.missing-break",
  "stack.expect-outside-test",
  "realtime.publish-unknown-server",
  "realtime.publish-unknown-channel",
  "redis.ratelimit-no-error",
  "agent.args-placeholder-unpassed",
  ...VALUES,
] as const)();

/** `auth()` in a host that never has a caller — raised on a query, a task and a lifecycle trigger. */
const NO_CALLER = ["stack.auth-no-caller", "stack.auth-null-host"] as const;
/** A saved unit test (`tests: [...]`) pointed at the live datasource. */
const TEST_LIVE = "test.live-datasource";
/** A saved unit test (`tests: [...]`) passing an input its object does not declare — the engine drops it. */
const TEST_INPUT = "test.unknown-input";
/** A toolset entry exposing a tool that reads `auth()` with no auth table, or an `id: 0` entry. */
const TOOLSET = /* @__PURE__ */ (() =>
  [ENV, MIXED, ...VALUES, "toolset.tool-reads-auth-ungated", "toolset.tool-ref-zero"] as const)();

/**
 * The warning codes each def kind's `diagnostics.allow` accepts, by registry
 * kind: EVERY warning the export raises about one def of that kind.
 *
 * A warning is a shape that deploys and usually does the wrong thing, so it can
 * be meant — a fixture that pins a hazard on the engine means exactly that
 * shape. Accepting it on the def keeps `--strict` on for everything else;
 * without it the only way through was to drop `--strict` for the whole
 * workspace. An ERROR is never listed: the engine rejects that shape outright.
 *
 * The advisory codes a pull accepts on decode lead each list, in the order a
 * decoded `allow` is written (see `accept-on-decode.ts`).
 *
 * Built in a pure factory: the spreads below are not provably side-effect-free
 * to a bundler, so a bare literal kept this table in every client bundle.
 */
export const ALLOWABLE_WARNINGS = /* @__PURE__ */ (() => ({
  query: [
    "query.path-segment-candidate",
    "query.route-shadowed",
    TEST_LIVE,
    ...STACK,
    ...NO_CALLER,
    "query.auth-table-unflagged",
    "query.input-name-mangled",
    "middleware.post-merge-list",
    "response.unbound-return",
    "mcp.elicit-outside-mcp",
    TEST_INPUT,
    "cache.ttl-not-positive",
  ],
  function: [TEST_LIVE, ...STACK, "function.reserved-input-name", "response.unbound-return", TEST_INPUT, "cache.ttl-not-positive"],
  task: [...STACK, ...NO_CALLER, "mcp.elicit-outside-mcp"],
  middleware: [
    TEST_LIVE,
    ...STACK,
    TEST_INPUT,
    "middleware.input-never-bound",
    "middleware.inp-unresolvable",
    "middleware.auth-null-host",
    "middleware.envelope-unnested",
    "middleware.post-reads-request",
  ],
  trigger: [
    ...STACK,
    "stack.auth-no-caller",
    "trigger.search-bare-column",
    "trigger.search-unknown-column",
    "trigger.no-action",
    "trigger.unbound",
    "realtime.gate-denies-everyone",
    "realtime.deliver-falsy-return",
    "realtime.join-deliver-object-response",
    "realtime.deliver-without-per-recipient",
  ],
  tool: [...STACK, ELICIT, "mcp.elicit-duplicate-key", "tool.output-mismatch"],
  prompt: [...STACK, ELICIT, "mcp.elicit-duplicate-key", "mcp.prompt-no-response"],
  resource: [...STACK, ELICIT, "mcp.elicit-duplicate-key"],
  agent: TOOLSET,
  mcp_server: [...TOOLSET, "toolset.primitive-reads-auth-ungated"],
  message: [...STACK, "realtime.deliver-explicit"],
  workflow_test: ["workflow-test.live-datasource", ...STACK],
  realtime_server: ["realtime.server-disabled"],
  channel: ["realtime.conversation-no-limit", "realtime.per-recipient-without-deliver", ...VALUES],
  microservice: [ENV],
  api_group: [DOCS_PUBLIC, "api-group.cors-origin-unmatchable", "api-group.cors-no-origins", "api-group.cors-wildcard-origin", "api-group.cors-no-methods"],
  table: [
    "table.column-name-unusable",
    ...VALUES,
    "table.view-id-not-uuid",
    "table.view-duplicate",
    "table.view-unknown-column",
    "table.reserved-column-name",
    "field.vector-not-nullable",
    "table.column-default-unfit",
  ],
  addon: [...VALUES, "search.request-only-filter", "db.filter-operand-invalid"],
  knowledge: [
    "knowledge.agents-md-mode",
    "knowledge.newline",
    "knowledge.empty-body",
    "knowledge.refs-include-source",
    "knowledge.refs-symlink-skipped",
  ],
  // The workspace config's allow accepts a code on EVERY def, so it offers only
  // the ones whose subject is the workspace's own declaration.
  workspace: [ENV, DOCS_PUBLIC],
}) as const satisfies Readonly<Record<string, readonly string[]>>)();

/** The codes a def of registry kind `kindName` may accept — none for a kind this table does not know. */
export function allowableWarnings(kindName: string): readonly string[] {
  return (ALLOWABLE_WARNINGS as Readonly<Record<string, readonly string[]>>)[kindName] ?? [];
}

/** A registry kind that takes `diagnostics`. */
export type DiagnosticsKind = keyof typeof ALLOWABLE_WARNINGS;

/** `diagnostics` on a def of `Kind`: accepts any warning the export raises about it. */
export type DiagnosticsFor<Kind extends DiagnosticsKind> = DefDiagnostics<(typeof ALLOWABLE_WARNINGS)[Kind][number]>;

/**
 * The advisory codes: a warning whose shape is often exactly right, so its
 * message names the `diagnostics: { allow }` form as a remedy. Every other
 * allowable code is a likely defect — accepted for a deliberate fixture, but
 * never offered as the fix, since an agent would take that exit first.
 */
export const ADVISORY_WARNINGS: readonly string[] = [
  "query.path-segment-candidate",
  ENV,
  MIXED,
  ELICIT,
  "workflow-test.live-datasource",
  TEST_LIVE,
  "statement.omitted-input",
  "realtime.server-disabled",
  DOCS_PUBLIC,
];

/**
 * Warnings about the workspace as a whole, not one def, so no def's allow can
 * reach them: same-name siblings span several objects. `stack.env-undeclared`
 * and `api-group.docs-public` each ALSO have a one-warning-for-many form, which
 * filters out the defs that accepted the code before it counts them.
 */
export const WORKSPACE_WIDE_WARNINGS: readonly string[] = ["lock.same-name-siblings"];

/** Where warnings go. Replaceable so tests capture them without spying on the console. */
export type DiagnosticSink = (diagnostic: Diagnostic) => void;

const consoleSink: DiagnosticSink = (diagnostic) => {
  console.warn(formatDiagnostic(diagnostic));
};

/**
 * The active sink lives on `globalThis` under a registry symbol, not in this
 * module. A project's entry file imports ITS OWN copy of the SDK (its
 * `node_modules`), while the CLI runs another — so a module-local sink meant
 * the CLI's `setDiagnosticSink` never reached the warnings the project's copy
 * raised while its entry loaded: they printed raw, and `export --strict` could
 * not collect them. One slot every loaded copy reads keeps the two in step.
 */
const SINK_KEY = Symbol.for("xanosdk.diagnostics.sink");
type SinkSlot = { [SINK_KEY]?: DiagnosticSink };

function sink(diagnostic: Diagnostic): void {
  ((globalThis as SinkSlot)[SINK_KEY] ?? consoleSink)(diagnostic);
}

/**
 * Swap the warning sink; returns the previous one so a caller can restore it.
 * Pass nothing to restore the default `console.warn` sink. Passing a no-op is
 * how a caller silences the whole diagnostic set.
 */
export function setDiagnosticSink(next?: DiagnosticSink): DiagnosticSink {
  const slot = globalThis as SinkSlot;
  const previous = slot[SINK_KEY] ?? consoleSink;
  slot[SINK_KEY] = next ?? consoleSink;
  return previous;
}

/** The single message format every diagnostic shares. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  return `xanosdk: ${diagnostic.message}`;
}

/**
 * An export that failed its checks.
 *
 * `code` and `details` are what the CLI's `--json` failure document carries, so
 * a caller learns WHICH checks failed (`details[].code`, e.g.
 * `"seed.public-seed"`) without parsing the message. `details` holds only the
 * diagnostics that failed the export — under `strict`, the promoted warnings
 * too — never the ones that were merely printed.
 */
export class DiagnosticError extends Error {
  override readonly name = "DiagnosticError";
  readonly code = "SDK_EXPORT_INVALID";

  constructor(
    message: string,
    readonly details: readonly Diagnostic[],
  ) {
    super(message);
  }
}

/**
 * Whether `err` is a {@link DiagnosticError} — read by shape, not class.
 *
 * `instanceof` answers "thrown by THIS copy of the SDK". The CLI can be a
 * different copy from the one a project's entry imports (a global install,
 * another project's bin), and an export refused by the project's copy must
 * still read as the export's refusal — `--strict` collects its findings from
 * it. `name`, `code` and a `details` list are what every copy stamps.
 */
export function isDiagnosticError(err: unknown): err is DiagnosticError {
  if (err instanceof DiagnosticError) return true;
  const e = err as { name?: unknown; code?: unknown; details?: unknown } | null;
  return (
    err instanceof Error &&
    e?.name === "DiagnosticError" &&
    e.code === "SDK_EXPORT_INVALID" &&
    Array.isArray(e.details)
  );
}

/**
 * Emit one diagnostic immediately — for guards that run at *encode* time, where
 * there is no enclosing export to collect into. A warning goes to the sink; an
 * error throws on the spot.
 */
export function emitDiagnostic(diagnostic: Diagnostic): void {
  if (diagnostic.severity === "error") throw new DiagnosticError(formatDiagnostic(diagnostic), [diagnostic]);
  sink(diagnostic);
}

/**
 * Collects the diagnostics of one `export()`, then reports them as a set.
 *
 * Errors do not throw when recorded — {@link flush} throws once, listing all of
 * them. Fixing a workspace one export at a time is the failure mode this
 * exists to avoid.
 */
export class DiagnosticBag {
  private readonly items: Diagnostic[] = [];
  private readonly acceptedItems: Diagnostic[] = [];
  private readonly skippedCodes = new Set<string>();

  /**
   * `strict`: report every warning as an error, so the build fails instead of
   * printing.
   *
   * Warnings here are the shapes that deploy clean and then do the wrong thing —
   * a `bulk.update` zero-filling the columns an item omits, an `ignoreEmpty`
   * that returns the whole table. They stay warnings by default because each has
   * a legitimate use, and the author who means it should not have to work around
   * a guard. But the audience for this SDK is largely an agent that never reads
   * stderr, and CI has no way to notice a message nobody fails on. `strict`
   * gives a pipeline one switch that turns "printed something" into "did not
   * ship".
   *
   * Scope: the diagnostics an EXPORT collects. A guard that runs while a
   * statement is being built ({@link emitDiagnostic}) has already had its say by
   * then — those throw or warn on the spot, at the line that caused them.
   */
  constructor(readonly strict = false) {}

  add(diagnostic: Diagnostic): void {
    this.items.push(diagnostic);
  }

  /** Record an error; `subject` (the encoded object it is about) names its def. An error is never accepted. */
  error(code: DiagnosticCode, message: string, subject?: object): void {
    this.add({ severity: "error", code, message, ...this.about(subject) });
  }

  /**
   * Record a warning. `subject` is the encoded object it is about; a warning the
   * author accepted on that object's def (`diagnostics: { allow }`, see
   * {@link DefDiagnostics}) is dropped here, at both settings.
   */
  warn(code: AnyWarningCode, message: string, subject?: object): void {
    if (this.isAccepted(code, () => message, subject)) return;
    this.add({ severity: "warning", code, message, ...this.about(subject) });
  }

  /**
   * Whether the author accepted `code` on `subject` — recorded in
   * {@link accepted} when so. For a check that raises one warning for many
   * defs: it asks per def, and leaves out the ones that accepted it. `message`
   * is built only for an accepted finding.
   */
  isAccepted(code: AnyWarningCode, message: () => string, subject?: object): boolean {
    if (this.accepts?.(code, subject) !== true) return false;
    this.acceptedItems.push({ severity: "warning", code, message: message(), ...this.about(subject) });
    return true;
  }

  /** Whether the author accepted `code` on `subject`; set by the export that owns the defs, read through {@link isAccepted}. */
  accepts?: (code: string, subject: object | undefined) => boolean;

  /** The def an encoded `subject` was registered from; set by the export that owns the defs. */
  describe?: (subject: object) => DiagnosticSubject | undefined;

  private about(subject: object | undefined): { subject?: DiagnosticSubject } {
    const described = subject === undefined ? undefined : this.describe?.(subject);
    return described === undefined ? {} : { subject: described };
  }

  /** The warnings an allow accepted, in the order they were found. */
  accepted(): readonly Diagnostic[] {
    return [...this.acceptedItems];
  }

  /**
   * Record that the check behind `code` did not run in this export, so an
   * allow naming it is not reported unused — it had nothing to accept here.
   */
  skipped(code: string): void {
    this.skippedCodes.add(code);
  }

  /** Whether the check behind `code` was {@link skipped}. */
  wasSkipped(code: string): boolean {
    return this.skippedCodes.has(code);
  }

  /** Report something the author must know, which is not a defect. See the module note. */
  notice(code: AnyWarningCode, message: string): void {
    this.add({ severity: "notice", code, message });
  }

  /** Everything recorded so far, in the order it was found. */
  all(): readonly Diagnostic[] {
    return [...this.items];
  }

  /**
   * Emit the warnings, then throw if anything was an error. Warnings are
   * emitted first: an author fixing the error still wants to see the rest of
   * what the build found. Under `strict` a warning IS an error — it is reported
   * in the thrown failure only, since sinking it as well printed its text
   * twice. A notice is printed at both settings and fails at neither.
   */
  flush(): void {
    for (const item of this.items) {
      if (item.severity === "notice" || (item.severity === "warning" && !this.strict)) sink(item);
    }
    const errors = this.items.filter(
      (item) => item.severity === "error" || (this.strict && item.severity === "warning"),
    );
    if (errors.length === 0) return;
    // Only when `strict` is WHY this fails: a hard error fails at both settings,
    // and the note on it read as though dropping --strict would let it through.
    const promoted = errors.filter((item) => item.severity === "warning").length;
    const strictNote = promoted > 0 ? " (`strict`: warnings are errors)" : "";
    if (errors.length === 1) {
      throw new DiagnosticError(`${formatDiagnostic(errors[0]!)}${strictNote}`, errors);
    }
    // Promoted warnings among them: the headline the CLI's `--strict` refusal
    // uses too, "stopped: N findings fail strict" — one failure, one wording.
    const total = problemCount(errors);
    const hard = total - promoted;
    const headline =
      promoted === 0
        ? `export failed with ${total} errors`
        : `export stopped: ${total} findings fail \`strict\`` +
          (hard === 0 ? " (warnings are errors)" : ` (${hard} error${hard === 1 ? "" : "s"}; \`strict\` makes ${promoted === 1 ? "1 warning an error" : `${promoted} warnings errors`})`);
    throw new DiagnosticError(`xanosdk: ${headline}.\n${numberedList(errors)}`, errors);
  }
}

/** How many problems `items` report: an {@link Diagnostic.unlisted} entry counts the problems it stands for. */
export function problemCount(items: readonly Diagnostic[]): number {
  return items.reduce((n, item) => n + (item.unlisted ?? 1), 0);
}

/** `items` one per line, each problem numbered; an {@link Diagnostic.unlisted} entry is not. */
export function numberedList(items: readonly Diagnostic[]): string {
  let n = 0;
  return items.map((item) => (item.unlisted === undefined ? `  ${++n}. ${item.message}` : `     ${item.message}`)).join("\n");
}
