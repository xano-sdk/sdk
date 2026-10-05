/**
 * The renderer behind `xanosdk tables [backend]`, for every kind it lists.
 *
 * The kinds differ in exactly one thing: the backend they resolve. The caller
 * hands this the `ResolvedSource` — which knows its own host and workspace id,
 * and that an env or tenant numbers its workspace 1 — so the rendering, the
 * JSON shape, the column order and the empty state are identical by
 * construction rather than by agreement. That matters because a user reads a
 * guid out of one of these and pastes it into `release create --seed` against
 * any of them.
 *
 * **Why the verb exists.** A table's guid appears in no artifact a user holds.
 * Before this, an environment's guids were reachable only by typing a wrong one
 * and reading them out of the refusal — a usable accident, not a feature, and
 * it made guid selection unusable for exactly the source people cut from most.
 *
 * **The guid stability note is NOT printed here**, deliberately. A deploy
 * preserves the archive's guids, so a value read here keeps matching until the
 * table is renamed — worth saying once, but a line on every listing becomes
 * furniture, and these listings are also the machine-readable path (`--json`)
 * where a line of prose is noise. The note lives in the verb's `--help`
 * summary instead, where someone deciding to use the command reads it, and out
 * of the data channel.
 */
import type { ParsedArgs } from "./cli.js";
import { contextFlags } from "./context-flags.js";
import { listTables } from "../deploy/table.js";
import { actualKind, describeBackend, isServerError, isTransportFailure, LookupFailedError, unansweredCause, type ResolvedSource } from "./source-resolve.js";
import { isMachineOutput, writeJson } from "./output.js";
import { formatTableListing, info, detail, step, printHuman } from "./ui.js";

/**
 * How the human lines name a source: `Ephemeral "pr-3" ("My App")`.
 *
 * Derived from the resolved source (`describeBackend`) rather than assembled
 * per kind — the noun copies this verb replaced drifted into "This workspace"
 * beside the resolver's own "your workspace" — and by the target's ACTUAL
 * kind, so an ephemeral named as `tenant:<name>` is called an ephemeral.
 */
function subjectOf(resolved: ResolvedSource): string {
  const described = describeBackend(resolved);
  return described.charAt(0).toUpperCase() + described.slice(1);
}

/**
 * A listing that got no answer — a dropped socket right after a create, a
 * timeout — as the unreachable-lookup contract says it: exit 8, nothing
 * changed, rerun this command (the dispatcher names the command line). It
 * exited 1 as a bare SDK_ERROR while `test run-all` on the same blip said
 * unreachable (E2E pass 25). Anything else passes through.
 */
function unreachableListing(err: unknown, resolved: ResolvedSource): unknown {
  // A server error (5xx) is no answer either (E2E pass 30: a 503 exited 1).
  const transport = isTransportFailure(err);
  if (!transport && !isServerError(err)) return err;
  const message = (err instanceof Error ? err.message : String(err)).trim();
  const head = (message.split("\n")[0] ?? message).trim().replace(/[.:]$/, "");
  return new LookupFailedError(
    `Could not list the tables of ${describeBackend(resolved)} — ${head}. ${unansweredCause(err)}, ` +
      `not an empty backend — nothing was changed`,
    "unreachable",
    actualKind(resolved),
  );
}

/**
 * Print one source's tables, or write them as JSON.
 *
 * Takes the RESOLVED source rather than a hand-assembled host and workspace id:
 * `target` already carries both, along with the rule that its base is appended
 * to and never resolved against. The call goes out on the
 * source's own `bearer`, so a Xano Engine lists through the same path as a
 * hosted source; only a hosted one has a binding to explain a 403 against.
 *
 * The id prints first because other engine surfaces and URLs show it, so it is
 * what makes a row recognizable; the guid follows because it is what the reader
 * came to copy; the name is last because it is quoted free text of unbounded
 * width and would push the fixed columns out of alignment anywhere else.
 */
export async function printTableListing(args: ParsedArgs, resolved: ResolvedSource): Promise<void> {
  const rows = await listTables(resolved.bearer, {
    workspaceId: resolved.target.workspaceId,
    base: resolved.target.base,
    ...(resolved.backend.kind === "hosted" && resolved.backend.binding !== undefined
      ? { binding: resolved.backend.binding }
      : {}),
  }).catch((err: unknown) => {
    throw unreachableListing(err, resolved);
  });
  // The workspace's table route answers an id the credential cannot see with
  // 200 and no rows, so an empty list is checked against the workspaces it
  // reaches before it is reported as an empty workspace.
  if (rows.length === 0 && resolved.kind === "workspace" && resolved.backend.kind === "hosted") {
    const { refuseUnreachableWorkspace } = await import("./workspace-binding.js");
    await refuseUnreachableWorkspace(resolved.backend.auth);
  }
  if (isMachineOutput(args)) {
    // The same document for every kind, with `kind` beside the rows as every
    // machine output that names a backend carries it: a script that reads an
    // ephemeral's guids must not branch on which backend it asked, and a bare
    // command's answer has to say which backend the default resolved to.
    // `env` is an ephemeral's or tenant's server-assigned name; `name` is the
    // backend's own name whatever its kind (that name, or a Xano Engine's), and
    // `display` the display name people call it by — each always present, null
    // where the kind has none, so the keys never depend on the kind. `name` was
    // null for an ephemeral, and nothing carried its display name.
    writeJson({
      // The target's ACTUAL kind: `tenant:<name>` can name an ephemeral.
      kind: actualKind(resolved),
      env: resolved.target.env ?? null,
      name: resolved.backend.kind === "local" ? resolved.backend.engine.name : (resolved.target.env ?? null),
      display: resolved.target.display ?? null,
      tables: rows,
    });
    return;
  }
  if (rows.length === 0) {
    info(`${subjectOf(resolved)} has no tables yet.`);
    return;
  }
  // Which backend this is, on stderr so the table on stdout stays the data:
  // a bare `xanosdk tables` lists whatever the project last deployed to, and
  // the rows alone never said which that was.
  step(`${rows.length} table${rows.length === 1 ? "" : "s"} in ${describeBackend(resolved)}`);
  printHuman(`${formatTableListing(rows)}\n`);
  // `--seed=<guids>`, with the equals: the space form sets a bare `--seed` and
  // leaves the guids to be read as a positional. The registry spells it the same.
  // Not under a Xano Engine's listing: a release is cut on the instance, and
  // `release create` refuses a Xano Engine as its source — the hint would name
  // a command that cannot use these guids.
  if (resolved.backend.kind === "local") return;
  detail(`Pass these guids to \`xanosdk release create <name> --seed=<guids>${contextFlags()}\` to carry their rows.`);
}
