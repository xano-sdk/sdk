/**
 * `xanosdk preflight <file>` — compile a workspace, import it into a live Xano
 * instance, read each authored object back, and diff it against what we
 * compiled; optionally run the deployed logic and/or capture the fetched JSON.
 *
 * Named for what it COSTS, not for what it checks. "Validate" reads as a local
 * type-check — the cheap thing you reach for before a deploy — and this is the
 * opposite: it authenticates, creates a throwaway environment, imports into it,
 * and reads every object back over the network. The name is the only warning a
 * reader gets before the first auth prompt.
 *
 * The target instance is a base-URL + token from the environment (`.env`), so
 * the same command runs against cloud dev or a local Docker instance — see
 * `../validate/config.js`. Everything here is JSON over public meta routes,
 * except the one text route an installed toolchain module's `onPreflight` can
 * ask for: the engine's own rendering of the imported environment. The
 * SDK fetches it and hands it over; the comparison belongs to the module.
 *
 * Node-only and lazily imported by the command layer so the browser-safe
 * authoring bundle never pulls in the round-trip stack.
 */
import type { ParsedArgs } from "./cli.js";
import type { ResolvedAuth } from "../auth/token.js";
import type { MetaClient as MetaClientType } from "../validate/meta-client.js";
import type { ValidateConfig as ValidateConfigType } from "../validate/config.js";
import type { LoadedPlugin } from "./toolchain-modules.js";
import {
  describeRuntimeFailure,
  runtimeErrorMessage,
  type RuntimeEntry as RuntimeEntryType,
} from "../validate/runtime.js";
import { sectionKind } from "../deploy/live-diff.js";
import type { CapturedFile as CapturedFileType } from "../validate/capture.js";
import { assertBundleFile, assertBundleInput, assertEntryFile, loadBundleText, refuseValueFlagsBesideBundle } from "./bundle-input.js";
import { UsageError } from "./errors.js";
import { step, success, warn, info, detail, blank, error } from "./ui.js";
import { isMachineOutput, writeJson } from "./output.js";

/** Exit code when validation runs but a check fails (distinct from a usage/transport error). */
const EXIT_VALIDATION_FAILED = 2;

export async function runPreflightCommand(args: ParsedArgs): Promise<void> {
  // Before the config and the token check: a bare `xanosdk preflight` is a usage
  // problem, and answering it by complaining about the environment sends the
  // reader off to fix something that was never the reason this run stopped.
  assertBundleInput(args, { command: "preflight" });
  refuseValueFlagsBesideBundle(args, { command: "preflight" });
  // A --bundle that is missing, a directory, or not JSON — before the token check.
  assertBundleFile(args, { command: "preflight" });
  assertEntryFile(args);
  // `--out` names where `--capture` writes; alone it would be read and dropped.
  if (args.out !== undefined && !args.capture) {
    throw new UsageError("`xanosdk preflight --out` names the directory `--capture` writes its fixtures to — add `--capture`, or drop `--out`.", {
      helpFor: { command: "preflight" },
    });
  }

  const { resolveValidateConfig, envNamesValidateTarget, verifyToken } = await import("../validate/config.js");
  const { MetaClient } = await import("../validate/meta-client.js");
  // No workspace override from the CLI: `preflight` deploys into a disposable
  // ephemeral environment. The workspace id names the PARENT workspace that env
  // is created under; reads target the env, whose internal id is always 1.
  //
  // Two sources for it, and the environment wins. `XANO_VALIDATE_*` is the
  // maintainer path — an arbitrary instance and a hand-held token, which is how
  // this runs against local Docker — and stays untouched. But `preflight` is
  // offered in the public help, so a user who has only ever run `xanosdk login`
  // must not be told to set a variable they have never heard of: with no such
  // target named, the credential every other command acts on supplies both the
  // instance and the parent workspace.
  const fromEnv = envNamesValidateTarget(args.instance);
  if (fromEnv) refuseCredentialFlagsDisplacedByEnv(args);
  const credential = fromEnv ? undefined : await (await import("../auth/token.js")).getAccessToken(args);
  const config = credential === undefined ? resolveValidateConfig({ instance: args.instance }) : validateTargetOf(credential);
  const host = new URL(config.instance).host;
  let who: Awaited<ReturnType<typeof verifyToken>>;
  try {
    who = await verifyToken(config, fromEnv ? "env" : "credential");
  } catch (err) {
    // No answer (a network failure, a 5xx): exit 8, nothing created, this command as the rerun.
    const { unansweredRead } = await import("./source-resolve.js");
    throw unansweredRead(err, "check the credential", "workspace");
  }
  step(`Validating against ${host}${who.name ? ` (as ${who.name})` : ""}`);

  // BEFORE the compile below, which loads the user's entry and unregisters the
  // TypeScript loader behind it — a plugin imported after that fails to resolve
  // in a source checkout. Discovered here rather than inside the validation body
  // for that reason alone; nothing reads the result until the loop is set up.
  const { discoverToolchainPlugins } = await import("./toolchain-modules.js");
  // `frozen: true` although nothing here writes. The flag selects the FAILURE
  // POSTURE, and preflight is a gate: a contributed check that could not load
  // has not passed, and letting it warn would exit 0 on a workspace nothing
  // verified — the fail-green this loader exists to prevent.
  const toolchain = await discoverToolchainPlugins(process.cwd(), { frozen: true });

  const { bundle } = await loadBundleText(args, { command: "preflight" });
  const client = new MetaClient(config);
  // The client creates a fresh ephemeral environment per run, so the round-trip
  // reads back exactly what this bundle produced and never an object a prior run
  // left behind. The `finally` tears it down on every path, including a rejected
  // import and a thrown transport error.
  try {
    await validateWithClient(args, client, bundle, toolchain.loaded, credential);
  } finally {
    const teardown = await client.dispose();
    // A leaked env is a real cost (it holds a URL and a database), so say so —
    // but never fail the run over it: the env carries its own expiry.
    if (teardown.error !== undefined) {
      warn(
        "Could not delete the validation environment; it will expire on its own:",
        "preflight.teardown-failed",
        [teardown.error],
      );
    }
  }
}

/**
 * Refuse a credential-selecting flag the environment has already displaced.
 *
 * `preflight` registers the auth flags, so `--profile` is honoured rather
 * than refused outright — but only on the branch that reaches a credential.
 * With `XANO_VALIDATE_*` set there is no credential for it to select, and this
 * command's own registry states the rule for exactly that case: a command that
 * cannot honour the flag refuses it instead of accepting and ignoring it. This
 * is the same contradiction `getAccessToken` already refuses when the CI meta
 * variables displace a profile, reported the same way.
 */
function refuseCredentialFlagsDisplacedByEnv(args: ParsedArgs): void {
  if (args.profile === undefined) return;
  throw new UsageError(
    `\`--profile ${args.profile}\` selects a stored credential, but this run targets the instance ` +
      `named by XANO_VALIDATE_INSTANCE / --instance, which carries its own token — there is no ` +
      `profile for it to select. Unset the XANO_VALIDATE_* variables (and drop \`--instance\`) to ` +
      `validate as profile "${args.profile}", or drop \`--profile\`.`,
    { helpFor: { command: "preflight" } },
  );
}

/**
 * The stored credential as a validation target.
 *
 * `getAccessToken` is the same resolver `deploy` and the rest go through, so
 * every credential shape reaches `preflight` for free — an OAuth login, a meta
 * token on disk, the CI environment triple, a `--profile` selection — and none
 * of it is re-implemented here. Its `workspaceId` is part of the credential
 * rather than a per-command choice, which is exactly the parent-workspace
 * semantics this command needs.
 */
function validateTargetOf(auth: ResolvedAuth): ValidateConfigType {
  return { instance: auth.instance, token: auth.access_token, workspaceId: auth.workspaceId };
}

/** The validation body proper — everything that needs the imported environment. */
async function validateWithClient(
  args: ParsedArgs,
  client: MetaClientType,
  bundle: string,
  plugins: readonly LoadedPlugin[],
  credential: ResolvedAuth | undefined,
): Promise<void> {
  const { runValidateLoop, runnableFunctionNames } = await import("../validate/loop.js");
  // A project whose plugins declare no `onPreflight` never pays for the engine's
  // text route: the loop only fetches it when something is going to read it.
  const { anyDeclares } = await import("./toolchain-hooks.js");
  const wantsPluginInputs = anyDeclares(plugins, "onPreflight");
  const result = await runValidateLoop(client, bundle, {
    includeEngineRendering: wantsPluginInputs,
  });

  // Under machine output the verdict is ONE document, written on every ending —
  // a failed check sets the exit code rather than throwing, so no failure
  // document would follow it.
  const report = (passed: boolean, runtime: RuntimeEntryType[] | null, captured: CapturedFileType[] | null): void => {
    if (!isMachineOutput(args)) return;
    writeJson({
      passed,
      accepted: result.accepted,
      importError: result.importError ?? null,
      workspaceId: result.workspaceId ?? null,
      // The SDK's kind names, not the payload's storage keys: an author wrote a
      // `table`, never a `dbo`.
      roundTrip: result.roundTrip.map(({ sdkKind, name, label, status, diffs }) => ({
        kind: sdkKind,
        name,
        label,
        status,
        diffs,
      })),
      unchecked: result.unchecked.map(({ kind, count }) => ({ kind: sectionKind(kind), count })),
      // The raw run body is `--verbose` only, as in the human view: a success
      // can carry live row data, and a failure carries the engine's whole debug
      // structure (internal keys, a value store) that nothing outside it reads.
      // A failure's `error` is the one line out of it a caller acts on.
      runtime: args.verbose ? runtime : (runtime?.map((e) => runtimeSummary(e)) ?? null),
      captured,
    });
  };

  if (!result.accepted) {
    // The parent workspace answers an id the credential cannot see with "Invalid
    // workspace" — the setting to fix and the ids that work, not an authoring
    // rejection. Returns when the list holds the id, holds none, or is unread.
    if (credential !== undefined) {
      const { refuseUnreachableWorkspace } = await import("./workspace-binding.js");
      await refuseUnreachableWorkspace(credential);
    }
    warn("Import rejected by the engine:", "preflight.import-rejected", [result.importError ?? "(no message)"]);
    process.exitCode = EXIT_VALIDATION_FAILED;
    report(false, null, null);
    return;
  }
  success(`Import accepted (workspace #${result.workspaceId ?? "?"})`);

  let failed = false;

  // Named the way every report names an object (`table:users`,
  // `query:GET ping (apiGroup shop)`). The success line carries no mark of its
  // own: `success` already prints one.
  for (const entry of result.roundTrip) {
    if (entry.status === "match") {
      success(`round-trip ${entry.label}`);
    } else if (entry.status === "missing") {
      warn(`round-trip ? ${entry.label} — not found in the imported workspace`, "preflight.roundtrip");
      failed = true;
    } else if (entry.status === "ambiguous") {
      warn(`round-trip ? ${entry.label} — multiple imported objects share its identity`, "preflight.roundtrip");
      failed = true;
    } else {
      const shown = args.verbose ? entry.diffs : entry.diffs.slice(0, 10);
      warn(
        `round-trip ✗ ${entry.label} — ${entry.diffs.length} field diff${entry.diffs.length === 1 ? "" : "s"}`,
        "preflight.roundtrip",
        [
          ...shown.map((d) => `${d.path}: expected ${fmt(d.expected)}, got ${fmt(d.actual)}`),
          ...(!args.verbose && entry.diffs.length > shown.length
            ? [`… ${entry.diffs.length - shown.length} more (run with --verbose)`]
            : []),
        ],
      );
      failed = true;
    }
  }

  for (const u of result.unchecked) {
    info(`imported ${u.count} ${sectionKind(u.kind)} object${u.count === 1 ? "" : "s"} — round-trip not checked`);
  }

  // A plugin's comparison reaches the SAME exit code the built-in checks use.
  // That is what keeps CI able to gate on it: a contributed check that reported
  // a difference but exited 0 would be a check nobody could rely on.
  if (wantsPluginInputs && result.engineComparison === undefined) {
    // Asked for, and not there. The loop returns no comparison when it never
    // got a workspace id to read back, and a contributed check that did not run
    // has not passed — so this fails the gate rather than quietly shrinking
    // what was verified.
    warn(
      "A toolchain module's check could not run: the engine comparison was unavailable.",
      "preflight.check-unavailable",
      ["preflight imported the bundle but could not read the workspace back to compare against."],
    );
    failed = true;
  } else if (wantsPluginInputs && result.engineComparison !== undefined) {
    const { fireOnPreflight } = await import("./toolchain-hooks.js");
    const { readVersion } = await import("./cli.js");
    const outcome = await fireOnPreflight(plugins, {
      engineRendering: result.engineComparison.engineRendering,
      exportedPayload: result.engineComparison.exportedPayload,
      remappedPayload: result.engineComparison.remappedPayload,
      verbose: args.verbose === true,
      cwd: process.cwd(),
      sdkVersion: readVersion(),
    });
    if (outcome.failed) failed = true;
  }

  let runtime: RuntimeEntryType[] | null = null;
  if (args.runtime && result.workspaceId !== undefined) {
    // Run only functions that actually imported (status match/diff). Other kinds
    // (tables, queries, …) aren't invocable via the function/run route — the
    // helper gates to function-kind entries so a table name is never run.
    const names = runnableFunctionNames(result.roundTrip);
    if (names.length > 0) {
      const { smokeRunFunctions, functionsWithInputs } = await import("../validate/runtime.js");
      blank();
      const entries = await smokeRunFunctions(client, result.workspaceId, names, {}, functionsWithInputs(JSON.parse(bundle)));
      runtime = entries;
      for (const e of entries) {
        if (e.needsInputs) {
          // Run with no input, and refused for exactly that: the engine said
          // nothing about the function's logic, so it neither passes nor fails
          // the gate. Said on its own line so a skip is never read as a pass.
          const why = runtimeErrorMessage(e.detail);
          info(`runtime – ${e.name} not run: it needs inputs${why !== undefined ? ` (${why})` : ""}`);
          if (args.verbose) detail(fmt(e.detail));
        } else if (e.ran) {
          success(`runtime ${e.name}`);
          // "It ran" is not "it returned what the author claimed". A function
          // can answer 200 with a null key or a key missing entirely, which is
          // how a sandbox example shipped a comment promising a value it never
          // produced. Under `--verbose` the body is printed so the author can
          // check the RESULT, not just the exit status.
          if (args.verbose) detail(fmt(e.detail));
        } else {
          // A throw answers HTTP 200, so the status alone reads as a pass; the
          // engine's message is what says why it failed.
          warn(`runtime ✗ ${e.name} (${describeRuntimeFailure(e)})`, "preflight.runtime", args.verbose ? [fmt(e.detail)] : []);
          failed = true;
        }
      }
    }
  }

  let captured: CapturedFileType[] | null = null;
  if (args.capture) {
    const { captureFixtures } = await import("../validate/capture.js");
    const written = captureFixtures(result.roundTrip, args.out);
    captured = written;
    if (written.length === 0) warn("nothing to capture (no objects round-tripped)", "preflight.nothing-captured");
    for (const w of written) detail(`captured ${w.name} → ${w.path}`);
  }

  if (failed) {
    process.exitCode = EXIT_VALIDATION_FAILED;
    blank();
    error("Validation failed");
  } else {
    blank();
    success("Validation passed");
  }
  report(!failed, runtime, captured);
}

/** A runtime entry without its raw run body — the `--json` shape outside `--verbose`. */
function runtimeSummary(e: RuntimeEntryType): Record<string, unknown> {
  const head = { name: e.name, ran: e.ran, status: e.status, ...(e.needsInputs ? { needsInputs: true } : {}) };
  return e.ran ? head : { ...head, error: runtimeErrorMessage(e.detail) ?? null };
}

function fmt(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "(absent)";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
