/**
 * `xanosdk workspace branch <list|set-live|delete> [label]` — read the branches
 * of your instance workspace, promote one, or remove one.
 *
 * The companions to `deploy --to … --branch` and `deploy --to … --backup-branch`: those two
 * put content ON a branch, and these are how you look at what is there, make it
 * live, or clean up afterwards. Without them a staged release has no promote
 * step and a backup branch has no rollback step, which would make both flags
 * one-way doors.
 *
 * There is deliberately no `create` verb. A branch worth having is one a release
 * put something on, and an empty branch created here would only be a way to
 * collide with a later `--branch` label.
 *
 * The workspace comes strictly from the credential, exactly as `release` does —
 * there is no `--workspace` override anywhere in the SDK.
 *
 * Node-only and lazily imported so the browser-safe authoring bundle stays clean.
 */
import { assertOneName } from "./name-argument.js";
import { describeWrite } from "../util/sent-writes.js";
import type { ParsedArgs } from "./cli.js";
import { contextFlags } from "./context-flags.js";
import { pipedYes } from "./retry-command.js";
import { shellWord } from "./command-line.js";
import { exportWorkspaceBundle } from "../deploy/workspace-export.js";
import { sectionKind } from "../deploy/live-diff.js";
import { suggestAll } from "../util/suggest.js";
import { getAccessToken } from "../auth/token.js";
import {
  DEFAULT_BRANCH_LABEL,
  deleteBranch,
  findBranch,
  listBranchListing,
  liveBranchLabel,
  requireBranch,
  setLiveBranch,
  type BranchListing,
  type BranchRecord,
  type UnaddressableBranch,
} from "../deploy/branch.js";
import { CliError, UsageError, suggestVerb } from "./errors.js";
import {
  blank,
  detail,
  describeWriteTarget,
  discloseWriteTarget,
  info,
  step,
  success,
  warn,
  writeTargetPayload,
  credentialWriteTarget,
  safeText,
  type WriteTarget,
} from "./ui.js";
import { confirm } from "./prompt.js";
import { discloseCanonicalMoves, movesClause, releaseCanonicalMoves } from "./plan-disclosure.js";
import { isMachineOutput, writeJson } from "./output.js";

/** The verbs this command answers to. `create` is absent by design — see the module header. */
const VERBS = ["list", "set-live", "delete"] as const;
type Verb = (typeof VERBS)[number];

function assertVerb(verb: string | undefined): Verb {
  if (verb !== undefined && (VERBS as readonly string[]).includes(verb)) return verb as Verb;
  throw new UsageError(
    verb === undefined
      ? `\`xanosdk workspace branch\` needs a verb: ${VERBS.join(", ")}.`
      : `\`xanosdk workspace branch ${verb}\` is not a verb. Expected one of: ${VERBS.join(", ")}.`,
    {
      helpFor: { command: "workspace", subcommand: "branch" },
      ...(verb === undefined ? {} : { suggestion: suggestVerb(verb, VERBS) }),
    },
  );
}

/** A label the verb requires, refused by name rather than by arity. */
function requireLabel(label: string | undefined, verb: Verb): string {
  if (label !== undefined && label.trim() !== "") return label;
  throw new UsageError(`\`xanosdk workspace branch ${verb}\` needs a branch label.`, {
    helpFor: { command: "workspace", subcommand: "branch" },
  });
}

/**
 * A label as a list prints it: quoted when whitespace would otherwise hide
 * what it is — a stored `"  x  "` printed bare reads as `x`.
 */
export function shownLabel(label: string): string {
  return safeText(/\s/.test(label) ? JSON.stringify(label) : label);
}

/**
 * Branches the engine reports with no label.
 *
 * Reported here rather than dropped because this listing is the only place
 * anyone would ever find one, and there is nothing the CLI can do about it: a
 * branch is addressed by label, and these have none.
 */
function renderUnaddressable(rows: readonly UnaddressableBranch[]): void {
  if (rows.length === 0) return;
  blank();
  warn(
    `${rows.length} branch${rows.length === 1 ? "" : "es"} here carr${rows.length === 1 ? "ies" : "y"} no label:`,
    "branch.unlabeled",
    [
      ...rows.map((r) => {
        const tags = [r.live ? "LIVE" : "", r.backup ? "backup" : ""].filter(Boolean).join(", ");
        return `(unnamed, created ${r.createdAt ?? "at an unknown time"})${tags === "" ? "" : `  (${tags})`}`;
      }),
      "Every branch route addresses a branch by label, so these cannot be",
      "selected, made live, or deleted from here — remove one in the Xano dashboard.",
    ],
  );
}

/** Render the list, marking the live branch — the one fact a reader is here for. */
function renderList(
  branches: readonly BranchRecord[],
  unaddressable: readonly UnaddressableBranch[],
  workspaceId: number,
): void {
  blank();
  step(`Branches in workspace #${workspaceId}`);
  if (branches.length === 0 && unaddressable.length === 0) {
    detail("none reported");
    return;
  }
  for (const b of branches) {
    const tags = [b.live ? "live" : "", b.backup ? "backup" : ""].filter(Boolean).join(", ");
    detail(`${shownLabel(b.label)}${tags === "" ? "" : `  (${tags})`}`);
  }
  renderUnaddressable(unaddressable);
  blank();
  // Said once, here, because this listing is where someone decides what to
  // promote — and the thing a branch does NOT isolate is the thing that will
  // surprise them.
  detail("Branches scope logic. Tables and microservices are shared by every branch.");
}

export async function runBranchCommand(args: ParsedArgs): Promise<void> {
  const verb = assertVerb(args.positionals[0]);
  // The parser caps this family at `<verb> [label]`, which let `branch list
  // staging` list every branch with the word dropped.
  if (verb === "list" && args.positionals.length > 1) {
    throw new UsageError(
      `\`xanosdk workspace branch list\` takes no argument, and was also given \`${args.positionals[1]}\`.`,
      { hintFor: { command: "workspace", subcommand: "branch" } },
    );
  }
  // Only set-live switches live; on `list` or `delete` the guard would guard nothing.
  if (args.expectLive !== undefined && verb !== "set-live") {
    throw new UsageError(
      `\`--expect-live\` guards a switch of the live branch, and \`xanosdk workspace branch ${verb}\` makes none. ` +
        `It belongs to \`xanosdk workspace branch set-live <branch> --expect-live <label>\`; drop it here.`,
      { hintFor: { command: "workspace", subcommand: "branch" } },
    );
  }
  const typedLabel = args.positionals[1];
  if (typedLabel !== undefined) assertOneName(typedLabel, "the branch label", { args, helpFor: { command: "workspace", subcommand: "branch" } });
  // The default branch is every workspace's root: the platform refuses to
  // delete it, so the outcome is known before anything is sent.
  if (verb === "delete" && typedLabel?.trim() === DEFAULT_BRANCH_LABEL) {
    throw new UsageError(
      `Branch "${DEFAULT_BRANCH_LABEL}" is the workspace's default branch, which cannot be deleted. Nothing was sent.`,
      { hintFor: { command: "workspace", subcommand: "branch" } },
    );
  }
  const auth = await getAccessToken(args);
  const workspaceId = auth.workspaceId;
  const target = { baseUrl: auth.instance, workspaceId };

  // A list that got no answer exits 8 with this run as the rerun, as every
  // other read does; a delete or set-live has changed nothing yet.
  const { branches, unaddressable } = await listBranchListing(auth, target).catch(async (err: unknown) => {
    const { unansweredRead } = await import("./source-resolve.js");
    throw unansweredRead(err, `list the branches of workspace ${workspaceId}`, "workspace");
  });

  if (verb === "list") {
    if (isMachineOutput(args)) {
      // Always present, empty for a healthy workspace, so a script can check the
      // key rather than having to know it might be missing.
      writeJson({ workspaceId, instance: auth.instance, branches, unaddressable });
      return;
    }
    renderList(branches, unaddressable, workspaceId);
    return;
  }

  const typed = requireLabel(args.positionals[1], verb);

  // A delete of a label that is not there is the idempotent outcome every
  // delete gives (`release delete`, `tenant delete`, `ephemeral delete`):
  // nothing by that name, exit 0 with `alreadyGone: true`, as a retried cleanup
  // expects — whether it was deleted earlier or never existed, which nothing
  // here can tell apart. A label one slip from an existing branch is most
  // likely that one mistyped, and is answered as those deletes answer it: exit
  // 8 with the suggestion, nothing deleted. "Not there" is decided by
  // `findBranch`, the same match the other verbs resolve through: a branch
  // stored with padding (`"  x "`) IS there for a `delete x`, and answering
  // "already gone" while it kept existing is how a cleanup step passed without
  // cleaning anything. No step line: nothing is being deleted.
  if (verb === "delete" && findBranch(branches, typed) === undefined) {
    const label = typed;
    const destination: WriteTarget = credentialWriteTarget({ instance: auth.instance, workspaceId });
    const known = branches.map((b) => shownLabel(b.label)).join(", ");
    // Each near label as its own delete — without this run's `--yes`: a near
    // label is a different branch, so its delete asks before it acts. Neither
    // the live branch nor the default one is offered: neither can be deleted.
    const near = suggestAll(label.trim(), branches.filter((b) => !b.live && b.label.trim() !== DEFAULT_BRANCH_LABEL).map((b) => b.label));
    const again = `${args.json === true ? " --json" : ""}${contextFlags(args)}`;
    const missed = `No branch named "${label}" on ${describeWriteTarget(destination)} — nothing was deleted.`;
    const meant = near.map((n) => `Did you mean "${safeText(n)}"? \`xanosdk workspace branch delete ${shellWord(n)}${again}\` deletes it, after asking to confirm.`);
    const branchesLine = known !== "" ? [`Its branches: ${known}.`] : [];
    if (near.length > 0) {
      const { SourceError } = await import("./source-resolve.js");
      throw new SourceError([missed, ...meant, ...branchesLine].join("\n"), "gone", "workspace", near[0], near.length > 1 ? near : undefined);
    }
    warn(missed, "branch.not-found", branchesLine);
    if (isMachineOutput(args)) {
      writeJson({
        verb: "delete",
        destination: writeTargetPayload(destination),
        workspaceId,
        branch: label,
        deleted: false,
        alreadyGone: true,
        declined: false,
      });
    }
    return;
  }

  // Resolve against the list already fetched: a typo is the likeliest failure
  // here, and the fix is almost always visible in the labels that DO exist.
  const branch = requireBranch(branches, typed);
  // The label AS STORED — what every route below has to be sent, and what the
  // output names — whichever spelling of it was typed.
  const label = branch.label;

  // A state conflict, not a mistyped command: exit 2 with the live branch under
  // `details.conflictsWith`, as a taken label or an unmet `--expect-live` is.
  // Before the headline: a refusal deletes nothing, so nothing says "Deleting".
  if (verb === "delete" && branch.live) {
    throw new CliError(
      "SDK_BRANCH_LIVE",
      `Branch "${label}" is the LIVE branch of workspace #${workspaceId} and cannot be deleted.\n` +
        `Promote another branch first (\`xanosdk workspace branch set-live <other>${pipedYes(args)}${contextFlags()}\`), then delete this one.`,
      { exitCode: 2, details: { conflictsWith: { live: label } } },
    );
  }

  // Past `list`, every verb here writes. The workspace number was already in
  // every line below, and on its own it is not a destination: workspace 7 is a
  // different production on every instance someone has a credential for. Said
  // once, ahead of the cutover warning and the confirmation that reads it, so a
  // mistargeted rollback is visible while it can still be declined — and after
  // the label checks, so a typo is answered with the typo rather than with a
  // destination nothing was going to be sent to.
  const destination: WriteTarget = credentialWriteTarget({ instance: auth.instance, workspaceId });
  // The headline first: an indented "on …" line with nothing above it read as
  // the tail of whatever the terminal printed before. Off a terminal without
  // `--yes` the delete's confirmation refuses, so it says what it WOULD delete.
  const refusing = verb === "delete" && args.yes !== true && process.stdin.isTTY !== true;
  step(
    verb === "set-live"
      ? `Making branch ${shownLabel(label)} live`
      : `${refusing ? "Would delete" : "Deleting"} branch ${shownLabel(label)}`,
  );
  discloseWriteTarget(destination);

  if (verb === "set-live") {
    // Checked against the listing already read, before anything is said or
    // asked: an unmet precondition is a conflict (exit 2), as on a promote.
    if (args.expectLive !== undefined) {
      const mismatch = liveMismatch({ branches, unaddressable }, args.expectLive);
      if (mismatch !== undefined) {
        throw liveBranchMismatch(
          `\`--expect-live ${args.expectLive}\` does not hold: ${mismatch.why}. Nothing was switched.\n` +
            `Check what is serving with \`xanosdk workspace branch list${contextFlags()}\`, then run set-live again.`,
          mismatch.live,
        );
      }
    }
    if (branch.live) {
      success(`Branch "${label}" is already live in workspace #${workspaceId} — nothing to do.`);
      if (isMachineOutput(args)) {
        writeJson({
          verb: "set-live",
          destination: writeTargetPayload(destination),
          workspaceId,
          branch: label,
          setLive: false,
          alreadyLive: true,
          declined: false,
        });
      }
      return;
    }

    const outgoing = branches.find((b) => b.live)?.label;
    blank();
    // "Cutover" promises something stops being served. With nothing live,
    // nothing does — the warning still stands, because this is what puts the
    // branch in front of traffic, but it says what is actually happening.
    if (outgoing !== undefined) {
      warn(
        `This is a production cutover for workspace #${workspaceId}.`,
        "branch.production-cutover",
        [`The runtime stops serving "${outgoing}" and starts serving "${label}".`],
      );
    } else {
      warn(`No branch is live in workspace #${workspaceId} — "${label}" becomes the branch the runtime serves.`, "branch.none-live");
    }
    detail("Table data is unaffected — it is shared by every branch either way.");
    // Tables are shared and logic is not: a branch landed before a release
    // dropped a column still writes it, and the write stores nothing (E2E pass
    // 37: POST with sku → 200, no sku). Best effort — a failed read says nothing.
    const readBranch = (name: string): Promise<unknown> =>
      exportWorkspaceBundle(auth, {
        base: auth.instance,
        workspaceId,
        label: `reading branch ${shownLabel(name)}`,
        branch: name,
        safeErrors: true,
      }).catch(() => undefined);
    const [incoming, served] = await Promise.all([
      readBranch(label),
      outgoing === undefined ? Promise.resolve(undefined) : readBranch(outgoing),
    ]);
    const stale = incoming === undefined ? [] : staleSchemaRefs(incoming);
    if (stale.length > 0) {
      warn(
        `"${label}"'s logic writes ${stale.length === 1 ? "a column" : `${stale.length} columns`} the shared tables ` +
          `no longer have — once it is live, ${stale.length === 1 ? "that write stores" : "those writes store"} nothing there:`,
        "branch.stale-schema-refs",
        stale,
      );
    }
    // A public URL slug belongs to the branch: an api group the incoming
    // branch serves under another canonical moves the moment it is live, and
    // every endpoint under the old slug stops answering. Best effort, as above.
    const moves = incoming === undefined || served === undefined ? [] : releaseCanonicalMoves(incoming, served);
    discloseCanonicalMoves(moves, { subject: "the set-live", when: "as it goes live" });
    blank();

    if (!args.yes) {
      const ok = await confirm(`Make "${label}" the live branch?${movesClause(moves)}`, {
        flag: "--yes",
        refusal: {
          details: { verb: "set-live", branch: label, setLive: false, alreadyLive: false, declined: false },
          rerun: branchRerun(args, "set-live", label),
        },
      });
      if (!ok) {
        info("Set-live cancelled — nothing was switched; the live branch is unchanged.");
        // A decline answers `--json` too, rather than leaving stdout empty.
        if (isMachineOutput(args)) {
          writeJson({
            verb: "set-live",
            destination: writeTargetPayload(destination),
            workspaceId,
            branch: label,
            setLive: false,
            alreadyLive: false,
            declined: true,
          });
        }
        return;
      }
    }

    if (args.expectLive !== undefined) {
      // Re-read as the last thing before the switch: the first read came before
      // the branch reads and the confirmation. It narrows the window; nothing on
      // the server makes a check and a switch one step.
      const now = await listBranchListing(auth, target).catch(async (err: unknown) => {
        const { unansweredRead } = await import("./source-resolve.js");
        throw unansweredRead(err, `list the branches of workspace ${workspaceId}`, "workspace");
      });
      const drift = liveMismatch(now, args.expectLive);
      if (drift !== undefined) {
        throw liveBranchMismatch(
          `\`--expect-live ${args.expectLive}\` no longer holds — ${drift.why}. Live changed while this ran; the check ` +
            `is not atomic, so it is re-read before switching and the switch refused. Nothing was switched.\n` +
            `Check what is serving with \`xanosdk workspace branch list${contextFlags()}\`, then run set-live again.`,
          drift.live,
        );
      }
    }
    await describeWrite(
      { what: `the switch of the live branch to "${label}"`, resolveWith: `xanosdk workspace branch list${contextFlags()}` },
      () => setLiveBranch(auth, { ...target, label }),
    );
    success(`Branch "${label}" is now live in workspace #${workspaceId}.`);
    if (outgoing !== undefined) {
      detail(`Roll back with \`xanosdk workspace branch set-live ${outgoing}${pipedYes(args)}${contextFlags()}\`.`);
    }
    if (isMachineOutput(args)) {
      writeJson({
        verb: "set-live",
        destination: writeTargetPayload(destination),
        workspaceId,
        branch: label,
        setLive: true,
        alreadyLive: false,
        previousBranch: outgoing,
        canonicalMoves: moves,
        declined: false,
      });
    }
    return;
  }

  if (!args.yes) {
    const ok = await confirm(`Delete branch "${label}" from workspace #${workspaceId}?`, {
      flag: "--yes",
      refusal: {
        details: { verb: "delete", branch: label, deleted: false, alreadyGone: false, declined: false },
        rerun: branchRerun(args, "delete", label),
      },
    });
    if (!ok) {
      info("Deletion cancelled — nothing was deleted.");
      if (isMachineOutput(args)) {
        writeJson({
          verb: "delete",
          destination: writeTargetPayload(destination),
          workspaceId,
          branch: label,
          deleted: false,
          alreadyGone: false,
          declined: true,
        });
      }
      return;
    }
  }

  await describeWrite(
    { what: `the delete of branch "${label}"`, resolveWith: `xanosdk workspace branch list${contextFlags()}` },
    () => deleteBranch(auth, { ...target, label }),
  );
  success(`Deleted branch "${label}" from workspace #${workspaceId}.`);
  if (isMachineOutput(args)) {
    writeJson({
      verb: "delete",
      destination: writeTargetPayload(destination),
      workspaceId,
      branch: label,
      deleted: true,
      alreadyGone: false,
      declined: false,
    });
  }
}

/**
 * Why the live branch is not the one `--expect-live` named, or `undefined` when
 * it is.
 *
 * An unlabelled live branch is said as such. The listing drops rows with no
 * label, so reading only the named ones would report "no branch is live" for a
 * workspace that very much has one — the wrong story for the one reader who is
 * about to decide whether it is safe to switch.
 */
export function liveMismatch(listing: BranchListing, expected: string): { why: string; live: string | null } | undefined {
  const live = liveBranchLabel(listing.branches);
  if (live === expected) return undefined;
  if (live !== undefined) return { why: `"${live}" is live, not "${expected}"`, live };
  if (listing.unaddressable.some((b) => b.live)) {
    return { why: `the live branch has no label, so it cannot be "${expected}"`, live: null };
  }
  return { why: `no branch reports as live, so "${expected}" is not`, live: null };
}

/**
 * `--expect-live` named a branch that is not live. A conflict, as a taken
 * branch label is: exit 2, `SDK_LIVE_BRANCH_MISMATCH`, and what IS live under
 * `details.conflictsWith.live` (`null` when no labelled branch is) — re-running
 * the same command changes nothing, and a script branches on the code.
 */
export function liveBranchMismatch(message: string, live: string | null): CliError {
  return new CliError("SDK_LIVE_BRANCH_MISMATCH", message, { details: { conflictsWith: { live } }, exitCode: 2 });
}

/** This branch verb with `--yes`, as the needs-confirmation refusal's literal rerun. */
function branchRerun(args: ParsedArgs, verb: "set-live" | "delete", label: string): string {
  const expect = verb === "set-live" && args.expectLive !== undefined ? ` --expect-live ${shellWord(args.expectLive)}` : "";
  return `xanosdk workspace branch ${verb} ${shellWord(label)}${expect} --yes${args.json === true ? " --json" : ""}${contextFlags(args)}`;
}

/** The statements that write a row's fields, by the names a workspace export gives them. */
const ROW_WRITES = /^mvp:dbo_(?:add|edit|add_or_edit|patch)$/;

/**
 * The columns a workspace export's logic writes that its tables do not have,
 * as `table.column (where)` — what a branch landed before a release dropped a
 * column still writes. A table the export no longer has is named by the
 * identity the statement holds.
 */
export function staleSchemaRefs(bundle: unknown): string[] {
  const payload = (bundle as { payload?: unknown } | null)?.payload;
  if (payload === null || typeof payload !== "object") return [];
  const sections = payload as Record<string, unknown>;
  const tables = new Map<string, { name: string; columns: Set<string> }>();
  for (const t of Array.isArray(sections.dbo) ? (sections.dbo as Record<string, unknown>[]) : []) {
    if (typeof t?.guid !== "string") continue;
    const schema = Array.isArray(t.schema) ? (t.schema as { name?: unknown }[]) : [];
    tables.set(t.guid, {
      name: typeof t.name === "string" ? t.name : t.guid,
      columns: new Set(schema.map((c) => c?.name).filter((n): n is string => typeof n === "string")),
    });
  }
  const out = new Set<string>();
  const walk = (node: unknown, where: string): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, where);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const stmt = node as Record<string, unknown>;
    const ref = (stmt.context as { dbo?: { id?: unknown } } | undefined)?.dbo?.id;
    if (typeof stmt.name === "string" && ROW_WRITES.test(stmt.name) && typeof ref === "string" && Array.isArray(stmt.input)) {
      const table = tables.get(ref);
      for (const field of stmt.input as { name?: unknown; ignore?: unknown }[]) {
        if (typeof field?.name !== "string" || field.ignore === true) continue;
        if (table === undefined) out.add(`a table no longer there (${ref}).${field.name}${where}`);
        else if (!table.columns.has(field.name)) out.add(`${table.name}.${field.name}${where}`);
      }
    }
    for (const value of Object.values(stmt)) walk(value, where);
  };
  for (const [section, rows] of Object.entries(sections)) {
    if (section === "dbo" || !Array.isArray(rows)) continue;
    for (const row of rows as Record<string, unknown>[]) {
      if (row === null || typeof row !== "object") continue;
      const name = typeof row.name === "string" ? row.name : "";
      const verb = typeof row.verb === "string" ? `${row.verb} ` : "";
      walk(row, ` (${sectionKind(section, row)} ${verb}${name})`);
    }
  }
  return [...out];
}
