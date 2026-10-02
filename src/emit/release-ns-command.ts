/**
 * `xanosdk release <create|list|show|export|delete|transfer>` — the release
 * object's own surface.
 *
 * A release is the server's durable record of a backend that came up: named,
 * listable, exportable, and landable into a workspace or onto a tenant. This
 * module manages those records. Landing one is `promote` and `tenant deploy`,
 * which are transitions and therefore verbs.
 *
 * `create` lives in `release-create.ts` and `transfer` in `release-transfer.ts`;
 * this module dispatches to both.
 */
import { writeData } from "../util/secrets.js";
import { describeWrite } from "../util/sent-writes.js";
import type { ParsedArgs } from "./cli.js";
import { getAccessToken, type ResolvedAuth } from "../auth/token.js";
import { unknownSubcommand } from "./errors.js";
import { isMachineOutput, writeJson } from "./output.js";
import { resolveOutputTarget, secretsPhrase, writeExportFile } from "./output-target.js";
import { secretsInMultidoc } from "../deploy/live-diff.js";
import { confirm } from "./prompt.js";
import {
  step,
  success,
  warn,
  detail,
  info,
  stdoutStyle,
  safeText,
  printHuman,
  credentialWriteTarget,
  describeWriteTarget,
  discloseWriteTarget,
  writeTargetPayload,
} from "./ui.js";
import {
  listReleases,
  exportRelease,
  deleteRelease,
  type ReleaseSummary,
  type SeededTable,
} from "../deploy/release.js";
import { runReleaseCreate } from "./release-create.js";
import { runReleaseTransfer } from "./release-transfer.js";
import { requireName, releaseOrigin, describeOrigin, lookupRelease, readUnanswered } from "./release-common.js";
import { SourceError } from "./source-resolve.js";
import { contextFlags } from "./context-flags.js";
import { shellWord } from "./command-line.js";
import { normalisationNote, orNamesNoted } from "./name-normalisation.js";

export async function runReleaseCommand(args: ParsedArgs): Promise<void> {
  switch (args.subcommand) {
    case "create":
      return runReleaseCreate(args);
    case "list":
      return runList(args);
    case "show":
      return runShow(args);
    case "export":
      return runExport(args);
    case "delete":
      return runDelete(args);
    case "transfer":
      return runReleaseTransfer(args);
    default:
      throw unknownSubcommand("release", args.subcommand);
  }
}

// ── list / show ─────────────────────────────────────────────────────────────

async function runList(args: ParsedArgs): Promise<void> {
  const auth = await getAccessToken(args);
  // A listing that got no answer exits 8 with this run as the rerun, as `show`
  // does — not 1 with a bare "retry" (E2E pass 22).
  const rows = await listReleases(auth, { workspaceId: auth.workspaceId }).catch((err: unknown) => {
    throw readUnanswered("release", "list releases", "an empty list", err);
  });
  if (isMachineOutput(args)) {
    // An object, as every list verb answers: `{ releases }` beside `tenant
    // list`'s `{ tenants }` and `ephemeral list`'s `{ ephemerals }`. Each row
    // carries `origin` as `show --json` does — the one read of where it came
    // from. Only a release whose record names neither a branch nor a recorded
    // environment reaches the audit log for it.
    const origins = await Promise.all(rows.map((r) => releaseOrigin(auth, r)));
    writeJson({ releases: rows.map((r, i) => ({ ...publicRelease(r), origin: origins[i] ?? null })) });
    return;
  }
  if (rows.length === 0) {
    info(`No releases yet. \`xanosdk release create <name>${contextFlags()}\` cuts one from a running environment.`);
    return;
  }
  const s = stdoutStyle();
  // Where each came from, as `show` and `--json` say it — a bare `-` for an
  // environment cut's empty branch named nothing (E2E pass 19).
  const origins = await Promise.all(rows.map((r) => releaseOrigin(auth, r)));
  for (const [i, r] of rows.entries()) {
    const origin = origins[i];
    const from = origin === undefined ? "from: not recorded" : `from ${describeOrigin(origin)}`;
    printHuman(`${s.bold(safeText(r.name))}  ${from}  ${safeText(r.createdAt ?? "")}\n`);
    // Empty checked explicitly: the server spells "no description" as `""`, and
    // `projectRelease` keeps that rather than folding it to `undefined`, so an
    // undefined-only check would print a blank line under every release without
    // one. Same on the `show` side.
    if (r.description !== undefined && r.description !== "") detail(safeText(oneLine(r.description)));
  }
}

/** How much of a description a `release list` row shows before its ellipsis. */
const LIST_DESCRIPTION_WIDTH = 100;

/**
 * A description as one list line: its first non-blank line, cut at
 * {@link LIST_DESCRIPTION_WIDTH} characters, with an ellipsis whenever anything
 * was left out. A 6000-character description printed whole flooded the
 * terminal; `release show` and `--json` still carry all of it.
 */
export function oneLine(description: string): string {
  const lines = description.split("\n").map((l) => l.trim());
  const first = lines.find((l) => l !== "") ?? "";
  const more = lines.filter((l) => l !== "").length > 1;
  if (first.length > LIST_DESCRIPTION_WIDTH) return `${first.slice(0, LIST_DESCRIPTION_WIDTH).trimEnd()}…`;
  return more ? `${first} …` : first;
}

async function runShow(args: ParsedArgs): Promise<void> {
  const name = requireName(args, "show");
  const auth = await getAccessToken(args);
  const found = await requireRelease(auth, name, contextFlags(args));
  // "Where it came from": the branch for a workspace cut, the environment for
  // one cut from an ephemeral or sandbox (whose record stores no branch).
  const origin = await releaseOrigin(auth, found);
  if (isMachineOutput(args)) {
    writeJson({ ...publicRelease(found), origin: origin ?? null });
    return;
  }
  const s = stdoutStyle();
  printHuman(`${s.bold(safeText(found.name))}\n`);
  detail(`from: ${origin === undefined ? "not recorded" : describeOrigin(origin)}`);
  detail(`created: ${safeText(found.createdAt ?? "-")}`);
  // Line by line: `detail` indents only the first, so a multi-line description
  // printed its continuation lines at column 0, out of the block.
  if (found.description !== undefined && found.description !== "") {
    for (const line of found.description.split("\n")) detail(safeText(line));
  }
  // `rows:`, not `tables:`. This line used to read "tables: none" for a release
  // carrying every table in the workspace — the schema export is unconditional
  // and only the ROWS are selected. Naming the axis is the whole fix.
  detail(
    found.seededTables.length === 0
      ? "rows: none (every table's schema is included)"
      : `rows: ${found.seededTables
          .map((t: SeededTable) => `${safeText(t.name)}${t.count === undefined ? "" : ` (${t.count})`}`)
          .join(", ")}`,
  );
  if (!found.hasResource) {
    warn("Its stored contents are missing — cut it again from a live environment.", "release.contents-missing");
  }
}

/**
 * A release as `--json` prints it: the origin the cut recorded in the
 * description is `show`'s `origin`, not a field of its own — nor is the copied
 * cut's, which the description still carries.
 */
function publicRelease(r: ReleaseSummary): Omit<ReleaseSummary, "recordedOrigin" | "copiedFrom"> {
  const { recordedOrigin: _origin, copiedFrom: _copied, ...rest } = r;
  return rest;
}

/**
 * A release by name, or the refusal that names the list command. No help block:
 * the name was well-formed, and the family's usage lists no release names.
 *
 * A {@link SourceError}, so it exits with the not-found code (8) that `tenant
 * get` and `tables ephemeral:<gone>` give for the same answer — not the usage
 * code, which says the command was mistyped.
 */
async function requireRelease(auth: ResolvedAuth, name: string, flags = ""): Promise<ReleaseSummary> {
  const found = await lookupRelease(auth, name);
  if (found === null) {
    // The closest name the list holds (E2E pass 26), read only on the miss.
    const { releaseNames } = await import("./source-resolve.js");
    const { suggestAll } = await import("../util/suggest.js");
    const near = suggestAll(name, (await releaseNames(auth).catch(() => [])).filter((n) => n !== name));
    throw new SourceError(
      `No release named "${name}". \`xanosdk release list${flags}\` shows the ones that exist.` +
        (near.length === 0 ? "" : `\nDid you mean ${orNamesNoted(name, near)}?`),
      "gone",
      "release",
      near[0],
      near,
    );
  }
  return found;
}

// ── export ──────────────────────────────────────────────────────────────────

async function runExport(args: ParsedArgs): Promise<void> {
  const name = requireName(args, "export");
  // The target first, as `workspace export` does: a name that can never be
  // written is refused before the release is downloaded, not after.
  const target = resolveOutputTarget({ path: args.path, name, ext: "xs" });
  const auth = await getAccessToken(args);
  const found = await requireRelease(auth, name, contextFlags(args));
  if (found.id === undefined) {
    throw new Error(`Release "${name}" carries no id, so it cannot be exported.`);
  }
  // A seeded release's rows are part of what it IS, so they are asked for
  // rather than dropped: without `records` the document is schema and logic only.
  // Only a table that holds rows (E2E pass 28 counted an empty one): the rule
  // `promote` names seeded tables by.
  const seeded = found.seededTables.filter((t) => t.count !== 0);
  const content = await exportRelease(auth, {
    workspaceId: auth.workspaceId,
    id: found.id,
    records: seeded.length > 0,
    name: found.name,
  });
  const rowsLine =
    seeded.length === 0
      ? undefined
      : `Includes the rows of ${seeded.length} seeded table${seeded.length === 1 ? "" : "s"}: ${seeded.map((t) => t.name).join(", ")}`;
  if (target.kind === "stdout") {
    writeData(process.stdout, content + "\n");
    // stderr, so the data channel stays the document alone.
    if (rowsLine !== undefined) detail(rowsLine);
    // A file holding these is written owner-only; stdout has no such protection.
    const secrets = secretsInMultidoc(content);
    if (secrets.length > 0) {
      warn(
        `The export carries ${secretsPhrase(secrets)} in cleartext — written to stdout, where no file ` +
          `permission protects it; do not commit or log it.`,
        "secrets.cleartext-stdout",
      );
    }
    return;
  }
  // A `--path` into a directory that does not exist yet is a place to write,
  // not a failure: it is created, as every other writer of a named file does.
  // Owner-only when the document carries a secret in cleartext — see
  // `secretsInMultidoc`; the engine's rendering is text, not a bundle.
  writeExportFile(target.path, content + "\n", secretsInMultidoc(content));
  // The artifact went to the file, so a machine reader is owed a document naming it.
  if (isMachineOutput(args)) {
    writeJson({ path: target.path, name, seededTables: seeded.map((t) => t.name) });
  }
  // On stderr, so a piped run says it too.
  success(`Wrote ${target.path}`);
  if (rowsLine !== undefined) detail(rowsLine);
}

// ── delete ──────────────────────────────────────────────────────────────────

async function runDelete(args: ParsedArgs): Promise<void> {
  const name = requireName(args, "delete");
  const auth = await getAccessToken(args);
  // Named in every answer, a miss included: "no release named X" is the answer
  // most likely to be WRONG about which backend was asked, and a reader who
  // cannot see the workspace has no way to tell that from a release genuinely
  // absent here. The step line waits for the lookup: "→ Deleting release" above
  // a lookup that found nothing announced a delete that never happened.
  const destination = credentialWriteTarget(auth);
  // A lookup that got no answer says what a delete's reader asks: nothing was deleted.
  const { asDeleteLookupFailure } = await import("./ephemeral-command.js");
  const found = await lookupRelease(auth, name).catch((err: unknown) => {
    throw asDeleteLookupFailure(err);
  });
  if (found === null || found.id === undefined) {
    // With the near names the list holds, each as its delete — never with the
    // `--yes` given for the name typed: a near name is a different release, so
    // its delete asks before it acts.
    const { releaseNames, SourceError } = await import("./source-resolve.js");
    const { suggestAll } = await import("../util/suggest.js");
    const near = suggestAll(name, (await releaseNames(auth).catch(() => [])).filter((n) => n !== name));
    const again = `${args.json === true ? " --json" : ""}${contextFlags(args)}`;
    const missed =
      `No release named "${name}" on ${describeWriteTarget(destination)} — nothing was deleted. ` +
      `\`xanosdk release list${contextFlags(args)}\` shows the ones that exist.`;
    const meant = near.map((n) => `Did you mean "${safeText(n)}"${normalisationNote(name, n)}? \`xanosdk release delete ${shellWord(n)}${again}\` deletes it, after asking to confirm.`);
    // A miss one slip from a live name is most likely that one mistyped: not an
    // idempotent "already gone" — exit 8 with the suggestion, as `ephemeral
    // delete` and `tenant delete` answer it.
    if (near.length > 0) {
      throw new SourceError([missed, ...meant].join("\n"), "gone", "release", near[0], near.length > 1 ? near : undefined);
    }
    // Only what is known: it may never have existed, so not "already gone".
    // Still the idempotent outcome (exit 0, `alreadyGone`) a retried cleanup expects.
    warn(missed, "release.not-found");
    if (isMachineOutput(args)) {
      writeJson({
        verb: "delete",
        destination: writeTargetPayload(destination),
        name,
        deleted: false,
        alreadyGone: true,
        declined: false,
      });
    }
    return;
  }
  // Off a terminal without `--yes` the confirmation refuses: the headline says what it WOULD delete.
  const refusing = args.yes !== true && process.stdin.isTTY !== true;
  step(`${refusing ? "Would delete" : "Deleting"} release "${name}"`);
  discloseWriteTarget(destination);

  // What runs it, named before the question: once it is gone nothing can land
  // it again, and a deploy there that stops partway has no release to put back.
  const runners = await releaseRunners(auth, { id: found.id, name: found.name });
  const runBy = runners.tenants.length + runners.branches.length === 0 ? undefined : runners;
  const runningIt = runBy === undefined ? undefined : describeRunners(runBy);
  if (runningIt !== undefined) {
    warn(
      `Release "${name}" is in use: ${runningIt}. Deleting it leaves what runs it running, but it can no longer be ` +
        `landed again — nor put back after a deploy there stops partway.`,
      "release.delete-in-use",
    );
  }

  if (!args.yes) {
    const ok = await confirm(
      runningIt === undefined
        ? `Delete release "${name}"? Anything running it keeps running; the record goes.`
        : `Delete release "${name}"? ${runningIt.charAt(0).toUpperCase()}${runningIt.slice(1)} — it keeps running there; the record goes.`,
      {
        flag: "--yes",
        // Off a terminal, the details `tenant delete` carries, and this delete with `--yes`.
        refusal: {
          details: { verb: "delete", name, deleted: false, alreadyGone: false, declined: false, ...(runBy === undefined ? {} : { runBy }) },
          rerun: `xanosdk release delete ${shellWord(name)} --yes${args.json === true ? " --json" : ""}${contextFlags(args)}`,
        },
      },
    );
    if (!ok) {
      info("Deletion cancelled — nothing was deleted.");
      // A decline answers `--json` too, rather than leaving stdout empty.
      if (isMachineOutput(args)) {
        writeJson({
          verb: "delete",
          destination: writeTargetPayload(destination),
          name,
          deleted: false,
          alreadyGone: false,
          declined: true,
          ...(runBy === undefined ? {} : { runBy }),
        });
      }
      return;
    }
  }

  // Said as the delete it was: a connection that never opened deleted nothing
  // (exit 1); one dropped after the request went may have (exit 9, with the check).
  const id = found.id;
  const { alreadyGone } = await describeWrite(
    { what: `the delete of release "${name}"`, resolveWith: `xanosdk release show ${shellWord(name)}${contextFlags(args)}` },
    () => deleteRelease(auth, { workspaceId: auth.workspaceId, id }),
  ).catch(async (err: unknown) => {
    const { writeTransportFailure } = await import("../deploy/answer-shape.js");
    const { unknownDeleteOutcome } = await import("./ephemeral-command.js");
    throw unknownDeleteOutcome(writeTransportFailure(err), `release "${name}"`, name, contextFlags(args), "release");
  });
  if (alreadyGone) warn(`Release "${name}" was already gone.`, "release.already-gone");
  else success(`Deleted release ${name}`);
  // Every delete document carries `verb` and `destination`: here the workspace
  // the release record lives in.
  if (isMachineOutput(args)) {
    writeJson({
      verb: "delete",
      destination: writeTargetPayload(destination),
      name,
      deleted: !alreadyGone,
      alreadyGone,
      declined: false,
      ...(runBy === undefined ? {} : { runBy }),
    });
  }
}

/** What runs a release here: tenants whose last landing it is, and branches a promote of it landed. */
interface ReleaseRunners {
  tenants: Array<{ name: string; kind: "tenant" | "ephemeral" }>;
  branches: string[];
}

/**
 * The tenants and ephemerals whose last landed release is `release`, and the
 * branches a promote of it landed (by their derived label). Best effort: a
 * listing that cannot be read names nothing from it.
 */
async function releaseRunners(auth: ResolvedAuth, release: { id: number; name: string }): Promise<ReleaseRunners> {
  const { listTenants } = await import("../deploy/tenant.js");
  const { listEphemeral } = await import("../deploy/ephemeral.js");
  const { listBranchListing } = await import("../deploy/branch.js");
  const { isDerivedPromoteLabel } = await import("./promote-command.js");
  // Ephemerals are not in the tenant list (E2E pass 36): their own list
  // carries the release each last landed.
  const [tenants, ephemerals, listing] = await Promise.all([
    listTenants(auth, { workspaceId: auth.workspaceId }).catch(() => []),
    listEphemeral(auth, { parentWorkspaceId: auth.workspaceId }).catch(() => []),
    listBranchListing(auth, { baseUrl: auth.instance, workspaceId: auth.workspaceId }).catch(() => undefined),
  ]);
  const runners = new Map<string, "tenant" | "ephemeral">();
  for (const t of [...tenants, ...ephemerals]) {
    if (t.deployedReleaseId === release.id && !runners.has(t.name)) runners.set(t.name, t.type === "ephemeral" ? "ephemeral" : "tenant");
  }
  // An ephemeral a `deploy release:<name>` filled carries no release id: the
  // archive was imported into it. This project's record of it names the release.
  const { getEnvironment, readEphemeralState } = await import("../deploy/ephemeral-state.js");
  const { projectDirFrom } = await import("./xanosdk-project.js");
  const dir = projectDirFrom(process.cwd());
  const tracked = dir === undefined ? undefined : getEnvironment(readEphemeralState(dir), auth);
  if (tracked?.release === release.name && ephemerals.some((e) => e.name === tracked.name)) runners.set(tracked.name, "ephemeral");
  return {
    tenants: [...runners].map(([name, kind]) => ({ name, kind })),
    branches: (listing?.branches ?? []).filter((b) => isDerivedPromoteLabel(b.label, release.name)).map((b) => b.label),
  };
}

/** `it is the last release landed on tenant "a"; a promote of it landed branch "b"` — the runners, named. */
function describeRunners(r: ReleaseRunners): string {
  const list = (named: string[]): string =>
    named.length === 1 ? named[0]! : `${named.slice(0, -1).join(", ")} and ${named.at(-1)!}`;
  return [
    ...(r.tenants.length === 0 ? [] : [`it is the last release landed on ${list(r.tenants.map((t) => `${t.kind} "${t.name}"`))}`]),
    ...(r.branches.length === 0 ? [] : [`a promote of it landed ${list(r.branches.map((b) => `branch "${b}"`))}`]),
  ].join("; ");
}
