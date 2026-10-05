/**
 * `xanosdk ephemeral <list|get|delete|export>` — manage the ephemeral
 * environments `xanosdk deploy` creates. Mirrors the `workspace` read surface
 * (`get` ≈ `workspace details`, `export` ≈ `workspace export`) and reuses the same
 * `resolveOutputTarget`/`formatFields`/`formatExpiration` primitives so the two
 * families render consistently.
 *
 * Expired/gone handling is the crux: `get`, `export`, and `delete` resolve the
 * tenant through the parent meta-API FIRST — that both yields the base URL (for
 * a json export) and is the existence gate. A 404 (swept by the server) or a
 * past `ephemeral_expires_at` is surfaced as one actionable message ("expired or
 * no longer exists — run `xanosdk deploy`"), the dead env's base URL is never
 * touched, and a matching local `.xano/ephemeral.json` record is cleared so the
 * next deploy starts clean.
 *
 * Node-only (fetch/fs + OAuth) and lazily imported by the CLI so the browser-safe
 * authoring bundle never pulls it in.
 */
import { writeData } from "../util/secrets.js";
import { assertOneName } from "./name-argument.js";
import { describeWrite } from "../util/sent-writes.js";
import { basename, join, sep } from "node:path";
import { projectDirFrom } from "./xanosdk-project.js";
import { secretsCarriedBy, secretsInMultidoc } from "../deploy/live-diff.js";
import type { ParsedArgs } from "./cli.js";
import { getAccessToken, type ResolvedAuth } from "../auth/token.js";
import {
  getEphemeral,
  listEphemeral,
  listAllEphemeral,
  deleteEphemeral,
  isExpired,
  namedEphemeral,
  type EphemeralSummary,
} from "../deploy/ephemeral.js";
import { isMachineOutput, writeJson } from "./output.js";
import {
  readEphemeralState,
  getEnvironment,
  clearEnvironment,
  clearEnvironmentsNamed,
  clearEphemeralLanding,
} from "../deploy/ephemeral-state.js";
import { exportWorkspaceBundle, type ExportedBundle } from "../deploy/workspace-export.js";
import { resolveOutputTarget, secretsPhrase, writeExportFile, type OutputTarget } from "./output-target.js";
import { printMicroserviceSection, readMicroservices } from "./microservice-view.js";
import { success, warn, info, step, discloseWriteTarget, formatFields, formatExpiration, stdoutStyle, writeTargetPayload, safeText, printHuman } from "./ui.js";
import { confirm } from "./prompt.js";
import { UsageError, unknownSubcommand } from "./errors.js";
import { LookupFailedError, SourceError, isServerError, isUnansweredLookup, lookupFailed, unansweredCause, type Liveness } from "./source-resolve.js";
import { readUnanswered } from "./release-common.js";
import { isBackendHandle, verbBackendName } from "./source-selector.js";
import { displayNameHint, displayNameOwner, isShared, nearBackendLines, nearBackendName, sharedDisplayHint, type DisplayOwner, type NearBackend } from "./display-name-hint.js";
import { TransportError, fetchReadOrExplain, httpFailureError } from "../util/http.js";
import { contextFlags } from "./context-flags.js";
import { heldElsewhereError, refuseUnreachableWorkspace, whereaboutsOf, type Whereabouts } from "./workspace-binding.js";
import { multidocAnswer } from "../deploy/answer-shape.js";
import { shellQuote } from "../util/shell-quote.js";

const TIMEOUT_MS = 120_000;

/**
 * The clear, actionable message for an ephemeral that has expired or been swept.
 *
 * A `SourceError`, so it exits 8 — "a named backend could not be addressed" —
 * like every other verb that names a gone ephemeral (`tables`, `env set`,
 * `impersonate`, `deploy ephemeral:<name>`). A plain error exited 1 here, and a
 * CI wrapper retrying on 8 read the same condition two ways.
 */
function goneError(name: string, clearedState: boolean, liveness: Liveness = "gone", flags = ""): Error {
  const tail = clearedState ? " (cleared its local record)" : "";
  return new SourceError(
    `Ephemeral "${name}" has expired or no longer exists. Run \`xanosdk deploy --ephemeral${flags}\` to create a fresh one.${tail}`,
    liveness,
    "ephemeral",
  );
}

/**
 * Resolve a tenant for a read/export/delete verb, enforcing the gone/expired
 * gate. Returns the live summary, or throws the actionable message after clearing
 * any matching local record. Never touches the env base URL for a dead tenant.
 */
export async function resolveLive(
  auth: ResolvedAuth,
  parentWorkspaceId: number,
  name: string,
  /** This run's credential flags, for the printed remedies (see `contextFlags`). */
  flags = "",
  /** The verb a near name's remedy re-runs. */
  verb: "get" | "export" = "get",
  /** This run's own verb flags (`--path -`), kept on the re-run that names the ephemeral meant. */
  verbFlags = "",
): Promise<EphemeralSummary> {
  const summary = await lookup(auth, parentWorkspaceId, name);
  if (summary === null || isExpired(summary.expiresAt)) {
    // A display name is the likeliest miss: `ephemeral list` shows both, and
    // only the name addresses one. When it is one, nothing expired — so the
    // headline says no ephemeral is NAMED that, and "run deploy" is no advice.
    const owner = summary === null ? await displayNameOwner(auth, "ephemeral", name) : undefined;
    if (owner !== undefined) throw displayNameError(name, owner, "", (n) => `xanosdk ephemeral ${verb} ${shellQuote(n)}${verbFlags}${flags}`);
    // Found expired: this workspace's own answer. Not found: only once that
    // miss is confirmed (see `clearMissedRecord`).
    const cleared =
      summary === null
        ? await clearMissedRecord(auth, name, (where) =>
            heldElsewhereError(auth, where, name, "no local record was cleared", `xanosdk ephemeral ${verb} ${shellQuote(name)}${verbFlags}${flags}`, {
              verb,
              name,
            }),
          )
        : clearStaleRecord(auth, name);
    // "Expired" only where that is known: the platform said so, or this
    // project recorded the name, so it existed. A name nothing has heard of is
    // answered as one — the way a display name is.
    const err = summary === null && !cleared ? unknownError(name, flags) : goneError(name, cleared, summary === null ? "gone" : "expired", flags);
    // A typo of a live one's name or display name (E2E pass 27: the selector
    // form suggested, the verbs did not) — the same near-name read.
    const near = summary === null ? await nearEphemeral(auth, name) : undefined;
    if (near === undefined) throw err;
    throw new SourceError(
      `${err.message}${nearBackendLines(near, (n) => `\`xanosdk ephemeral ${verb} ${shellQuote(n)}${verbFlags}${flags}\`.`)}`,
      err instanceof SourceError ? err.liveness : "gone",
      "ephemeral",
      near.name,
      near.names,
    );
  }
  return summary;
}

/** The live ephemeral whose name or display name is one typo from `name`; read only on a miss. */
async function nearEphemeral(auth: ResolvedAuth, name: string): Promise<NearBackend | undefined> {
  return nearBackendName(auth, ["ephemeral"], name).catch(() => undefined);
}

/**
 * {@link nearBackendName} for a delete. A handle-shaped miss with no near name
 * is an exit-0 "nothing was deleted", so for one the list must be READ for
 * that to be true (any other miss exits 8 whatever the list holds). One that
 * got no answer is the delete's lookup failure (exit 8, the rerun
 * named); any other refusal passes through — under a workspace id the
 * credential cannot see, the CLI turns it into the usage error naming the ids
 * that work. Shared by `ephemeral delete` and `tenant delete`.
 */
export async function nearForDelete(
  auth: ResolvedAuth,
  kinds: Parameters<typeof nearBackendName>[1],
  name: string,
  noun: "ephemeral" | "tenant",
): Promise<NearBackend | undefined> {
  if (!isBackendHandle(name)) return nearBackendName(auth, kinds, name).catch(() => undefined);
  return nearBackendName(auth, kinds, name, true).catch((err: unknown) => {
    throw isUnansweredLookup(err) ? deleteLookupFailed(noun, name, err) : err;
  });
}

/**
 * {@link clearStaleRecord} after a lookup that found NO ephemeral by `name`:
 * first the pinned workspace must be one the credential reaches (otherwise the
 * usage error naming the ids that are — every name "misses" under an id it
 * cannot see), then no reachable workspace may hold the name — its records are
 * keyed by host and name, not workspace. Held in another: `elsewhere`'s error.
 * A list that cannot be read confirms nothing, and nothing is cleared.
 */
async function clearMissedRecord(
  auth: ResolvedAuth,
  name: string,
  elsewhere: (where: Extract<Whereabouts, { at: "elsewhere" }>) => Error,
): Promise<boolean> {
  await refuseUnreachableWorkspace(auth);
  const where = await whereaboutsOf(auth, name, "ephemeral");
  if (where.at === "elsewhere") throw elsewhere(where);
  return where.at === "nowhere" && clearStaleRecord(auth, name);
}

/**
 * The gate before a delete that missed answers "nothing was deleted" (exit 0)
 * or clears any record of `name`: the pinned workspace is one the credential
 * reaches, and no workspace it reaches holds the name. Held in another: the
 * wrong-workspace refusal naming it, with `command` rerun there. Not every
 * list read: exit 8, `command` the rerun. Shared by `ephemeral delete` and
 * `tenant delete`.
 */
export async function confirmMissEverywhere(
  auth: ResolvedAuth,
  name: string,
  kinds: "ephemeral" | "either",
  noun: "ephemeral" | "tenant",
  command: string,
): Promise<void> {
  await refuseUnreachableWorkspace(auth);
  const where = await whereaboutsOf(auth, name, kinds);
  const nothing = "nothing was deleted, and no local record was cleared";
  if (where.at === "elsewhere") {
    throw heldElsewhereError(auth, where, name, nothing, command, {
      verb: "delete",
      name,
      deleted: false,
      alreadyGone: false,
      declined: false,
      clearedLandingRecord: false,
    });
  }
  if (where.at === "unknown") {
    throw new LookupFailedError(
      `Could not confirm ${noun} "${name}" is gone from every workspace this credential reaches (${where.detail}) — ${nothing}`,
      "unreachable",
      noun,
    ).withRerun(command);
  }
}

/**
 * The existence lookup every named verb starts with. A lookup that got no
 * answer is not "gone" and not "exists": it exits 8 with the network-failure
 * wording every backend selector uses, since its remedy is the same — retry.
 */
async function lookup(
  auth: ResolvedAuth,
  parentWorkspaceId: number,
  name: string,
  deleting = false,
): Promise<EphemeralSummary | null> {
  try {
    return await getEphemeral(auth, { parentWorkspaceId, name });
  } catch (err) {
    // A server error (5xx) is no answer either (E2E pass 29: `ephemeral get`
    // on a 503 exited 1 with no rerun).
    if (isUnansweredLookup(err)) throw (deleting ? deleteLookupFailed : lookupFailed)("ephemeral", name, err);
    throw err;
  }
}

/**
 * {@link lookupFailed} for a DELETE's lookup: its aftermath says what a
 * delete's reader asks — "nothing was deleted" — not "nothing was created or
 * changed" (E2E pass 23). Shared by `ephemeral`, `tenant` and `release delete`.
 */
export function deleteLookupFailed(kind: Parameters<typeof lookupFailed>[0], name: string, err: unknown): LookupFailedError {
  return asDeleteLookupFailure(lookupFailed(kind, name, err));
}

/** An already-built {@link lookupFailed} error, reworded for a delete. Anything else passes through. */
export function asDeleteLookupFailure<E>(err: E): E | LookupFailedError {
  if (!(err instanceof LookupFailedError)) return err;
  return new LookupFailedError(
    err.head.replace(/nothing was created or changed$/, "nothing was deleted"),
    err.liveness,
    err.kind,
  );
}

/** A name no ephemeral has, and no record of this project's ever held. Exit 8. */
function unknownError(name: string, flags = ""): SourceError {
  return new SourceError(
    `No ephemeral named "${name}". \`xanosdk ephemeral list${flags}\` shows the ones that exist.`,
    "gone",
    "ephemeral",
  );
}

/**
 * The answer for a value that is a live ephemeral's DISPLAY name: nothing by
 * that name exists, and the hint names the one to pass. Exit 8 like the gone
 * answer — the named backend could not be addressed — but without its "run
 * deploy" advice, which would send the reader to replace an environment that
 * is fine.
 */
function displayNameError(name: string, owner: DisplayOwner, tail: string, rerun: (owner: string) => string): SourceError {
  if (isShared(owner)) {
    const names = owner.owners.map((o) => o.name);
    return new SourceError(
      `No ephemeral named "${name}"${tail}.\n${sharedDisplayHint(name, owner, (o) => `\`${rerun(o.name)}\`.`)}`,
      "gone",
      "ephemeral",
      names[0],
      names,
    );
  }
  // The whole command, ready to paste — the name alone was a template (E2E pass 30).
  return new SourceError(
    `No ephemeral named "${name}"${tail}.\n${displayNameHint("ephemeral", name, owner, `run \`${rerun(owner)}\`.`)}`,
    "gone",
    "ephemeral",
    owner,
  );
}

/**
 * Clear the local record for this credential's scope when it points at `name`.
 * Scoped by PROFILE as well as workspace, so a lookup that merely cannot SEE an
 * ephemeral under one profile cannot clear another profile's record for it.
 *
 * `deleted`: the platform confirmed deleting `name` itself. The name is unique
 * on the host, so every record naming it — under any profile, a deleted one's
 * included (`profile delete` points here) — is cleared.
 */
function clearStaleRecord(auth: ResolvedAuth, name: string, deleted = false): boolean {
  const tracked = getEnvironment(readEphemeralState(process.cwd()), auth);
  // Its landing record too, tracked or not: what this project landed on an
  // ephemeral that no longer exists scopes nothing.
  const landing = clearEphemeralLanding(process.cwd(), auth.instance, name);
  const own = tracked?.name === name && clearEnvironment(process.cwd(), auth);
  const any = deleted && clearEnvironmentsNamed(process.cwd(), auth.instance, name);
  return own || any || landing;
}

export async function runEphemeralCommand(args: ParsedArgs): Promise<void> {
  switch (args.subcommand) {
    case "list":
      return runList(args);
    case "get":
      return runGet(args);
    case "delete":
      return runDelete(args);
    case "export":
      return runExport(args);
    default:
      throw unknownSubcommand("ephemeral", args.subcommand, args.positionals);
  }
}

// ── list ────────────────────────────────────────────────────────────────────

async function runList(args: ParsedArgs): Promise<void> {
  const auth = await getAccessToken(args);
  // A listing that got no answer exits 8 with this run as the rerun, as `get`
  // does — not 1 with a bare "retry" (E2E pass 22).
  const rows = await (args.allWorkspaces
    ? listAllEphemeral(auth)
    : listEphemeral(auth, { parentWorkspaceId: auth.workspaceId })
  ).catch((err: unknown) => {
    throw readUnanswered("ephemeral", "list ephemerals", "an empty list", err);
  });

  // An object, not a bare array: the shape `tenant list` (`{ tenants }`) and
  // `release list` (`{ releases }`) print, and one a field can be added to.
  if (isMachineOutput(args)) {
    // Each row with the selector the next command's backend slot takes, and
    // the workspace it lives under (its own row's, across workspaces).
    writeJson({
      ephemerals: rows.map((r) => ({ ...r, selector: `ephemeral:${r.name}`, workspaceId: r.workspaceId ?? auth.workspaceId })),
    });
    return;
  }
  const s = stdoutStyle();
  if (rows.length === 0) {
    process.stdout.write("No ephemeral tenants found\n");
    return;
  }
  const lines = rows.map((r) => {
    const exp = formatExpiration(r.expiresAt);
    const expTxt = exp === "expired" ? s.red("expired") : s.dim(`expires ${exp}`);
    const state = r.state ? s.dim(`[${safeText(r.state)}]`) : "";
    const ws = args.allWorkspaces && r.workspaceId ? s.dim(` (workspace ${r.workspaceId})`) : "";
    // The tenant name is the handle you pass to `get`/`delete`/`export`, so it
    // leads (bold); the human display, if it differs, trails dimmed.
    const label = r.display && r.display !== r.name ? ` ${s.dim(safeText(r.display))}` : "";
    return `  ${s.bold(safeText(r.name))}${label} ${state} ${expTxt}${ws}`;
  });
  printHuman(lines.join("\n") + "\n");
}

// ── get ─────────────────────────────────────────────────────────────────────

async function runGet(args: ParsedArgs): Promise<void> {
  const name = requireName(args, "get");
  const auth = await getAccessToken(args);
  const parentWorkspaceId = auth.workspaceId;
  const summary = await resolveLive(auth, parentWorkspaceId, name, contextFlags(args), "get", args.json === true ? " --json" : "");
  // Read the env's microservices from its OWN base URL (internal workspace 1),
  // the same pair `deploy` imports to. Best-effort: this verb's job is to report
  // the env, and a microservice read failing must not take that answer away.
  const microservices = summary.url === undefined ? [] : await readMicroservices(auth, summary.url);

  if (isMachineOutput(args)) {
    writeJson({ ...summary, microservices, selector: `ephemeral:${summary.name}`, workspaceId: parentWorkspaceId });
    return;
  }
  const s = stdoutStyle();
  const rows: Array<[string, string]> = [];
  if (summary.url) rows.push(["Base URL", s.bold(s.cyan(summary.url))]);
  // "Tenant" (not "Ephemeral") names the handle you pass to `get`/`delete`/
  // `export`; the human display, if it differs, trails dimmed.
  const label = summary.display && summary.display !== summary.name ? ` ${s.dim(summary.display)}` : "";
  rows.push(["Tenant", `${s.bold(summary.name)}${label}`]);
  if (summary.state) rows.push(["State", summary.state]);
  rows.push(["Expires", s.dim(formatExpiration(summary.expiresAt))]);
  printHuman("\n" + formatFields(rows));
  printMicroserviceSection(microservices);
}

// ── delete ──────────────────────────────────────────────────────────────────

async function runDelete(args: ParsedArgs): Promise<void> {
  const name = requireName(args, "delete");
  const auth = await getAccessToken(args);
  const parentWorkspaceId = auth.workspaceId;

  // Looked up BEFORE the prompt: asking "delete X?" about a name that turns out
  // to be a display name, or nothing at all, asks a question whose yes does
  // nothing. A live ephemeral may be CALLED that, and "already gone" would tell
  // the reader it is gone while it keeps running — the answer is the name to
  // pass, exit 8, and nothing is deleted.
  const found = await lookup(auth, parentWorkspaceId, name, true);
  const jsonFlag = args.json === true ? " --json" : "";
  if (found === null) {
    const owner = await displayNameOwner(auth, "ephemeral", name);
    if (owner !== undefined) {
      // `--yes` kept only for the one ephemeral the display name addresses.
      const yes = args.yes && !isShared(owner) ? " --yes" : "";
      throw displayNameError(name, owner, " — nothing was deleted", (n) => `xanosdk ephemeral delete ${shellQuote(n)}${jsonFlag}${contextFlags(args)}${yes}`);
    }
  }
  // A typo of a live one's name (E2E pass 27): the not-found answer says which.
  // Read strictly: "no near name" decides an exit-0 answer below.
  const near = found === null ? await nearForDelete(auth, ["ephemeral"], name, "ephemeral") : undefined;
  // A miss on what cannot be a handle names nothing that ever existed, and a
  // miss one slip from a live one is most likely that one mistyped: neither is
  // an idempotent "already gone" — exit 8, as a display name is answered.
  if (found === null && (!isBackendHandle(name) || near !== undefined)) {
    const meant = near === undefined ? "" : nearBackendLines(near, deleteFix(args, jsonFlag));
    throw new SourceError(
      `No ephemeral named "${name}" — nothing was deleted. \`xanosdk ephemeral list${contextFlags(args)}\` shows the ones that exist.${meant}`,
      "gone",
      "ephemeral",
      near?.name,
      near?.names,
    );
  }
  // Exit 0 "nothing was deleted" only once no workspace this credential
  // reaches holds it: a miss under the wrong pinned workspace is not a delete.
  if (found === null) {
    const yes = args.yes ? " --yes" : "";
    await confirmMissEverywhere(auth, name, "ephemeral", "ephemeral", `xanosdk ephemeral delete ${shellQuote(name)}${yes}${jsonFlag}${contextFlags(args)}`);
  }

  // Named as every other backend line names one: `ephemeral "e4f2-…" ("My App")`.
  const named = found === null ? `ephemeral "${name}"` : namedEphemeral(found);
  // The headline and where, before any answer, as `tenant delete` and `release delete` say it.
  // With no terminal to answer and no `--yes`, the confirmation refuses: the
  // line says what WOULD be deleted, so it never reads as a delete under way.
  const refusing = !args.yes && found !== null && process.stdin.isTTY !== true;
  // Only over one the lookup found: "Deleting …" above "No ephemeral named …"
  // announced a delete that was never going to happen — and its "on …" line
  // belongs under that headline, never alone.
  if (found !== null) {
    step(`${refusing ? "Would delete" : "Deleting"} ${named}`);
    discloseWriteTarget({ base: auth.instance, workspaceId: auth.workspaceId });
  }
  // The destination every delete document carries, as `tenant delete` and
  // `release delete` carry it: the ephemeral, under the instance and workspace
  // it lives in (its own URL is not read for a delete), and the name people
  // call it when its record carries one.
  // `url` and `display` are always present, `null` when the lookup found none,
  // so an already-gone answer carries the same key set as a delete.
  const display = found?.display !== undefined && found.display !== name ? found.display : undefined;
  const destination = {
    ...writeTargetPayload({ base: auth.instance, workspaceId: auth.workspaceId, kind: "ephemeral", label: name }),
    url: found?.url ?? null,
    display: display ?? null,
  };
  if (!args.yes && found !== null) {
    // `tenant delete`'s question, word for word: the two verbs delete the same thing.
    const ok = await confirm(`Delete ${named}? This destroys it and everything it serves.`, {
      flag: "--yes",
      // As `tenant delete` refuses off a terminal: the details, and this delete with `--yes`.
      refusal: {
        details: { verb: "delete", name, deleted: false, alreadyGone: false, declined: false, clearedLandingRecord: false },
        rerun: `xanosdk ephemeral delete ${shellQuote(name)} --yes${args.json === true ? " --json" : ""}${contextFlags(args)}`,
      },
    });
    if (!ok) {
      info("Deletion cancelled — nothing was deleted.");
      // A declined delete answers too, in the shape `tenant delete` and
      // `release delete` print for one: nothing deleted, and why.
      if (isMachineOutput(args)) {
        writeJson({ verb: "delete", destination, name, deleted: false, alreadyGone: false, declined: true, clearedLandingRecord: false });
      }
      return;
    }
  }

  const { alreadyGone } =
    found === null
      ? { alreadyGone: true }
      : await describeWrite(
          { what: `the delete of ${named}`, resolveWith: `xanosdk ephemeral get ${shellQuote(name)}${contextFlags(args)}` },
          () => deleteEphemeral(auth, { parentWorkspaceId, name, verified: found.type === "ephemeral" }),
        ).catch((err: unknown) => {
          // "Its local record was kept" only over a record there was: the one
          // this project tracks, as `tenant delete` decides it.
          const recordKept = getEnvironment(readEphemeralState(process.cwd()), auth)?.name === name;
          throw unknownDeleteOutcome(err, named, name, contextFlags(args), "ephemeral", recordKept);
        });
  // Only after a delete the platform confirmed, or a miss confirmed in every
  // workspace this credential reaches (an unknown outcome throws above and
  // keeps the record, since the environment may well still be running).
  const cleared = clearStaleRecord(auth, name, found !== null);
  if (alreadyGone) {
    // Only what is known, as `tenant delete` says it: a name the lookup did not
    // find may never have existed, so "already gone" would claim a history
    // nobody saw. It is known to have existed when this project recorded it
    // (the record is cleared), or when the lookup found it and the delete did
    // not — a race. A near name is a different ephemeral, so its delete never
    // carries `--yes`: it asks before it acts.
    const meant =
      near === undefined
        ? ""
        : nearBackendLines(near, deleteFix(args, jsonFlag)).replace(/\n/g, " ");
    warn(
      found === null && !cleared
        ? `No ephemeral named "${name}" — nothing was deleted.${meant}`
        : `Ephemeral "${name}" was already gone${cleared ? " (cleared its local record)" : ""}.${meant}`,
      "ephemeral.not-found",
    );
  } else {
    success(`Deleted ${named}${cleared ? " (cleared its local record)" : ""}`);
  }
  // The already-gone arm answers too: a script deleting an env it expects to
  // be there needs to tell that apart from one it actually removed.
  if (isMachineOutput(args)) {
    writeJson({
      verb: "delete",
      destination,
      name,
      deleted: !alreadyGone,
      alreadyGone,
      declined: false,
      clearedLandingRecord: cleared,
      ...(near === undefined ? {} : { suggestion: near.name }),
    });
  }
}

/**
 * A delete whose outcome is unknown — sent, and answered with something that
 * is not the success answer, a 5xx, or nothing at all — said in the delete's
 * own words: it may or may not have been deleted, how to find out, and that
 * this project's record of it was kept. A connection that never opened (refused,
 * a name that did not resolve, a blocked port) sent nothing: said as that, in
 * the same words, exit 1. A refusal (a 4xx) passes through as it is.
 */
export function unknownDeleteOutcome(
  err: unknown,
  named: string,
  name: string,
  flags: string,
  noun: "ephemeral" | "tenant" | "release" = "ephemeral",
  /** Whether this project holds a local record of it to keep. A release has none. */
  recordKept: boolean = noun !== "release",
): unknown {
  if (!(err instanceof Error)) return err;
  const head = err.message.split("\n")[0]!;
  if (/\nNothing was sent — retry\.$/.test(err.message)) {
    // The command, not "retry": printed to paste (E2E pass 23).
    const again = `xanosdk ${noun} delete ${shellQuote(name)}${flags} --yes`;
    return new Error(`${head}\nNothing was sent — nothing was deleted. Once it is reachable, run \`${again}\` again.`, {
      cause: err,
    });
  }
  if (!/may or may not have taken effect/.test(err.message)) return err;
  const check = `xanosdk ${noun} ${noun === "release" ? "show" : "get"} ${shellQuote(name)}${flags}`;
  return new Error(
    `${head}\n${named.charAt(0).toUpperCase()}${named.slice(1)} may or may not have been deleted — check with ` +
      `\`${check}\` before retrying.${recordKept ? " Its local record was kept." : ""}`,
    { cause: err },
  );
}

// ── export ──────────────────────────────────────────────────────────────────

async function runExport(args: ParsedArgs): Promise<void> {
  // The name is optional: without one, the ephemeral this project tracks — as
  // `tables` and `test` default — and the refusal when none is tracked.
  const typed = args.positionals[0] === undefined ? undefined : requireName(args, "export");
  const format = args.format ?? "json";
  const ext = format === "multidoc" ? "xs" : "json";
  // `--name` is the output basename, as on `workspace export`; the env name is
  // only its default. The positional still chooses which env is read. Resolved
  // before anything is read, so a `--name` that cannot apply is refused first.
  // With no `--path`, the file lands in the project's `.xano/exports/` — the
  // export carries the env's doc token and secrets in cleartext, and a bare
  // `./<handle>.json` in the project root was one `git add .` from history
  // (E2E pass 25). `.xano/` is what every scaffold ignores.
  const path = args.path ?? defaultExportDir();
  const provisional = resolveOutputTarget({ path, name: args.name ?? typed ?? "ephemeral", ext });
  refuseIgnoredName(args, provisional, ext);
  const auth = await getAccessToken(args);
  const { resolveEphemeralName } = await import("./env-target.js");
  const name = typed ?? (await resolveEphemeralName(auth, undefined));
  const target =
    typed !== undefined || args.name !== undefined ? provisional : resolveOutputTarget({ path, name, ext });
  const parentWorkspaceId = auth.workspaceId;
  // Gone/expired gate first — this also yields the base URL for the json export.
  const exportFlags =
    (args.path !== undefined ? ` --path ${shellQuote(args.path)}` : "") +
    (args.format !== undefined ? ` --format ${shellQuote(args.format)}` : "") +
    (args.name !== undefined ? ` --name ${shellQuote(args.name)}` : "") +
    (args.json === true ? " --json" : "");
  const summary = await resolveLive(auth, parentWorkspaceId, name, contextFlags(args), "export", exportFlags);

  let content: string;
  let secrets: string[];
  if (format === "multidoc") {
    // The engine's own rendering of the env, fetched over its text route. It is
    // the authoritative one: it is what the engine actually has — an API
    // group's documentation token included, in cleartext.
    content = await fetchEphemeralMultidoc(auth, parentWorkspaceId, name);
    secrets = secretsInMultidoc(content);
  } else {
    const bundle = await fetchEphemeralBundle(auth, summary, name);
    content = JSON.stringify(bundle, null, 2);
    secrets = secretsCarriedBy(bundle);
  }

  if (target.kind === "stdout") {
    writeData(process.stdout, content + "\n");
    // The file path says this and writes 0600; a pipe cannot be chmod-ed, so
    // the note is all the protection there is — on stderr, off the payload.
    if (secrets.length > 0) {
      warn(
        `The export carries ${secretsPhrase(secrets)} in cleartext — written to stdout, where no file ` +
          `permission protects it; do not commit or log it.`,
        "secrets.cleartext-stdout",
      );
    }
    return;
  }
  // Parents created, as `export --out` does. Either format can carry the env's
  // values and documentation token in cleartext, so a file holding them is
  // written owner-only (0600) and said so — the one writer and notice every
  // export shares (see `writeExportFile`).
  writeExportFile(target.path, content + "\n", secrets);
  // One line for one write. The artifact went to the file, so a machine reader
  // is owed a document naming it.
  if (isMachineOutput(args)) writeJson({ path: target.path, format });
  // Named as `workspace export` names its source, the format after it. On
  // stderr, so a piped run says it too.
  success(`Exported ephemeral ${name}${format === "multidoc" ? " (multidoc)" : ""} → ${target.path}`);
}

/**
 * Where a bare `ephemeral export` writes: `.xano/exports/` under the project
 * this run is in (the working directory outside one). The trailing separator
 * makes it a directory target however much of it exists yet.
 */
export function defaultExportDir(cwd: string = process.cwd()): string {
  return join(projectDirFrom(cwd) ?? cwd, ".xano", "exports") + sep;
}

/**
 * Refuse a `--name` the target does not use: `--path -` writes no file, and a
 * `--path` naming a FILE is that file whatever `--name` says. Accepted, the
 * name would be dropped without a word and a caller would go looking for a
 * file that was never written — `workspace export` refuses the same way.
 */
function refuseIgnoredName(args: ParsedArgs, target: OutputTarget, ext: "xs" | "json"): void {
  if (args.name === undefined) return;
  if (target.kind === "stdout") {
    throw new UsageError(
      "`--name` names the exported file, and `--path -` writes the export to stdout instead of a file. " +
        "Drop one: `--path -` to pipe it, or `--name` (with or without a `--path` directory) to write a file.",
      { hintFor: { command: "ephemeral", subcommand: "export" } },
    );
  }
  if (basename(target.path) !== `${args.name}.${ext}`) {
    throw new UsageError(
      `\`--name\` names the exported file, and \`--path ${args.path}\` already names one. ` +
        "Drop one: `--path <file>` alone, or `--name` with a `--path` directory (or none, for the current one).",
      { hintFor: { command: "ephemeral", subcommand: "export" } },
    );
  }
}

/**
 * Export the ephemeral's XanoScript multidoc via the tenant multidoc route.
 *
 * The answer is checked before anything is written: a page, a JSON body or
 * text that is not a XanoScript document answering 200 is refused (host only,
 * never the body), and a connection lost on the way says nothing was written.
 */
async function fetchEphemeralMultidoc(auth: ResolvedAuth, parentWorkspaceId: number, name: string): Promise<string> {
  const action = "ephemeral export";
  const url = new URL(`/api:meta/workspace/${parentWorkspaceId}/tenant/${encodeURIComponent(name)}/multidoc`, auth.instance);
  try {
    // A pure read, so a dropped connection is retried and a transport failure is
    // explained the way the JSON export's is.
    const res = await fetchReadOrExplain(
      url.href,
      {
        headers: { accept: "text/x-xanoscript", Authorization: `Bearer ${auth.access_token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      action,
      TIMEOUT_MS,
    );
    const text = await res.text();
    if (!res.ok) throw Object.assign(httpFailureError(action, res, text), { status: res.status });
    return multidocAnswer(text, action, url.href);
  } catch (err) {
    if (!(err instanceof TransportError) && !isServerError(err)) throw err;
    throw unansweredExport(err);
  }
}

/**
 * Export the ephemeral's workspace as a bundle: the env workspace id is always 1,
 * so the shared workspace-export call runs against the env's own base URL.
 * Guards the base-URL call so an env that dies after the existence gate surfaces
 * the same expired/gone message rather than a raw transport error.
 */
export async function fetchEphemeralBundle(
  auth: ResolvedAuth,
  summary: EphemeralSummary,
  name: string,
): Promise<ExportedBundle> {
  if (summary.url === undefined) throw goneError(name, false);
  try {
    return await exportWorkspaceBundle(auth, {
      base: summary.url,
      workspaceId: 1,
      label: "ephemeral export",
    });
  } catch (err) {
    // An answer — a refusal, or a 200 that is not an archive — is the env (or
    // something in front of it) speaking for itself: reported as it said it.
    // Calling it a dropped connection blamed a network that worked.
    if (!(err instanceof TransportError) && !isServerError(err)) throw err;
    // No answer: a failure on the wire, or a server error (5xx). The env CAN
    // vanish between the existence gate and this call, but a lost answer alone
    // does not say so — so it is asked again. Gone is reported as gone; still
    // there (or not askable, the network being down) is a read to run again,
    // never "expired… run deploy", which would send the reader to replace an
    // environment that is fine.
    const again = await getEphemeral(auth, { parentWorkspaceId: auth.workspaceId, name }).then(
      (s) => (s === null || isExpired(s.expiresAt) ? "gone" : "live"),
      () => "unknown" as const,
    );
    if (again === "gone") throw goneError(name, false);
    throw unansweredExport(err, again === "live" ? namedEphemeral(summary) : undefined);
  }
}

/**
 * An export read that got no answer, as the lookup before it says one: exit 8,
 * nothing written, and this command line as the rerun (the dispatcher names
 * it). A 503 on the read exited 1 with no rerun while a 503 on the lookup
 * exited 8 (E2E pass 30). The transport's own first line names the host and
 * what happened; its generic aftermath is replaced by this one.
 */
function unansweredExport(err: unknown, stillThere?: string): LookupFailedError {
  const head = ((err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "").trim().replace(/[.:]$/, "");
  const what =
    err instanceof TransportError
      ? err.timeout
        ? "The export timed out"
        : "The connection dropped during the export"
      : `${unansweredCause(err)}, not a missing ephemeral`;
  return new LookupFailedError(
    `${head}.\n${what}${stillThere === undefined ? "" : ` — ${stillThere} is still there`}; nothing was written`,
    "unreachable",
    "ephemeral",
  );
}

// ── helpers ───────────────────────────────────────────────────────────────
function requireName(args: ParsedArgs, verb: string): string {
  // Trimmed, as a selector's name is: a platform-assigned name never carries
  // padding, and an untrimmed `" name "` found nothing — so `delete` said the
  // live env was already gone and `get`/`export` said it did not exist.
  const name = args.positionals[0]?.trim();
  if (name === undefined || name === "") {
    throw new UsageError(
      `\`xanosdk ephemeral ${verb}\` needs an ephemeral name. \`xanosdk ephemeral list${contextFlags(args)}\` shows the ones that exist.`,
      { hintFor: { command: "ephemeral", subcommand: verb } },
    );
  }
  assertOneName(args.positionals[0]!, "the ephemeral name", { args, helpFor: { command: "ephemeral", subcommand: verb } });
  // `ephemeral:<name>` — the `selector` a `--json` document carries — names the same one.
  return verbBackendName(name, "ephemeral", { command: "ephemeral", subcommand: verb }, contextFlags(args));
}

/** A near ephemeral's delete, as a did-you-mean names it: without `--yes`, so it asks before it acts. */
function deleteFix(args: ParsedArgs, jsonFlag: string): (name: string) => string {
  return (n) => `\`xanosdk ephemeral delete ${shellQuote(n)}${jsonFlag}${contextFlags(args)}\` deletes it, after asking to confirm.`;
}
