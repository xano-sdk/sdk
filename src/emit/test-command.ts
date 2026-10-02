/**
 * `xanosdk test list | run <name> | run-all` — run the unit and workflow tests an
 * environment already carries.
 *
 * Takes no entry file and compiles nothing. It reports what is DEPLOYED, which
 * is the honest answer to "did my tests pass" — a local tree that has not been
 * deployed has no tests on any engine to run.
 *
 * ## Identity comes from listing, never from deriving it locally
 *
 * A `TestDef` carries a deterministic derived id, so computing it from the local
 * tree and posting straight to the run route looks like a free round trip. It is
 * not: a test authored in the Xano UI has an id Xano SDK never minted, a pulled
 * test carries the id Xano minted for it, and a workflow test is addressed by a
 * NUMERIC id the engine assigns at import — which no local derivation can
 * produce at all. Listing first is the only resolution that covers every case.
 *
 * Node-only (fetch + the OAuth stack); lazily imported by `cli.ts` so the
 * browser-safe authoring bundle never pulls it in.
 */
import type { ParsedArgs } from "./cli.js";
import { contextFlags } from "./context-flags.js";
import { shellQuote } from "../util/shell-quote.js";
import { lastRateLimitRetryAfter, TransportError } from "../util/http.js";
import { getAccessToken, type BearerTarget } from "../auth/token.js";
import { listTests, runTest, qualifiedName, objectQualifiedName, type TestHandle, type TestExpectation, type TestKind, type TestOutcome } from "../deploy/tests.js";
import type { MetaTarget } from "./env-target.js";
import { isMachineOutput, writeJson } from "./output.js";
import { UsageError, unknownSubcommand } from "./errors.js";
import { requireBackendSlot } from "./backend-slot.js";
import { memoCredential, resolveBackend } from "./tracked-backend.js";
import { actualKind, describeBackend, isRateLimited, rateLimitedCause } from "./source-resolve.js";
import type { SourceKind } from "./source-selector.js";
import { blank, detail, step, stderrStyle, success, terminalText, warn } from "./ui.js";

/**
 * A suite that RAN and disagreed, distinct from a crash.
 *
 * Joins the codes already in use — 2 a validation that ran and disagreed, 3 a
 * static upload that failed, 4 a microservice that never came up — because a
 * caller scripting around `deploy --test` acts differently on "a test failed"
 * than on "the deploy blew up".
 */
export const EXIT_TESTS_FAILED = 5;

/**
 * Which backend a run read, as every machine document names one.
 *
 * `kind` is the field every `--json` document that names a backend carries.
 * `env` is the ephemeral's or tenant's server-assigned name, and only that —
 * null for a local engine, so a script feeding it to `xanosdk ephemeral` never
 * addresses an engine. `name` is the backend's own name whatever its kind (the
 * same handle as `env`, or a local engine's enumerated name), the rule
 * `tables --json` follows; `display` is its display name. All are always
 * present, null where the kind has none, so the keys never depend on the kind.
 */
interface Ran {
  kind: SourceKind;
  env: string | null;
  name: string | null;
  display: string | null;
}

/**
 * The projected, secret-free result document `--json` emits.
 *
 * The per-test array is `tests`, the same key `xanosdk test list` uses and the
 * same key the nested `deploy --test` document uses. It was `results` here, so
 * a script that read `test list` and then `test run-all` found the array under
 * one name and not the other, and reported an empty suite as a passing one.
 * One name across the family is the whole point.
 */
export interface TestRunSummary extends Ran {
  /** The whole suite: `passed + failed + notRun`. */
  total: number;
  passed: number;
  failed: number;
  /** Tests the run never reached because the suite stopped answering; 0 on a run that finished. */
  notRun: number;
  /** With `notRun`: those tests, as `test run` takes them. Absent on a run that finished. */
  unreachable?: string[];
  tests: Array<{
    kind: string;
    name: string;
    /** `type:object/name` for a unit test, the bare name for a workflow test — what `test run` takes. */
    qualified: string;
    object?: { type: string; name: string };
    status: "pass" | "fail";
    /** The first failing expectation's message, or the run's own error sentence. */
    message?: string;
    /** A unit test's every expectation, in order. Absent for a workflow test. */
    expectations?: TestExpectation[];
    timing?: number;
  }>;
}

/**
 * Map over `items` with at most `limit` in flight, settling results into their
 * INPUT positions.
 *
 * Order matters more than it looks: a concurrent run whose output is emitted in
 * completion order cannot be diffed against a sequential one, which makes "did
 * this change break a test" a manual reading exercise. Callers get results in
 * input order regardless of the order they finished in.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

/**
 * What a printed `xanosdk test …` needs to read the backend THIS run read: its
 * `--on`, and its credential flags (see `contextFlags`) — except on a local
 * engine, which refuses them.
 */
function sameBackend(args: ParsedArgs): string {
  const on = args.on ? ` --on ${shellQuote(args.on)}` : "";
  return args.on !== undefined && /^local-engine\b/.test(args.on) ? on : `${on}${contextFlags(args)}`;
}

/** How a test is labelled in the human view: its family, and the object it hangs off. */
function describe(handle: TestHandle): string {
  const object = handle.object;
  if (object === undefined) return "[workflow]";
  // A query is named by verb and group too — `GET notes` and `POST notes` are two.
  return object.verb === undefined
    ? `[unit: ${object.type} ${object.name}]`
    : `[unit: ${object.type} ${object.verb} ${object.name}${object.group === undefined ? "" : ` in ${object.group}`}]`;
}

/** The per-test line, plus each failure message indented beneath it. */
function renderOutcome(outcome: TestOutcome, width: number): void {
  const s = stderrStyle();
  const verdict = outcome.status === "pass" ? s.green("PASS") : s.red("FAIL");
  const timing = outcome.timing === undefined ? "" : s.dim(`  ${outcome.timing.toFixed(3)}s`);
  process.stderr.write(terminalText(`  ${verdict}  ${outcome.name.padEnd(width)}  ${s.dim(describe(outcome))}${timing}\n`));
  if (outcome.status !== "fail") return;
  // Every failing expectation, so one run shows all that is wrong. A failure
  // with none to name (a refused run, a workflow test) has only `message`.
  const failures = (outcome.expectations ?? []).filter((e) => e.status === "fail" && e.message !== undefined);
  if (failures.length > 1) {
    // Counted from 1 and said with the total, so it cannot be read as the
    // zero-based `index` `--json` carries for the same expectation.
    const total = outcome.expectations!.length;
    for (const e of failures) process.stderr.write(terminalText(`        ${s.dim(`expectation ${e.index + 1} of ${total}:  ${e.message}`)}\n`));
  } else if (outcome.message !== undefined) {
    process.stderr.write(terminalText(`        ${s.dim(outcome.message)}\n`));
  }
}

/** Project outcomes into the `--json` document. */
function summarize(ran: Ran, outcomes: TestOutcome[], unreachable: readonly string[] = []): TestRunSummary {
  return {
    kind: ran.kind,
    env: ran.env,
    name: ran.name,
    display: ran.display,
    ...suiteCounts(outcomes, unreachable),
    tests: outcomes.map(testRow),
  };
}

/** One test as every test-bearing document reports it — `test run`, `run-all` and `deploy --test` alike. */
export function testRow(o: TestOutcome): TestRunSummary["tests"][number] {
  return {
    kind: o.kind,
    name: o.name,
    // The same key `test list` carries, so a name read from a run feeds `test run`.
    qualified: qualifiedName(o),
    object: o.object,
    status: o.status,
    message: o.message,
    expectations: o.expectations,
    timing: o.timing,
  };
}

/**
 * The counts every test-bearing document carries — `test run`, `test run-all`
 * (whole or partial) and `deploy --test`'s `testRun` alike (E2E pass 29): the
 * whole suite as `total`, and the tests a suite that stopped answering never
 * reached as `notRun`, named under `unreachable`.
 */
export function suiteCounts(
  outcomes: readonly TestOutcome[],
  unreachable: readonly string[] = [],
): { total: number; passed: number; failed: number; notRun: number; unreachable?: string[] } {
  const passed = outcomes.filter((o) => o.status === "pass").length;
  const failed = outcomes.length - passed;
  return {
    total: outcomes.length + unreachable.length,
    passed,
    failed,
    notRun: unreachable.length,
    ...(unreachable.length > 0 ? { unreachable: [...unreachable] } : {}),
  };
}

/**
 * Emit the run's outcome on whichever channel this invocation uses, and set the
 * exit code.
 *
 * `process.exitCode` rather than a throw: the code must apply in BOTH output
 * modes, and throwing would replace the JSON document a caller is parsing with a
 * stderr sentence.
 */
function report(args: ParsedArgs, ran: Ran, outcomes: TestOutcome[], empty = "No tests found."): void {
  const summary = summarize(ran, outcomes);
  // The empty document carries the same keys a populated one does, so a
  // wrapper never has to special-case an environment with no suite. The tally
  // below is progress, on stderr in both modes, beside the document.
  if (isMachineOutput(args)) writeJson(summary);
  if (outcomes.length === 0) {
    // Success, not failure: a fresh environment having no tests is normal, and
    // "0 passed, 0 failed" would read as a suite that ran.
    detail(empty);
  } else {
    blank();
    printTally(summary.passed, summary.failed);
  }
  if (summary.failed > 0) process.exitCode = EXIT_TESTS_FAILED;
}

/**
 * The closing `N passed, M failed` line, marked one way for `test run-all` and
 * `deploy --test` alike: `✓` when everything passed, a red line when anything
 * failed, and a plain `…, K not run` line when the suite stopped part-way. The two used to disagree (`!` on one, a bare red line on the other).
 */
export function printTally(passed: number, failed: number, notRun = 0): void {
  const line = `${passed} passed, ${failed} failed${notRun > 0 ? `, ${notRun} not run` : ""}`;
  if (failed > 0) process.stderr.write(terminalText(`  ${stderrStyle().red(line)}\n`));
  // A run that stopped part-way is not a pass, whatever it read: no `✓` in
  // front of the failure that follows (E2E pass 28).
  else if (notRun > 0) process.stderr.write(terminalText(`  ${line}\n`));
  else success(line);
}

/** A resolved backend, reduced to what the three verbs read: where, as whom, and how it is named. */
interface Resolved {
  ran: Ran;
  bearer: BearerTarget;
  target: MetaTarget;
}

/**
 * Resolve `--on`, or the tracked default when it is absent.
 *
 * The credential is a provider, not a value: a local engine is reached with
 * its own bearer, so a run against one never reads (or refreshes) a Xano
 * credential — a signed-out developer iterating locally is never told to log
 * in. `--profile` beside a local engine is refused by the resolver, not dropped.
 */
async function resolveOn(args: ParsedArgs, subcommand: string): Promise<Resolved> {
  const slot = requireBackendSlot("test", subcommand, "on");
  const resolved = await resolveBackend(slot, args.on, {
    credential: memoCredential(() => getAccessToken(args)),
    profile: args.profile,
  });
  return {
    ran: {
      // The target's ACTUAL kind: `--on tenant:<name>` can name an ephemeral.
      kind: actualKind(resolved),
      // The resolver reports the env name as its own field; `label` is
      // human-facing prose and is not a machine value to parse back out of.
      env: resolved.target.env ?? null,
      // The backend's own name whatever its kind, and its display name — the
      // same pair `tables --json` reports, so the two documents agree.
      name: resolved.backend.kind === "local" ? resolved.backend.engine.name : (resolved.target.env ?? null),
      display: resolved.target.display ?? null,
    },
    bearer: resolved.bearer,
    // The human lines name the backend with its kind and display name — an
    // ephemeral's bare server name is a handle nobody recognises.
    target: { ...resolved.target, label: describeBackend(resolved) },
  };
}

/**
 * List, with the truncation warning wired to stderr.
 *
 * The one lister for all three verbs: a silently truncated walk would otherwise
 * report a subset as the whole suite, and each verb re-deciding that is how one
 * of them ends up without the warning.
 */
async function collect(auth: BearerTarget, target: MetaTarget, kind: TestKind | undefined): Promise<TestHandle[]> {
  return listTests(auth, target, {
    kind,
    onTruncate: (collected) =>
      warn(`Stopped after ${collected} tests — the list did not terminate, so some may not have run.`, "test.list-truncated"),
  });
}

/** The longest name, so the human table's columns line up. */
function nameWidth(handles: readonly TestHandle[]): number {
  return Math.max(0, ...handles.map((h) => h.name.length));
}

async function runList(args: ParsedArgs): Promise<void> {
  const { ran, bearer, target } = await resolveOn(args, "list");
  const handles = await collect(bearer, target, args.kind).catch(async (err: unknown) => {
    const { unansweredRead } = await import("./source-resolve.js");
    throw unansweredRead(err, `list the tests on ${target.label}`, ran.kind);
  });

  if (isMachineOutput(args)) {
    writeJson({
      kind: ran.kind,
      env: ran.env,
      name: ran.name,
      display: ran.display,
      total: handles.length,
      tests: handles.map((h) => ({
        kind: h.kind,
        name: h.name,
        qualified: qualifiedName(h),
        object: h.object,
        // Only a named one: `""` is the empty (recommended) datasource, which
        // printed as `"datasource": ""` on every workflow test — a key whose
        // value says there is nothing. Absent means the same.
        ...(h.datasource === undefined || h.datasource === "" ? {} : { datasource: h.datasource }),
      })),
    });
    return;
  }

  if (handles.length === 0) {
    detail(await noTestsFound(bearer, target, args.kind));
    return;
  }
  const s = stderrStyle();
  step(`${handles.length} test${handles.length === 1 ? "" : "s"} in ${target.label}`);
  const width = nameWidth(handles);
  for (const handle of handles) {
    // A non-empty datasource is the run-time hazard worth seeing BEFORE you run:
    // the engine clones it, and cloning a large one is slow enough to fail.
    const ds =
      handle.datasource === undefined || handle.datasource === ""
        ? ""
        : s.yellow(`  datasource: ${handle.datasource}`);
    process.stderr.write(terminalText(`  ${handle.name.padEnd(width)}  ${s.dim(describe(handle))}${ds}\n`));
  }
}

/**
 * Find the one test `needle` names.
 *
 * Matches the qualified form first — `type:object/name`, a query's
 * `query:<group>|<verb>|<name>/test`, a workflow test's `workflow:name` —
 * which is exactly what the ambiguity error below prints, so the string it
 * suggests is a string that works. Then `type:object/name` without a query's group and verb, which selects one test
 * while that query's name is unique; then the short name.
 */
function match(handles: readonly TestHandle[], needle: string): TestHandle[] {
  // Every qualified form carries a prefix a short name does not (`workflow:`
  // for a workflow test), so matching it first never lets one test shadow a
  // same-named test of the other family.
  const qualified = handles.filter((h) => qualifiedName(h) === needle);
  if (qualified.length > 0) return qualified;
  const byObject = handles.filter((h) => objectQualifiedName(h) === needle);
  if (byObject.length > 0) return byObject;
  return handles.filter((h) => h.name === needle);
}

/**
 * A test name the environment does not have. Exits 8, the code every other
 * named thing that is not there exits with (a release, a branch, an
 * ephemeral): the command was typed right, and the environment holds no such test.
 * `SDK_ERROR`, the errors table's code for a NAMED thing that cannot be found;
 * `SDK_USAGE` with exit 8 is a missing LOCAL path only.
 */
export class TestNotFoundError extends Error {
  override readonly name = "TestNotFoundError";
  readonly exitCode = 8;
  readonly code = "SDK_ERROR";
  constructor(
    message: string,
    /** The near name the message suggests — the failure document's `suggestion`. */
    readonly suggestion?: string,
    /** Every near name a tie named, `suggestion` first — the failure document's `suggestions`. */
    readonly suggestions?: readonly string[],
  ) {
    super(message);
  }
}

async function runOne(args: ParsedArgs, name: string): Promise<void> {
  const { ran, bearer, target } = await resolveOn(args, "run");
  const handles = await reaching(ran, target, args, "run", () => collect(bearer, target, args.kind));
  const found = match(handles, name);

  if (found.length === 0) {
    // The nearest name, when a slip away (E2E pass 23: `test run echoez`) —
    // every one of a tie, and in `--json` too (E2E pass 28).
    const { suggestAll, orNames } = await import("../util/suggest.js");
    const near = suggestAll(name, [...new Set(handles.map((h) => h.name))]);
    const nearest = near[0];
    const offer =
      nearest === undefined
        ? ""
        : near.length === 1
          ? ` Did you mean "${nearest}"? \`xanosdk test run ${shellQuote(nearest)}${sameBackend(args)}\` runs it.`
          : ` Did you mean ${orNames(near)}?`;
    throw new TestNotFoundError(
      `No test named "${name}" in ${target.label}.${offer}` +
        ` \`xanosdk test list${sameBackend(args)}\` shows the ones that exist.`,
      nearest,
      near.length > 1 ? near : undefined,
    );
  }
  if (found.length > 1) {
    const forms = found.map((h) => qualifiedName(h));
    const distinct = [...new Set(forms)];
    // Two tests of one name on one object have no form that tells them apart —
    // printing that form twice, or the name just typed, suggests a command
    // that fails the same way.
    if (distinct.length < forms.length || distinct.includes(name)) {
      throw new Error(
        `"${name}" names ${found.length} tests in ${target.label} that no qualified form tells apart ` +
          `(${distinct.map((f) => `"${f}"`).join(", ")}). Rename one of them, then run it by its new name.`,
      );
    }
    throw new Error(
      `"${name}" names ${found.length} tests in ${target.label}. Use the qualified form:\n` +
        forms.map((f) => `  xanosdk test run ${shellQuote(f)}${sameBackend(args)}`).join("\n"),
    );
  }

  const handle = found[0]!;
  step(`Running ${handle.name} in ${target.label}`);
  const outcome = await reaching(ran, target, args, "run", () => runTest(bearer, target, handle));
  renderOutcome(outcome, handle.name.length);
  report(args, ran, [outcome]);
}

/**
 * List an environment's tests and run them, rendering the table on stderr as
 * they settle. Returns the outcomes in INPUT order; an empty array means the
 * environment carries no tests, which is a normal state and not a failure.
 *
 * Rendered whatever stdout is: the lines are progress, and progress goes to
 * stderr in both output modes. A CI job that pipes stdout into a parser reads
 * stderr in its log, and that is exactly where a PASS/FAIL line is looked for.
 *
 * Shared by `xanosdk test run-all` and `xanosdk deploy --test`, so a suite reads
 * identically whether it was run on its own or as the last step of a deploy.
 *
 * A {@link BearerTarget} rather than a full credential: the target says where to
 * read and the bearer says who is asking, and nothing beneath this reads more.
 * That is what lets `deploy --local-engine --test` run against the ENGINE's own
 * token — the alternative would be dressing a local engine up as a credential,
 * which is the one thing the local value is shaped to make impossible.
 * Reporting and the exit code stay with the caller: a deploy has its own summary
 * document to fold these into.
 */
export async function runSuite(
  auth: BearerTarget,
  target: MetaTarget,
  opts: {
    kind?: TestKind;
    concurrency?: number;
    /** Each outcome as it settles — so a caller keeps what ran when a later test's run throws. */
    onOutcome?: (outcome: TestOutcome) => void;
    /**
     * Each test that could not be run because the suite stopped answering
     * ({@link isSuiteUnreachable}). With it, the first such failure stops the
     * run instead of throwing: every test not yet started is passed here too,
     * and the results already read are returned. Without it, the failure throws.
     */
    onUnreachable?: (handle: TestHandle, err: Error) => void;
  } = {},
): Promise<TestOutcome[]> {
  const handles = await collect(auth, target, opts.kind);
  if (handles.length === 0) return [];

  const units = handles.filter((h) => h.kind === "unit").length;
  const flows = handles.length - units;
  step(
    `Running ${handles.length} test${handles.length === 1 ? "" : "s"} against ${target.label} ` +
      `(${units} unit, ${flows} workflow)`,
  );
  blank();

  const width = nameWidth(handles);
  // Emit in INPUT order as each test settles, so a concurrent run's output stays
  // diffable against a sequential one.
  let emitted = 0;
  // `null`: a test that could not be run — nothing to render in its place.
  const settled = new Array<TestOutcome | null | undefined>(handles.length);
  const flush = (): void => {
    while (emitted < settled.length && settled[emitted] !== undefined) {
      const outcome = settled[emitted];
      if (outcome !== null && outcome !== undefined) renderOutcome(outcome, width);
      emitted++;
    }
  };

  // The first unanswered run, when the caller takes them one by one.
  let stopped: Error | undefined;
  const outcomes = await mapWithConcurrency(handles, opts.concurrency ?? 1, async (handle, index) => {
    let outcome: TestOutcome | null;
    if (stopped !== undefined && opts.onUnreachable !== undefined) {
      opts.onUnreachable(handle, stopped);
      outcome = null;
    } else {
      try {
        outcome = await runTest(auth, target, handle);
      } catch (err) {
        if (opts.onUnreachable === undefined || !isSuiteUnreachable(err)) throw err;
        stopped ??= err;
        opts.onUnreachable(handle, err);
        outcome = null;
      }
    }
    settled[index] = outcome;
    if (outcome !== null) opts.onOutcome?.(outcome);
    flush();
    return outcome;
  });
  return outcomes.filter((o): o is TestOutcome => o !== null);
}

async function runAll(args: ParsedArgs): Promise<void> {
  const { ran, bearer, target } = await resolveOn(args, "run-all");
  const unreachable: { handle: TestHandle; err: Error }[] = [];
  const outcomes = await reaching(ran, target, args, "run-all", () =>
    runSuite(bearer, target, {
      kind: args.kind,
      concurrency: args.concurrency,
      onUnreachable: (handle, err) => void unreachable.push({ handle, err }),
    }),
  );
  if (unreachable.length > 0) throw partialRunError(ran, target, args, outcomes, unreachable);

  report(args, ran, outcomes, outcomes.length === 0 ? await noTestsFound(bearer, target, args.kind) : undefined);
}

/**
 * The suite stopped answering part-way (E2E pass 27: one 502 threw away every
 * result read before it, and said "no result was read"). What was read is
 * kept — printed, and under `details.results` as the document a whole run
 * writes — and the tests that could not be run are named, in
 * `details.unreachable` as `test run` takes them. Still exit 6: the suite did
 * not answer.
 */
function partialRunError(
  ran: Ran,
  target: MetaTarget,
  args: ParsedArgs,
  outcomes: TestOutcome[],
  unreachable: readonly { handle: TestHandle; err: Error }[],
): TestsUnreachableError {
  const names = unreachable.map((u) => qualifiedName(u.handle));
  const results = summarize(ran, outcomes, names);
  if (outcomes.length > 0) {
    blank();
    printTally(results.passed, results.failed, unreachable.length);
  }
  const first = unreachable[0]!.err;
  const head = first.message.split("\n")[0] ?? first.message;
  const n = names.length;
  const read =
    outcomes.length === 0
      ? "no result was read"
      : `${outcomes.length} ${outcomes.length === 1 ? "result was" : "results were"} read (${results.passed} passed, ` +
        `${results.failed} failed)`;
  const again = `xanosdk test run-all${args.kind !== undefined ? ` --kind ${args.kind}` : ""}${sameBackend(args)}`;
  return new TestsUnreachableError(
    `${head}\nThe tests on ${target.label} stopped answering: ${n} ${n === 1 ? "test" : "tests"} could not be run ` +
      `(${names.join(", ")}), and ${read}. ${unreachableCheck(first, ran, args)}, then run \`${again}\` again.`,
    { cause: first, details: { results, unreachable: names } },
  );
}

/**
 * The line for a suite with nothing to run. Under `--kind`, the filter is
 * named, and so is what it left out: "No tests found." read as an empty
 * environment when every test was of the other kind. The other kind is
 * counted only here, with nothing found — a read that fails costs the count.
 */
export async function noTestsFound(
  auth: BearerTarget,
  target: MetaTarget,
  kind: TestKind | undefined,
  where = "",
): Promise<string> {
  if (kind === undefined) return `No tests found${where}.`;
  const other: TestKind = kind === "unit" ? "workflow" : "unit";
  const n = await listTests(auth, target, { kind: other }).then(
    (h) => h.length,
    () => undefined,
  );
  if (n === 0) return `No tests found${where}.`;
  if (n === undefined) return `No ${kind} tests found${where}.`;
  return (
    `No ${kind} tests found${where} (${n} ${other} test${n === 1 ? " exists" : "s exist"}; ` +
    `drop --kind or use --kind ${other}).`
  );
}

/** Exit code for a suite that could not be reached — the same 6 `deploy --test` exits with. */
export const EXIT_TESTS_UNREACHABLE = 6;

/**
 * The tests could not be reached: the environment gave no answer to the list
 * or a run. Not a failing test (5) and not a gone backend (8, raised by the
 * resolve before this): the backend is recorded and was resolved, and did not
 * answer. `llms/tests.md` documents it as 6.
 */
export class TestsUnreachableError extends Error {
  override readonly name = "TestsUnreachableError";
  readonly exitCode = EXIT_TESTS_UNREACHABLE;
  /** The failure document's code — `SDK_ERROR`, as before, so `details` travels with it. */
  readonly code = "SDK_ERROR";
  /** A run stopped part-way: `{ results, unreachable }` (see `partialRunError`). */
  readonly details: { results: TestRunSummary; unreachable: string[] } | undefined;

  constructor(message: string, opts: { cause?: unknown; details?: { results: TestRunSummary; unreachable: string[] } } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.details = opts.details;
  }
}

/**
 * Whether `err` says the suite gave no answer: a transport failure, or a run
 * the environment (or a gateway before it) answered with a bare 5xx. Anything
 * else — a refused credential, a bad answer — is not unreachable.
 */
export function isSuiteUnreachable(err: unknown): err is Error {
  return err instanceof TransportError || (err instanceof Error && err.name === "TestRunUnansweredError");
}

/**
 * What to check when a suite could not be reached, as a clause the caller
 * ends: the backend's own status command where there is one, and the network.
 */
export function suiteUnreachableCheck(ran: { kind: SourceKind; env: string | null }, args: ParsedArgs): string {
  return ran.kind === "local-engine"
    ? "Check that the local engine is still running (`xanosdk local-engine list`)"
    : ran.kind === "ephemeral" && ran.env !== null
      ? `Check that it is still up with \`xanosdk ephemeral get ${shellQuote(ran.env)}${contextFlags(args)}\` — an ephemeral expires — and that this machine reaches the instance`
      : "Check that this machine reaches the instance (network, VPN or proxy)";
}

/**
 * {@link suiteUnreachableCheck} for `err` — except a request the rate limit
 * turned away (429), whose check is the wait it asked for.
 */
function unreachableCheck(err: unknown, ran: { kind: SourceKind; env: string | null }, args: ParsedArgs): string {
  if (!isRateLimited(err)) return suiteUnreachableCheck(ran, args);
  const wait = lastRateLimitRetryAfter() === undefined ? "Wait a moment" : "Wait that long";
  return `${rateLimitedCause()}: the instance turned the request away before acting on it. ${wait}`;
}

/**
 * Run `work`, turning an unreachable suite ({@link isSuiteUnreachable}) into
 * {@link TestsUnreachableError}: what did not answer, that no result was read,
 * and what to check — the read's generic "Nothing was changed — retry." named
 * no check, and a test run's lost answer ("may or may not have taken effect")
 * is a test, not a deploy. Anything else is left as it is.
 */
async function reaching<T>(ran: Ran, target: MetaTarget, args: ParsedArgs, verb: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (!isSuiteUnreachable(err)) throw err;
    const head = err.message.split("\n")[0] ?? err.message;
    const again = `xanosdk test ${verb}${verb === "run" && args.positionals[0] !== undefined ? ` ${shellQuote(args.positionals[0])}` : ""}${args.kind !== undefined ? ` --kind ${args.kind}` : ""}${sameBackend(args)}`;
    throw new TestsUnreachableError(
      `${head}\nThe tests on ${target.label} could not be reached, so no result was read. ${unreachableCheck(err, ran, args)}, then run \`${again}\` again.`,
      { cause: err },
    );
  }
}

export async function runTestCommand(args: ParsedArgs): Promise<void> {
  // Usage first, credentials second: a mistyped `--on` is a problem in the line
  // that was typed, and answering it with "not signed in" sends the reader off
  // to fix something that was never the reason it stopped. The resolver parses
  // the typed value against the slot before it reads anything — and it reads a
  // credential at all only when the backend is a hosted one.
  switch (args.subcommand) {
    case "list":
      return runList(args);
    case "run": {
      const name = args.positionals[0];
      if (name === undefined || name === "") {
        throw new UsageError(`\`xanosdk test run\` needs a test name: \`xanosdk test run "<name>"${sameBackend(args)}\`.`, {
          hintFor: { command: "test", subcommand: "run" },
        });
      }
      return runOne(args, name);
    }
    case "run-all":
      return runAll(args);
    default:
      throw unknownSubcommand("test", args.subcommand);
  }
}

