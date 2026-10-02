/**
 * `xanosdk workspace <details|export>` — read the workspace your
 * credential is bound to.
 *
 * This is the *real* workspace, not a throwaway: the instance and workspace the
 * credential pins (at consent for `login`, or `workspace_id` for a hand-authored
 * meta API token). The family deliberately mirrors `ephemeral`, since the two
 * answer the same questions about different environments —
 *
 *   xanosdk workspace details          which workspace am I actually bound to?
 *   xanosdk workspace export           give me its bundle JSON
 *   xanosdk workspace diff             is what I staged what I meant to stage?
 *   xanosdk workspace reset-tables     put named tables back to their seed rows
 *
 * — with `xanosdk init --from workspace` writing that same bundle out as a
 * runnable Xano SDK project
 *
 * — and deliberately stops there. **There is no `workspace deploy`.** The only
 * import path available is the server's clear-then-import, a full replace, so
 * writing back to a workspace holding real data is not something this CLI offers.
 * The loop is: pull from here, edit, deploy to an ephemeral env.
 *
 * The group is no longer read-only, and has not been for a while: the branch
 * verbs move the live pointer, and `reset-tables` writes row content. What it
 * still refuses is a WHOLESALE write — every writing verb here is aimed at
 * something the caller named.
 *
 * There is no workspace override: a credential addresses exactly one workspace.
 * Node-only (fetch/fs + OAuth); lazily imported by the command layer.
 */
import { writeData } from "../util/secrets.js";
import { describeWrite } from "../util/sent-writes.js";
import { HOSTED_ROW_PATH_PREFIX } from "../fields/hosted-file.js";
import type { ParsedArgs } from "./cli.js";
import { contextFlags } from "./context-flags.js";
import { getAccessToken, type ResolvedAuth } from "../auth/token.js";
import { reachableWorkspaces, refuseUnreachableWorkspace, unreachableWorkspaceMessage } from "./workspace-binding.js";
import { resolveOutputTarget, secretsPhrase, writeExportFile } from "./output-target.js";
import { secretsCarriedBy } from "../deploy/live-diff.js";
import { fetchWorkspaceBundle } from "./codegen-command.js";
import { printMicroserviceSection, readMicroservices } from "./microservice-view.js";
import {
  formatFields,
  step,
  success,
  warn,
  error,
  info,
  detail,
  blank,
  stdoutStyle,
  printHuman,
  credentialWriteTarget,
  discloseWriteTarget,
  writeTargetPayload,
  type WriteTarget,
} from "./ui.js";
import { assertBundleFile, assertBundleInput, assertEntryFile, assertValueFiles, loadBundleText } from "./bundle-input.js";
import { confirm } from "./prompt.js";
import { yesRerun } from "./retry-command.js";
import { listTables } from "../deploy/table.js";
import { listBranches } from "../deploy/branch.js";
import { tablesCommand } from "./commands.js";
import { unknownSubcommand, UsageError } from "./errors.js";
import { bindingFor, fetchOrExplain, httpFailure, parseJsonAnswer } from "../util/http.js";
import { isMachineOutput, writeJson } from "./output.js";

const TIMEOUT_MS = 30_000;

/** Default output basename for `workspace export` when `--name` is omitted. */
const DEFAULT_NAME = "workspace";

export async function runWorkspaceCommand(args: ParsedArgs): Promise<void> {
  switch (args.subcommand) {
    case "details":
      return runDetails(args);
    case "export":
      return runExport(args);
    case "diff":
      return runDiff(args);
    case "reset-tables":
      return runResetTables(args);
    case "branch": {
      // The one WRITING verb under `workspace`, and deliberately so: promoting a
      // branch finishes a staged `deploy --to … --branch`, and rolling one back is how
      // `--backup-branch` earns its name. Neither writes object content — they
      // move the live pointer — so the read-only rule in the module header holds.
      const { runBranchCommand } = await import("./branch-commands.js");
      return runBranchCommand(args);
    }
    default:
      throw unknownSubcommand("workspace", args.subcommand, args.positionals);
  }
}

/** The workspace list the account can see, from the meta API. */
async function fetchWorkspaces(auth: ResolvedAuth): Promise<Array<Record<string, unknown>>> {
  const url = new URL("/api:meta/workspace", auth.instance);
  const res = await fetchOrExplain(
    url.href,
    {
      headers: { accept: "application/json", Authorization: `Bearer ${auth.access_token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
    "workspace list",
    TIMEOUT_MS,
  );
  const text = await res.text();
  if (!res.ok) {
    // The status rides on the error: a 5xx is no answer, and exits 8 as one.
    throw Object.assign(new Error(httpFailure("workspace list", res, text)), { status: res.status });
  }
  const parsed = parseJsonAnswer(text, "workspace list", url.href);
  return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
}

/**
 * `workspace details` — which workspace the credential is bound to, and where.
 *
 * Worth its own verb because every other command in this family silently acts on
 * that pinned id; a user about to run `init --from workspace` should be able to check
 * what it will read before it reads it.
 */
async function runDetails(args: ParsedArgs): Promise<void> {
  const auth = await getAccessToken(args);
  const workspaceId = auth.workspaceId;
  // A list that got no answer exits 8 with this run as the rerun, as every other read does.
  const all = await fetchWorkspaces(auth).catch(async (err: unknown) => {
    const { unansweredRead } = await import("./source-resolve.js");
    throw unansweredRead(err, "read the workspace list", "workspace");
  });
  const match = all.find((w) => w.id === workspaceId);

  // A well-formed but WRONG `workspace_id` is the likeliest hand-authoring
  // mistake, and a half-empty record would read like a successful answer.
  // Since this verb exists to answer "what am I bound to", say plainly that
  // the answer is nothing — and list the ids that would work.
  // Usage, as every other command refuses a pinned id the credential cannot see.
  if (!match) throw new UsageError(unreachableWorkspaceMessage(auth, reachableWorkspaces(all)));

  const summary = {
    instance: auth.instance,
    id: workspaceId,
    name: typeof match.name === "string" ? match.name : undefined,
    guid: typeof match.guid === "string" ? match.guid : undefined,
    /** Which credential this command is acting under — the only thing that selects a workspace. */
    credential: auth.credentialType,
  };

  // The real workspace is addressed at the instance origin under its OWN id —
  // never the fixed 1 an ephemeral uses internally.
  const microservices = await readMicroservices(auth, auth.instance, workspaceId);

  if (isMachineOutput(args)) {
    // `id` is the workspace's own record; `workspaceId` and `selector` are the
    // names every other document gives the backend it acts on.
    writeJson({ ...summary, microservices, workspaceId, selector: "workspace" });
    return;
  }
  const s = stdoutStyle();
  const rows: Array<[string, string]> = [
    ["instance", summary.instance],
    ["workspace", `${summary.name === undefined ? "(unnamed)" : summary.name} ${s.dim(`#${summary.id}`)}`],
  ];
  if (summary.guid !== undefined) rows.push(["guid", summary.guid]);
  rows.push([
    "source",
    summary.credential === "token" ? "your meta API token credential" : "your sign-in (pinned at login)",
  ]);
  printHuman(formatFields(rows) + "\n");
  printMicroserviceSection(microservices);
}

/**
 * `workspace export` — the workspace bundle as JSON.
 *
 * JSON only, unlike `sandbox export`: the multidoc route is a sandbox/tenant
 * surface, and the bundle is what the pull and `deploy` both speak.
 */
async function runExport(args: ParsedArgs): Promise<void> {
  // `--name` only names a FILE, and `--path -` writes none — accepted together,
  // the name would be dropped without a word and a caller would go looking for
  // a file that was never written.
  if (args.path === "-" && args.name !== undefined) {
    throw new UsageError(
      "`--name` names the exported file, and `--path -` writes the bundle to stdout instead of a file. " +
        "Drop one: `--path -` to pipe it, or `--name` (with or without a `--path` directory) to write a file.",
      { hintFor: { command: "workspace", subcommand: "export" } },
    );
  }
  // The target first: a `--name` that can never be written is refused before
  // the workspace is read, not after a full export it then throws away.
  const target = resolveOutputTarget({ path: args.path, name: args.name ?? DEFAULT_NAME, ext: "json" });
  const auth = await getAccessToken(args);
  const bundle = await fetchWorkspaceBundle(auth, args.branch);
  const content = JSON.stringify(bundle, null, 2);

  if (target.kind === "stdout") {
    // stdout stays a clean data channel, as with every other export.
    writeData(process.stdout, content + "\n");
    // A file holding these is written owner-only and says so; stdout has no
    // such protection, so the same fact is said on stderr.
    const secrets = secretsCarriedBy(bundle);
    if (secrets.length > 0) {
      warn(
        `The export carries ${secretsPhrase(secrets)} in cleartext — written to stdout, where no file ` +
          `permission protects it; do not commit or log it.`,
        "secrets.cleartext-stdout",
      );
    }
    return;
  }
  // A `--path` into a directory that does not exist yet is created, not a crash.
  // The bundle carries the workspace's env values and documentation tokens in
  // cleartext, so a file holding them is written owner-only and said so.
  writeExportFile(target.path, content + "\n", secretsCarriedBy(bundle));
  // One line for one write. The artifact went to the file, so a machine reader is owed a document naming it.
  if (isMachineOutput(args)) writeJson({ path: target.path });
  // On stderr, so a piped run says it too.
  success(`Exported workspace → ${target.path}`);
}

/**
 * `workspace diff` — what is actually on that branch, against what this project
 * compiles to.
 *
 * A staged release is the one write in this CLI whose success nobody downstream
 * can check. `deploy --to … --branch` lands an archive on a branch the instance is not
 * serving, so a section that never arrived breaks nothing until the branch is
 * promoted — at which point it breaks production. The release reports what it
 * SENT; this reports what is there.
 *
 * Three answers, kept apart because the remedies are different:
 *
 *   differing    the branch holds an older copy — the stage is stale
 *   missing      the branch holds none of it — the write did not land
 *   unexpected   the branch holds something this project does not declare
 *
 * Only the middle one is evidence that a write failed. "Unexpected" is routinely
 * legitimate — a workspace predating this project, or an object someone added
 * through the UI — so it is reported and never a verdict. The comparison itself
 * is `compareToLive`, shared with the release path rather than reimplemented: two
 * comparisons would eventually disagree about whether a release converged, and
 * the one claiming to verify a write would be the dangerous half.
 *
 * Read-only, including on the local side: it compiles, it does not write a
 * bundle out. A run that reports differences still prints its full answer, and
 * then exits {@link EXIT_DIFF_MISMATCH} — "ran and disagreed", the code
 * `preflight` and `promote` use — so CI can gate on a stage that did not land.
 * Unexpected objects alone are not a mismatch.
 */
/** `workspace diff` ran and the target does not hold what this project declares. */
export const EXIT_DIFF_MISMATCH = 2;

async function runDiff(args: ParsedArgs): Promise<void> {
  // Inside a project a bare diff compares its entry, as `deploy` and
  // `release create` default to it.
  if (args.file === undefined && args.bundle === undefined) {
    const { resolveProjectEntry } = await import("./deploy-source.js");
    const entry = resolveProjectEntry(process.cwd());
    if (entry !== undefined) args = { ...args, file: entry };
  }
  // A mistyped input is answered as one before the credential is read.
  assertBundleInput(args, { command: "workspace", subcommand: "diff" });
  assertBundleFile(args, { command: "workspace", subcommand: "diff" });
  assertEntryFile(args);
  const auth = await getAccessToken(args);
  // Local side first. It is the half that can fail for a reason the author can
  // fix without a network, and reporting a compile error after a full workspace
  // read reads as though the workspace were at fault.
  const local = await loadBundleText(args, { command: "workspace", subcommand: "diff" });
  // `fetchWorkspaceBundle` is the guard-then-export pairing, taken whole: the
  // label check, the "does that branch exist" list, the capability probe that has
  // to run BEFORE the read (an instance that ignores the parameter hands back
  // live and every later line would call it the branch), and then the export.
  // Re-pairing those here would be a second opinion about which of them a read
  // needs, and the failure mode of the wrong opinion is a diff that compares the
  // live branch while naming a staged one.
  let live: Awaited<ReturnType<typeof fetchWorkspaceBundle>>;
  try {
    live = await fetchWorkspaceBundle(auth, args.branch);
  } catch (err) {
    const { unansweredRead } = await import("./source-resolve.js");
    throw unansweredRead(err, "read the workspace to compare", "workspace");
  }

  const { compareToLive, SETTINGS_LABEL } = await import("../deploy/live-diff.js");
  const { codePinnedCanonicals, releaseCanonicalLock } = await import("./release-command.js");
  // The pins the release path would send. Without them every api group, toolset
  // and realtime server sits permanently in the differing set: a slug the code
  // never named is minted LOCALLY by the lock, the instance keeps whatever it is
  // already serving, and the two can never agree about a value neither side
  // promised. Derived exactly as the release derives it, so the diff cannot
  // report a difference the release would not.
  const pinned = codePinnedCanonicals(local.bundle, releaseCanonicalLock(args), args.file !== undefined);
  const result = compareToLive(
    JSON.parse(local.bundle) as unknown,
    live,
    new Set(pinned.map((p) => `${p.payloadKey}:${p.name}`)),
    // Everything, not the report's sample: a caller who ran a diff asked for the
    // list, and a truncated one would hide the object they are looking for.
    // The documentation token is compared as a value: this asks what the target
    // SAYS, and the live token is the outcome of the one this project sends.
    { sample: "all", documentation: "compare" },
  );
  if (!result.converged) process.exitCode = EXIT_DIFF_MISMATCH;

  // Which branch was read, by label, and whether it is the live one. Without
  // `--branch` the read is of whichever branch is live, and a bare "live" left
  // the caller to find out which that was. A courtesy, not the answer: a
  // listing that fails or marks nothing live leaves the label unknown rather
  // than failing a comparison that already ran.
  const listed = await listBranches(auth, { baseUrl: auth.instance, workspaceId: auth.workspaceId }).catch(
    () => undefined,
  );
  const liveLabel = listed?.find((b) => b.live)?.label;
  const comparedLabel = args.branch ?? liveLabel;
  // Null when a named branch was read and the listing could not say which is
  // live: "not live" would be a guess.
  const comparedIsLive: boolean | null =
    args.branch === undefined ? true : liveLabel === undefined ? null : args.branch === liveLabel;

  // An agent is the primary reader of a diff, and every other verb in this
  // family answers on stdout. Emitted BEFORE the human rendering rather than
  // instead of it at the end, so the two cannot drift about what was compared.
  //
  // The three classes ship present-and-empty on a clean result: a consumer
  // reading `missing.length` must not have to tell "nothing missing" from "the
  // field is absent". `liveOnly` is renamed to `unexpected` for the same reason
  // the human block spells it out — "live" names the wrong thing entirely when
  // the comparison ran against a staged branch.
  if (isMachineOutput(args)) {
    writeJson({
      branch: comparedLabel ?? null,
      live: comparedIsLive,
      compared: result.compared,
      // Not `converged`: this answers "is everything I declared there, as
      // declared", and an undeclared object the target also carries does not
      // make that false. The `unexpected` list is how a caller asks the other
      // question.
      matched: result.converged,
      missing: result.missing,
      differing: result.differing,
      // Beside `differing` rather than inside it, so its entries stay plain
      // `<sdkKind>:<name>` strings a caller can match on.
      settingsFields: result.settingsFields,
      unexpected: result.liveOnly,
      source: local.source,
    });
    return;
  }

  const where =
    args.branch !== undefined ? `branch "${args.branch}"` : liveLabel !== undefined ? `live branch "${liveLabel}"` : "live";
  // Two separate questions, and only the first can fail a stage: "is everything
  // this project declares there, as declared" and "is anything else there".
  // `converged` answers the first — an object only the target holds is not a
  // difference to it, because a merge leaves those alone — so the second is asked
  // here rather than folded in. An UNDECLARED object is routine (a workspace
  // older than this project, a UI edit) and reporting it as a mismatch would
  // teach a reader to ignore the line that means a write went missing.
  if (result.converged) {
    success(`${where} holds everything this project declares (${result.compared} ${result.compared === 1 ? "object" : "objects"} compared).`);
    if (result.liveOnly.length > 0) {
      blank();
      report("unexpected there, not declared here", result.liveOnly);
      blank();
      // Not "`--prune` deletes them": prune deletes only what this project
      // released (its lock), and refuses the rest — which these usually are.
      detail(`Not a failure — a merge leaves them alone, and so does \`--prune\` unless this project released them.`);
      detail(`To remove one this project never released, adopt it first (\`xanosdk lock import\`), then prune.`);
    }
    return;
  }
  warn(
    `${where} does not match this project’s compile ` +
      `(${result.compared} ${result.compared === 1 ? "object" : "objects"} compared, ${result.differingCount} differing, ` +
      `${result.missingCount} missing, ${result.liveOnly.length} unexpected).`,
    "workspace.drift",
  );
  blank();
  // Missing first. It is the only class that means a write did not arrive, and
  // the only one worth acting on before anything else on screen.
  report("missing there, declared here", result.missing);
  report(
    "differing",
    result.differing.map((row) =>
      row === SETTINGS_LABEL && result.settingsFields.length > 0
        ? `${row} — ${result.settingsFields.join(", ")}`
        : row,
    ),
  );
  report("unexpected there, not declared here", result.liveOnly);
  blank();
  detail(`Compared against ${local.source}. Nothing was written.`);
}

/** One labelled block of `<sdkKind>:<name>` rows, or nothing when the class is empty. */
function report(label: string, rows: readonly string[]): void {
  if (rows.length === 0) return;
  step(`${rows.length} ${label}`);
  for (const row of rows) detail(row);
}

/**
 * `workspace reset-tables <entry> --table <guid>` — put named tables back to the
 * seed rows the project compiles.
 *
 * ## Why this is its own command and not a flag on the import
 *
 * The import route has a `truncate` of its own, and it is the obvious place to
 * reach for. It cannot be aimed: it empties every table the import created or
 * updated, and the archive carries every table's schema regardless of which
 * tables' ROWS were selected — so scoping it to one table is not a thing the
 * route can express. Using it to fix one stale reference row would take the
 * workspace's audit history with it.
 *
 * So this is built from the two per-table primitives instead, which can be
 * aimed: empty this table, insert these rows. Everything the command names is
 * touched and nothing else is.
 *
 * ## The two calls are not a transaction
 *
 * They cannot be — the API offers no way to make them one — so a failure between
 * them leaves the named table EMPTY. That is stated in the output rather than
 * engineered around, because it is survivable for exactly the data this exists
 * for: reference rows the project can re-derive from its own source, where
 * running the command again is a complete remedy. It would not be survivable for
 * rows that only exist on the instance, which is why this takes named tables and
 * never an "all seeded tables" shortcut.
 *
 * ## Ordering, for the caller
 *
 * Tables are workspace-shared while logic is branch-scoped, so rows applied here
 * reach production immediately even when the logic that reads them is staged.
 * Rows first, then logic: with old logic and new rows the worst case is a
 * feature that is not there yet, and the reverse breaks the feature that is.
 */
/** The tables a compiled bundle declares, by guid and name. */
function projectTables(bundle: string): Array<{ guid: string; name: string }> {
  const dbo = (JSON.parse(bundle) as { payload?: { dbo?: unknown } }).payload?.dbo;
  if (!Array.isArray(dbo)) return [];
  return dbo.flatMap((t) => {
    const { guid, name } = (t ?? {}) as { guid?: unknown; name?: unknown };
    return typeof guid === "string" && typeof name === "string" ? [{ guid, name }] : [];
  });
}

async function runResetTables(args: ParsedArgs): Promise<void> {
  const target = { command: "workspace", subcommand: "reset-tables" } as const;
  const guids = args.table ?? [];
  if (guids.length === 0) {
    throw new UsageError(
      `\`xanosdk workspace reset-tables\` needs at least one \`--table <guid>\`. ` +
        `Run \`${tablesCommand("workspace")}${contextFlags(args)}\` to see the guids this workspace holds.\n` +
        `Tables are named by guid rather than by name because a table name may contain ` +
        `anything at all — a comma, a space, or nothing but digits — so a name is display-only.`,
      { helpFor: target },
    );
  }

  // Before the credential, because it costs nothing and the alternative is a
  // baffling refusal. An exported bundle is already-serialized text with no
  // registry behind it, so it carries every table's SCHEMA and none of their
  // seed rows — a `--bundle` run would resolve zero seeds and tell the caller
  // their table "is not a seeded table", which is true of the bundle and false
  // of their project. Name the real reason instead. A `.json` positional is the
  // same mistake spelled without the flag, and would otherwise be imported as a
  // module and fail on its syntax. No help block, here or on the refusals
  // below: each names its own way out, and the verb's usage cannot say which
  // tables are seeded or present.
  const bundleGiven =
    args.bundle !== undefined
      ? "`--bundle`"
      : args.file !== undefined && /\.json$/i.test(args.file)
        ? `\`${args.file}\``
        : undefined;
  if (bundleGiven !== undefined) {
    throw new UsageError(
      `\`workspace reset-tables\` needs the entry file, not ${bundleGiven}. Seed rows are resolved ` +
        `from the table definitions at compile time; an exported bundle carries each table's ` +
        `schema but none of its rows, so there would be nothing to reset to.\n` +
        `Pass the entry file: \`xanosdk workspace reset-tables ./index.ts --table <guid> --write${contextFlags(args)}\`.`,
    );
  }

  // A `--write` that will have to ask, with nobody to ask, refuses at the
  // confirmation below — after every check, so the `--yes` it prints is a run
  // that goes through. Its compile reads the lock without writing it: a refusal
  // must not leave a `xano.lock` and its "commit it" notice behind a command
  // that wrote nothing.
  const willRefuse = args.write === true && args.yes !== true && process.stdin.isTTY !== true;

  // A missing entry is the typo it is, exit 8 — not "not signed in". The
  // compile's value files likewise: read only inside it, after sign-in.
  assertEntryFile(args);
  assertValueFiles(args, target);
  const auth = await getAccessToken(args);
  // The seed rows come from the SAME build the deploy path performs, so a row
  // this command would write is a row a deploy would write.
  // A dry run reads the lock and writes nothing — not even `xano.lock`, whose
  // "commit it" notice would contradict the "nothing was written" below.
  const local = await loadBundleText(args.write === true && !willRefuse ? args : { ...args, lockReadOnly: true }, target, {
    withSeed: true,
  });
  const { seedRowsByTableGuid } = await import("../workspace/seed.js");
  const seeds = seedRowsByTableGuid(local.content);

  // Every refusal before any write. A run that emptied one table and then
  // discovered the second guid was a typo would have done real damage for a
  // mistake that was visible up front.
  //
  // A guid the project has no table for is a different mistake from a table
  // with no `seed` — a typo, answered with the guids that do exist rather than
  // with advice to add a seed to a table that is not there.
  const declared = projectTables(local.bundle);
  const unknown = guids.filter((guid) => !declared.some((t) => t.guid === guid));
  if (unknown.length > 0) {
    throw new UsageError(
      `${local.source} declares no table with guid ${unknown.join(", ")}.\n` +
        (declared.length === 0
          ? `It declares no tables at all.`
          : `Its tables:\n${declared.map((t) => `  ${t.guid}  ${t.name}${seeds.has(t.guid) ? "  (seeded)" : ""}`).join("\n")}`),
    );
  }
  const unseeded = guids.filter((guid) => !seeds.has(guid));
  if (unseeded.length > 0) {
    throw new UsageError(
      `${unseeded.join(", ")} ${unseeded.length === 1 ? "is" : "are"} not a seeded table in ` +
        `${local.source}. This command resets a table to the rows the PROJECT declares, so a ` +
        `table the compile carries no \`seed\` for has nothing to reset to — it would simply be ` +
        `emptied. Add a \`seed\` to the table, or drop it from this command.`,
    );
  }

  // A hostedFile() in a seeded file column only resolves when the row lands
  // through an import that carries the file; rows written straight into the
  // table would point at nothing. Refused here, before anything is emptied.
  const withFiles = guids.filter((guid) => seeds.get(guid)!.some(holdsHostedFile));
  if (withFiles.length > 0) {
    const names = withFiles.map((guid) => declared.find((t) => t.guid === guid)?.name ?? guid);
    throw new UsageError(
      `${names.join(", ")} ${names.length === 1 ? "seeds" : "seed"} a file column from hostedFile(), which only ` +
        `lands through a deploy that ships the file. Reset ${names.length === 1 ? "it" : "them"} with \`xanosdk deploy\` instead.`,
    );
  }

  const tables = await listTables(auth, {
    workspaceId: auth.workspaceId,
    binding: bindingFor(auth, auth.workspaceId, false),
  });
  // An id the credential cannot see lists 200 with no rows: not "not in this workspace".
  if (tables.length === 0) await refuseUnreachableWorkspace(auth);
  const byGuid = new Map(tables.map((t) => [t.guid, t]));
  const absent = guids.filter((guid) => !byGuid.has(guid));
  if (absent.length > 0) {
    throw new UsageError(
      `${absent.join(", ")} ${absent.length === 1 ? "is" : "are"} not in this workspace. ` +
        `Run \`${tablesCommand("workspace")}\` to list the guids it holds.`,
    );
  }

  const destination: WriteTarget = credentialWriteTarget(auth);
  // The rows a reset destroys, read live: the dry run, the confirmation and the
  // document all say how many. `null` when the count could not be read.
  const { countTableRows } = await import("../deploy/table.js");
  const planned = await Promise.all(
    guids.map(async (guid) => {
      const table = byGuid.get(guid)!;
      const existing = await countTableRows(auth, {
        workspaceId: auth.workspaceId,
        tableId: table.id,
        binding: bindingFor(auth, auth.workspaceId, false),
      }).catch(() => undefined);
      return { guid, id: table.id, name: table.name, rows: seeds.get(guid)!.length, existing: existing ?? null };
    }),
  );
  const tableDoc = (t: (typeof planned)[number]) => ({ guid: t.guid, name: t.name, existingRows: t.existing, seedRows: t.rows });

  // Dry run by DEFAULT: the safe outcome is the one that happens when a flag is
  // forgotten. `--write` is the opposite of the usual `--dry-run`, deliberately
  // — this empties a table on a real workspace, and a command that did that
  // because someone left a flag off would be the wrong way round.
  if (args.write !== true) {
    // The headline first: an indented "on …" line with nothing above it read as
    // the tail of whatever the terminal printed before. On stderr, so a piped
    // run says it too.
    step(`Would reset ${planned.length} table(s) — nothing was written`);
    discloseWriteTarget(destination);
    for (const t of planned) detail(`${t.name} — ${existingPhrase(t.existing)} deleted, ${t.rows} seed row(s) from ${local.source} inserted`);
    blank();
    detail(`Re-run with \`--write\` to apply. Every other table is left alone.`);
    if (isMachineOutput(args)) {
      writeJson({ destination: writeTargetPayload(destination), dryRun: true, tables: planned.map(tableDoc) });
    }
    return;
  }

  step(`Resetting ${planned.length} table(s) to their seed rows`);
  discloseWriteTarget(destination);
  if (args.yes !== true) {
    const ok = await confirm(
      `Delete ${planned.map((t) => `${existingPhrase(t.existing)} from "${t.name}"`).join(", ")} and re-seed ` +
        `${planned.length === 1 ? "it" : "them"} on workspace #${auth.workspaceId}?`,
      { flag: "--yes", refusal: { details: { dryRun: false, declined: false, tables: [] }, ...yesRerun(args, "workspace reset-tables") } },
    );
    if (!ok) {
      info("Cancelled — nothing was written.");
      // A decline answers `--json` too, rather than leaving stdout empty.
      if (isMachineOutput(args)) {
        writeJson({ destination: writeTargetPayload(destination), dryRun: false, declined: true, tables: [] });
      }
      return;
    }
  }

  const { truncateTable, insertTableRows } = await import("../deploy/table.js");
  const done: typeof planned = [];
  for (const t of planned) {
    step(`Resetting ${t.name}`);
    try {
      await describeWrite({ what: `the emptying of table "${t.name}"` }, () =>
        truncateTable(auth, { workspaceId: auth.workspaceId, tableId: t.id }),
      );
    } catch (err) {
      // The other half of the same promise. A caller mid-way through a
      // multi-table reset needs to know where it stopped whichever call failed,
      // and a truncate that fails leaves a DIFFERENT state from one that
      // succeeded before a failed insert — the rows should still be there, but
      // this command did not read them back, so it does not claim they are.
      error(`"${t.name}" could not be emptied — its rows were most likely left as they were.`);
      detail(`Nothing was re-seeded for it. Re-run once the cause is fixed; the rows come from ${local.source}.`);
      if (done.length > 0) detail(`Already reset: ${done.map((d) => d.name).join(", ")}.`);
      throw err;
    }
    try {
      await describeWrite({ what: `the re-seed of table "${t.name}"` }, () =>
        insertTableRows(auth, {
          workspaceId: auth.workspaceId,
          tableId: t.id,
          rows: seeds.get(t.guid)!,
        }),
      );
    } catch (err) {
      // The table is EMPTY right now, and saying so is the whole point: the
      // reader has to know the state they are in before they can decide what to
      // do, and the remedy is cheap precisely because the rows come from source.
      error(`"${t.name}" was emptied but its seed rows did not land — it is EMPTY now.`);
      detail(`Run the same command again to finish it. The rows come from ${local.source}, so nothing is lost.`);
      if (done.length > 0) detail(`Already reset: ${done.map((d) => d.name).join(", ")}.`);
      throw err;
    }
    done.push(t);
  }

  // On stderr, so a piped run says it too: the document carries the rest.
  success(`Reset ${done.length} table(s) to their seed rows`);
  for (const t of done) detail(`${t.name} — ${existingPhrase(t.existing)} deleted, ${t.rows} seed row(s) inserted`);
  detail(`Every other table in this workspace was left alone.`);
  if (isMachineOutput(args)) {
    writeJson({ destination: writeTargetPayload(destination), dryRun: false, tables: done.map(tableDoc) });
  }
}

/** A table's live row count as a reset states it: what it destroys. */
function existingPhrase(existing: number | null): string {
  return existing === null ? "its existing rows (count unreadable)" : `${existing} existing row${existing === 1 ? "" : "s"}`;
}

/** Whether a compiled seed row holds a hostedFile() value in any column. */
function holdsHostedFile(row: Record<string, unknown>): boolean {
  const hosted = (v: unknown): boolean =>
    typeof v === "object" && v !== null && typeof (v as { path?: unknown }).path === "string" &&
    ((v as { path: string }).path).startsWith(HOSTED_ROW_PATH_PREFIX);
  return Object.values(row).some((v) => (Array.isArray(v) ? v.some(hosted) : hosted(v)));
}
