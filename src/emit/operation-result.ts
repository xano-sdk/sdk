/**
 * `OperationResult` — the one shape every consequential release command
 * answers in, and the one code path that writes it.
 *
 * A release write (`release create`, `promote`, `tenant deploy`) can end three
 * ways that matter to whoever runs it next: the requested outcome exists, it
 * does not, or nobody can tell yet. Each command used to phrase its own JSON,
 * and a failure mostly phrased none at all — the throw escaped past every
 * payload, and a CI job or an IDE saw a bare exit 1 over a write that may have
 * landed. So every such command builds one of these, and {@link runOperation}
 * emits it on success and on failure alike.
 *
 * `completed` answers "did the requested outcome come to exist". Each step of a
 * multi-step write carries its own answer, and the top level is rolled up from
 * them ({@link rollUp}): `yes` only when every requested step is `yes`.
 *
 * Whenever any step is `unknown`, the result names the read-only command that
 * settles it (`resolveWith`) and the moment before which that read cannot be
 * trusted to say "absent" (`resolveNotBefore`): a write the server is still
 * processing is not listed yet, and "not there" read too early is not proof
 * that it never will be.
 *
 * Why the wrapper THROWS after writing: the bin exits with the thrown error's
 * own `exitCode` (`exitCodeOf`) and nothing else, so a `process.exitCode` set
 * before a rethrow is silently replaced by 1. The error carries the code the
 * result implies — 9 for anything left to resolve — with the original message,
 * so the failure line reads exactly as it would have without the wrapper.
 */
import { describeWrite } from "../util/sent-writes.js";
import { explainRunFailure, writeJson } from "./output.js";
import { exitCodeOf, failureError, processExitCode, type FailureError } from "./errors.js";
import { warn, writeTargetPayload, type DisclosureTarget } from "./ui.js";
import { classifyFailure } from "./operation-outcome.js";
import {
  registerOperation,
  EXIT_OUTCOME_UNKNOWN,
  type OperationRegistration,
} from "./operation-registry.js";

/**
 * How long, from the moment a write is sent, the server may still be working
 * on it. A resolver read that finds nothing before this has passed is not
 * proof that nothing will appear.
 *
 * Set to the CLI's own budget for the longest release write; exported so the
 * live proof run can tighten it against measured behavior.
 */
export const SERVER_PROCESSING_BOUND_MS = 600_000;

/** Did the requested outcome come to exist. */
export type Completed = "yes" | "no" | "unknown";

/**
 * A step's answer. `skipped` is a step an earlier failure or interrupt kept
 * from running: it says nothing about the outcome that the step before it does
 * not already say, so it stays out of the roll-up. A step the command DECLINED
 * to run (live refused because verification did not pass) is `no`, recorded by
 * the command, never `skipped`.
 */
export type StepOutcome = Completed | "skipped";

/** One requested step of the write, in the order the command runs them. */
export interface OperationStep<S extends string = string> {
  name: S;
  completed: StepOutcome;
}

/** The release the operation wrote or acted on — the identity `publish` reports. */
export interface OperationRelease {
  instance: string;
  workspaceId: number;
  /** Absent until the server has said which id it stored. */
  id: number | undefined;
  /** As stored. A cut may be stored under a different name than was asked for. */
  name: string;
}

/** Something a failed (`no`) write left behind, and how to remove it. */
export interface OperationResidue {
  id?: number;
  name: string;
  /** The command that removes it, e.g. `xanosdk release delete v1-a1b2`. */
  removeWith: string;
}

/**
 * Where the write went: the same payload every write command discloses — for
 * an ephemeral or a tenant, `backendDestinationPayload`'s, with its `url`.
 */
export type OperationDestination = ReturnType<typeof writeTargetPayload> & { url?: string };

/** The fields every operation carries, whatever it is. */
export interface OperationCore<S extends string = string> {
  /** The command, as typed: `release create`, `promote`, `tenant deploy`. */
  operation: string;
  destination: OperationDestination;
  release: OperationRelease;
  /**
   * The branch the write created or targeted. Fixed per operation: the create
   * source branch, the promote landing label, `null` where no branch applies.
   */
  branch: string | null;
  completed: Completed;
  steps: OperationStep<S>[];
  /** The read-only command that settles an `unknown` step. Present only when one is. */
  resolveWith?: string;
  /** What to do with each answer `resolveWith` gives, when it has more than one. Present only with `resolveWith`. */
  resolveSteps?: string[];
  residue?: OperationResidue;
  /** ISO time the operation began. */
  startedAt: string;
  /** ISO time before which an "absent" answer from `resolveWith` is not proof. Present only with `resolveWith`. */
  resolveNotBefore?: string;
  /**
   * Why the run failed, when it did: the same `code` and `message` the failure
   * document of every other command carries, and the process exit code. Present
   * only on a run that ended in a failure — never on a success, a declined
   * confirmation, or a dry run that answered — so `completed: "no"` always
   * arrives with its reason rather than leaving a caller to scrape stderr.
   */
  error?: OperationFailure;
  /** `false` exactly when `error` is present — the failure document's own marker. */
  ok?: false;
}

/**
 * The reason a failed operation carries (see {@link OperationCore.error}): the
 * failure document's `error`, `details` included — `conflictsWith` on a taken
 * name or an unmet `--expect-live` rides there, not beside the steps.
 */
export type OperationFailure = FailureError;

/** An operation with no extras. */
export type NoExtras = Record<never, never>;

/**
 * The full result: the core fields, plus operation-specific extras beside them
 * under their own keys (`verification`, `live`, `sha256`, …). An extra must not
 * reuse a core key — the core is spread first and an extra would overwrite it.
 */
export type OperationResult<
  S extends string = string,
  X extends object = NoExtras,
> = OperationCore<S> & Partial<X>;

/**
 * Roll per-step answers up to the top-level one: `yes` only when every
 * requested step is `yes`; `no` when any is `no`; `unknown` otherwise.
 * `skipped` steps are left out — the step that stopped the run already carries
 * the answer — so a land that timed out reads `unknown`, not `no`.
 *
 * `no` outranks `unknown` because the question is whether the WHOLE requested
 * outcome exists, and one step that certainly did not happen settles that.
 * What part of it may still exist is carried separately — see `resolveWith`.
 */
export function rollUp(steps: readonly StepOutcome[]): Completed {
  const ran = steps.filter((s): s is Completed => s !== "skipped");
  if (ran.length === 0) return "no";
  if (ran.includes("no")) return "no";
  if (ran.includes("unknown")) return "unknown";
  return "yes";
}

interface StepState {
  /** Set once the command records the step as finished. */
  completed?: StepOutcome;
  /** When the step's write went on the wire, if it did. */
  sentAt?: number;
}

/** How a snapshot is being taken: live progress, an interrupt, or the end of a throw. */
interface SnapshotContext {
  /** Ctrl-C: the step in progress is `unknown`, whatever it had reached. */
  interrupted?: boolean;
  /** The classified outcome of a throw, for the step in progress. */
  failure?: "no" | "unknown";
  /** Included only when some step ends `unknown`. */
  resolveWith?: string;
}

/**
 * The in-progress result a command fills in as its steps finish. Everything a
 * snapshot says is what has been RECORDED, so Ctrl-C at any point reports real
 * progress rather than the command's plan.
 */
export class OperationBuilder<
  S extends string = string,
  X extends object = NoExtras,
> {
  readonly operation: string;
  readonly startedAt: number;
  private destination: OperationDestination;
  private release: OperationRelease;
  private branch: string | null;
  private residue: OperationResidue | undefined;
  private readonly extras: Partial<X>;
  private readonly order: readonly S[];
  private readonly checks: ReadonlySet<S>;
  private readonly state = new Map<S, StepState>();
  private current: S | undefined;
  private readonly now: () => number;
  /** Attached by {@link runOperation}, so `sending()` reaches the interrupt path. */
  registration: OperationRegistration | undefined;

  constructor(init: CreateOperationInput<S, X>) {
    this.operation = init.operation;
    this.destination =
      "instance" in init.destination ? { ...init.destination } : writeTargetPayload(init.destination);
    this.release = { ...init.release };
    this.branch = init.branch;
    this.extras = { ...(init.extras ?? {}) } as Partial<X>;
    this.order = [...init.steps];
    this.checks = new Set(init.checks ?? []);
    for (const s of this.order) this.state.set(s, {});
    this.now = init.now ?? Date.now;
    this.startedAt = this.now();
  }

  private stepState(step: S): StepState {
    const st = this.state.get(step);
    if (st === undefined) {
      throw new Error(
        `"${step}" is not a requested step of ${this.operation} (${this.order.join(", ")}).`,
      );
    }
    return st;
  }

  /** The release as the server stored it, once it says. */
  setRelease(release: OperationRelease): void {
    this.release = { ...release };
  }

  setBranch(branch: string | null): void {
    this.branch = branch;
  }

  /** Record what a failed write left behind, and the command that removes it. */
  setResidue(residue: OperationResidue | undefined): void {
    this.residue = residue === undefined ? undefined : { ...residue };
  }

  /** Set an operation-specific extra. */
  set<K extends keyof X>(key: K, value: X[K]): void {
    this.extras[key] = value;
  }

  /** Enter a step. A throw from here on is attributed to it. */
  begin(step: S): void {
    this.stepState(step);
    this.current = step;
  }

  /**
   * The current step's write is about to go on the wire. Call immediately
   * BEFORE sending it: from here a failure of this step is classified as a
   * possibly-landed write, and Ctrl-C reports it `unknown` instead of
   * "Cancelled.".
   */
  sending(): void {
    if (this.current === undefined)
      throw new Error(
        "sending() called outside a step; call begin(step) first.",
      );
    this.stepState(this.current).sentAt = this.now();
    this.registration?.markWriteSent();
  }

  /**
   * Record a step's answer (default `yes`). A step never begun may be recorded
   * directly — `skipped` for one the command had no need to run (a transfer
   * that found its release already at the destination imports nothing).
   */
  finish(step: S, completed: StepOutcome = "yes"): void {
    this.stepState(step).completed = completed;
    if (this.current === step) this.current = undefined;
  }

  /** The step entered and not yet finished, if any. */
  get inProgress(): S | undefined {
    return this.current;
  }

  /** Whether the step in progress has sent its write. */
  get inProgressSent(): boolean {
    return (
      this.current !== undefined &&
      this.stepState(this.current).sentAt !== undefined
    );
  }

  /**
   * The result as it stands.
   *
   * Steps are resolved in this order: a recorded answer wins; the step in
   * progress takes the interrupt's or the throw's outcome (or, at a normal
   * return, `unknown` if its write was sent and `no` if not); a step never
   * reached after one that stopped the run is `skipped`; any other step never
   * reached is `no` — it did not happen, and nothing explains why.
   */
  snapshot(ctx: SnapshotContext = {}): OperationResult<S, X> {
    let latestUnknownSend: number | undefined;
    // Set once a step has stopped the run: the one in progress, or one
    // recorded as anything but `yes`. `skipped` is safe for what follows only
    // when the stopping step carries the answer into the roll-up — a check that
    // could not run does not (it is left out), so a step it kept from running
    // is `no`: requested, and did not happen.
    let halted: "carried" | "uncarried" | undefined;
    const stop = (name: S, completed: StepOutcome): void => {
      halted ??= this.checks.has(name) && completed === "unknown" ? "uncarried" : "carried";
    };
    const steps: OperationStep<S>[] = this.order.map((name) => {
      const st = this.stepState(name);
      let completed: StepOutcome;
      if (st.completed !== undefined) {
        completed = st.completed;
        if (completed === "no" || completed === "unknown") stop(name, completed);
      } else if (name === this.current) {
        completed = ctx.interrupted
          ? "unknown"
          : (ctx.failure ?? (st.sentAt !== undefined ? "unknown" : "no"));
        stop(name, completed);
      } else {
        completed = halted === "carried" ? "skipped" : "no";
      }
      if (completed === "unknown" && !this.checks.has(name)) {
        const at = st.sentAt ?? this.startedAt;
        latestUnknownSend =
          latestUnknownSend === undefined
            ? at
            : Math.max(latestUnknownSend, at);
      }
      return { name, completed };
    });

    const core: OperationCore<S> = {
      operation: this.operation,
      destination: this.destination,
      release: this.release,
      branch: this.branch,
      // A check that could not run leaves the outcome as it was; see `checks`.
      completed: rollUp(
        steps.map((s) =>
          this.checks.has(s.name) && s.completed === "unknown" ? "skipped" : s.completed,
        ),
      ),
      steps,
      startedAt: new Date(this.startedAt).toISOString(),
    };
    if (this.residue !== undefined) core.residue = this.residue;
    const resolveWith = ctx.resolveWith ?? this.registration?.resolveWith;
    if (latestUnknownSend !== undefined && resolveWith !== undefined) {
      core.resolveWith = resolveWith;
      core.resolveNotBefore = new Date(
        latestUnknownSend + SERVER_PROCESSING_BOUND_MS,
      ).toISOString();
    }
    // Core keys first, so a reader scanning the document meets the answer
    // before the detail; extras must not reuse a core key.
    return { ...core, ...this.extras } as OperationResult<S, X>;
  }
}

export interface CreateOperationInput<S extends string, X extends object> {
  operation: string;
  /** A target to render, or a payload already built (`backendDestinationPayload`). */
  destination: DisclosureTarget | OperationDestination;
  release: OperationRelease;
  branch: string | null;
  /** The REQUESTED steps, in order. A step the caller did not ask for is not listed. */
  steps: readonly S[];
  /**
   * Steps that CHECK the outcome rather than produce it — promote's `verify`.
   * A check that fails is `no` and counts like any step. A check that could not
   * run (`unknown`) leaves the outcome where the steps before it put it: it
   * stays out of the roll-up and names no resolver, because nothing it did can
   * still be landing on the server.
   */
  checks?: readonly S[];
  extras?: Partial<X>;
  /** Clock seam for tests. */
  now?: () => number;
}

/** Start an operation's result. */
export function createOperation<S extends string, X extends object = NoExtras>(
  init: CreateOperationInput<S, X>,
): OperationBuilder<S, X> {
  return new OperationBuilder<S, X>(init);
}

/**
 * The error {@link runOperation} throws once the result is written. Carries
 * the exit code the result implies, the original failure as `cause`, and its
 * message verbatim.
 */
export class OperationError extends Error {
  override readonly name = "OperationError";
  constructor(
    message: string,
    readonly exitCode: number,
    readonly result: OperationResult,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface RunOperationOptions {
  /** `isMachineOutput(args)`: whether stdout carries the JSON document. */
  machine: boolean;
  /** The read-only command that settles an `unknown`, e.g. `xanosdk release list --json`. */
  resolveWith: string;
  /** What to do with each answer `resolveWith` can give, printed under the unknown-outcome line. */
  resolveSteps?: readonly string[];
  /** The write in the reader's words, for the interrupt line: `the landing`. */
  what?: string;
  /**
   * The command's own exit code for a `no`. A failure that carries its own
   * `exitCode` (a source that no longer resolves: 8) keeps it. Default 1.
   */
  exitCode?: number;
}

/**
 * Run a command's write phase and emit its result — the only path that writes
 * a consequential command's JSON, beside the interrupt handler reading the
 * result this registers.
 *
 * - Registers the in-progress result for Ctrl-C before `body` runs, and clears
 *   it once the result is written.
 * - On a normal return with every requested step `yes`: writes the result under
 *   machine output and returns it. The command renders its own human view.
 * - On a throw: classifies it for the step in progress (a step whose write
 *   never left is `no`, whatever else was sent earlier), writes the result,
 *   and throws per the module comment — exit 9 whenever any step is `unknown`.
 *   A `no` whose exit code would not change is rethrown AS ITSELF, so a
 *   `UsageError` keeps its help block.
 * - On a normal return that is not `yes` (a step recorded `no`, or a step left
 *   mid-write): the same as a throw. A command cannot return success over a
 *   write it did not finish.
 *
 * Whenever the run ends with a step `unknown`, one line on stderr names the
 * resolver and says an "absent" answer before `resolveNotBefore` is not proof.
 */
export async function runOperation<S extends string, X extends object>(
  op: OperationBuilder<S, X>,
  opts: RunOperationOptions,
  body: (op: OperationBuilder<S, X>) => Promise<void>,
): Promise<OperationResult<S, X>> {
  const registration = registerOperation({
    machine: opts.machine,
    resolveWith: opts.resolveWith,
    ...(opts.what === undefined ? {} : { what: opts.what }),
    snapshot: ({ interrupted }) => op.snapshot({ interrupted }),
  });
  op.registration = registration;

  let failure: { err: unknown } | undefined;
  let outcome: "no" | "unknown" | undefined;
  try {
    // A write this body sends outside a step's `sending()` is still named, with
    // the same resolver, by a signal that lands while it is on the wire.
    await describeWrite(
      { ...(opts.what === undefined ? {} : { what: opts.what }), resolveWith: opts.resolveWith },
      () => body(op),
    );
  } catch (caught) {
    // Explained before the result is written: it is this run's one document.
    const err = await explainRunFailure(caught);
    failure = { err };
    outcome = classifyFailure(err, { writeSent: op.inProgressSent });
  }

  let result: OperationResult<S, X>;
  try {
    result = op.snapshot({
      ...(outcome === undefined ? {} : { failure: outcome }),
      resolveWith: opts.resolveWith,
    });
  } finally {
    // Cleared before anything is written: from here the run's outcome is
    // decided, and an interrupt must not print a second document.
    registration.clear();
    op.registration = undefined;
  }

  const unresolved = result.resolveWith !== undefined;
  if (unresolved && opts.resolveSteps !== undefined) {
    const { resolveNotBefore, ...rest } = result;
    result = { ...rest, resolveSteps: [...opts.resolveSteps], resolveNotBefore } as OperationResult<S, X>;
  }
  const err = failure?.err;
  const own = exitCodeOf(err);
  // A failure with no code of its own that SAYS its outcome is unknown exits 9
  // from the bin (`processExitCode`); the result's `error.exitCode` says the same.
  const statedUnknown = failure !== undefined && ownExitCode(err) === undefined && processExitCode(err) === EXIT_OUTCOME_UNKNOWN;
  const code =
    unresolved || statedUnknown ? EXIT_OUTCOME_UNKNOWN : (ownExitCode(err) ?? opts.exitCode ?? 1);
  const message =
    failure === undefined
      ? `${op.operation} did not complete: ${result.steps
          .filter((s) => s.completed !== "yes")
          .map((s) => `${s.name} ${s.completed}`)
          .join(", ")}.`
      : err instanceof Error
        ? err.message
        : String(err);
  // The reason rides on the document itself: a failed write writes this result
  // INSTEAD of the failure document, so without it `completed: "no"` was all a
  // caller got. Only for a throw — a run that returned without finishing is a
  // decline or an answer, which the command itself exits 0 over.
  if (failure !== undefined) {
    result = { ok: false, ...result, error: failureError(err, message, code) };
  }

  if (opts.machine) writeJson(result);
  if (unresolved) {
    warn(
      `Outcome unknown — check with \`${result.resolveWith}\` before retrying. An "absent" answer before ` +
        `${result.resolveNotBefore} is not proof: the server may still be finishing the write.`,
      "operation.outcome-unknown",
      opts.resolveSteps,
    );
  }

  if (failure === undefined && result.completed === "yes") return result;

  if (failure !== undefined && code === own) throw err;
  throw new OperationError(
    message,
    code,
    result as OperationResult,
    failure === undefined ? undefined : { cause: err },
  );
}

/** A failure's OWN exit code, when it declares one (not `exitCodeOf`'s fallback 1). */
function ownExitCode(err: unknown): number | undefined {
  const code = (err as { exitCode?: unknown } | null | undefined)?.exitCode;
  return typeof code === "number" ? exitCodeOf(err) : undefined;
}
