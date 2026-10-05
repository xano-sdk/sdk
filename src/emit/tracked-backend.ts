/**
 * What a bare command goes to — the TRACKED backend — decided in one place.
 *
 * Every operation that takes a backend selector declares, in the registry,
 * whether bare means "the backend this project last deployed to" (see
 * `backend-slot.ts`). This module is what that sentence means:
 *
 * 1. **The pointer.** `.xano/deployed.json` names the KIND the project last
 *    deployed to: an ephemeral or a Xano Engine, never a workspace or a tenant
 *    (see {@link isRealDeployment} and `deploy/deployed-state.ts`). Read
 *    without a credential.
 * 2. **The kind's own store.** An ephemeral pointer is answered by the
 *    ephemeral record under the CURRENT credential; a local pointer by
 *    the engine record for this directory. A pointer whose store has nothing
 *    refuses — it never quietly falls through to the other kind, because the
 *    project said which kind it was using.
 * 3. **No pointer yet** (a project deployed before the pointer existed, or
 *    never): the ephemeral record under the current credential when a
 *    credential resolves silently — today's rule — else the engine record for
 *    this directory, else nothing is tracked. A missing credential SKIPS the
 *    ephemeral check rather than failing it: a signed-out developer iterating
 *    against a Xano Engine must never be told to log in.
 * 4. **Liveness** is the resolver's (`source-resolve.ts`): a gone or expired
 *    ephemeral, a stale or off-loopback engine.
 *
 * ## One owner for the messages
 *
 * The refusals here used to live as per-command copies — one in `release
 * create`, others in the env and publish commands — and each copy named a
 * slightly different fix. They are read by coding agents that do exactly what
 * the text says, so every refusal names the slot's own spelling (`--to`,
 * `--on`, `--from`, or the positional), `xanosdk deploy` and `xanosdk deploy
 * --local`, and — where it is the cause — the other profile or the
 * other workspace that holds the record. A kind the slot cannot serve is
 * refused with the slot's declared reason, whether it was typed or tracked.
 *
 * ## A credential only for a hosted kind
 *
 * Handlers pass a {@link CredentialProvider}, never a credential. A local
 * pointer never calls it; an ephemeral pointer requires it; the absent-pointer
 * fallback calls it only when some ephemeral is recorded at all, and treats a
 * failure as "signed out" rather than an error. {@link memoCredential} makes
 * the lookup here and the resolve after it share one fetch.
 *
 * ## `--profile` against a Xano Engine (R9)
 *
 * A Xano Engine selects no credential, so a `--profile` beside one is refused,
 * never dropped — a flag that silently did nothing would let an agent believe
 * it had picked an account. A single-slot handler passes `profile` and
 * {@link resolveBackend} refuses; a handler with two slots (a source AND a
 * destination) omits it and calls {@link refuseProfileForLocal} once every
 * slot has resolved, since a profile is legitimate when EITHER side is hosted.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { NotSignedInError, type ResolvedAuth } from "../auth/token.js";
import { backendDirIn } from "./backend-dir.js";
import { pastePath } from "./typed-cwd.js";
import { isProjectDir } from "./xanosdk-project.js";
import { shellQuote } from "../util/shell-quote.js";
import {
  globalAuthFilePath,
  localAuthFilePath,
  loginCommand,
  profileAddCommand,
  readCredentialFile,
  recordedCredentialPath,
} from "../auth/store.js";
import { getEngineRecord } from "../deploy/local-engine-state.js";
import { getEnvironment, readEphemeralState, unreadableEphemeralState, type EnvScope, type EphemeralState } from "../deploy/ephemeral-state.js";
import { displayPath } from "../util/rel-path.js";
import { otherCredentialRefusal } from "./env-target.js";
import { isRealDeployment, readDeployed, type DeployedKind } from "../deploy/deployed-state.js";
import { commandPath, parseSlot, refusedKind, slotValueMissing, type BackendSlot } from "./backend-slot.js";
import { sourceSpellings, type Source, type SourceKind } from "./source-selector.js";
import { LookupFailedError, resolveSource, SourceError, type CredentialProvider, type ResolveDeps, type ResolvedSource } from "./source-resolve.js";
import { UsageError, type HelpTarget } from "./errors.js";
import {
  contextFlags,
  credentialFileFlagFor,
  ENV_CREDENTIAL_VARS,
  ORIGIN_READ_ONLY_BY_REFRESH,
  recordedByEnvCredential,
  typedCredentialFlags,
} from "./context-flags.js";

export { isRealDeployment };
export type { DeployedKind };

/** What a handler hands the tracked-backend resolver. */
export interface TrackedContext {
  /**
   * Yields the Xano credential. Called only for a hosted kind — never for a
   * Xano Engine — and, on the absent-pointer fallback, only when an ephemeral
   * is recorded at all. Production passes `() => getAccessToken(args)`.
   */
  credential: CredentialProvider;
  /**
   * The run's `--profile`, for a SINGLE-slot handler: a local resolution is
   * then refused (R9). Two-slot handlers leave it out and call
   * {@link refuseProfileForLocal} after both slots resolve.
   */
  profile?: string;
  /** The resolver's seams, plus `cwd` (the project) and `env` (where engine records live). */
  deps?: ResolveDeps;
}

/**
 * A provider that fetches at most once, however many times it is asked.
 *
 * The tracked lookup reads the credential to find the ephemeral record, and the
 * resolve after it reads it again to look the environment up; an OAuth refresh
 * between the two would rotate the refresh token twice for one command.
 */
export function memoCredential(provider: CredentialProvider): CredentialProvider {
  let pending: Promise<ResolvedAuth> | undefined;
  return () => (pending ??= provider());
}

/**
 * The backend `slot` names: the value typed into it, or — when nothing was —
 * the tracked default. Returns the parsed {@link Source}; nothing is resolved
 * and no liveness is checked, so a handler can branch on `kind` (fetch a
 * credential only for a hosted one, read a file for `file`) before resolving.
 *
 * Pass a {@link memoCredential}-wrapped provider when the same one then goes
 * to `resolveSource`, or use {@link resolveBackend}, which does.
 */
export async function selectBackend(
  slot: BackendSlot,
  raw: string | undefined,
  ctx: TrackedContext,
): Promise<Source> {
  if (raw !== undefined) return parseSlot(slot, raw);
  if (slot.selector.default === "none") throw slotValueMissing(slot);
  if (slot.selector.default !== "tracked") {
    throw new Error(
      `Internal: \`${commandPath(slot.command, slot.subcommand)}\`'s ${slot.spelling} defaults to "${slot.selector.default}", ` +
        `which the caller resolves itself — not the tracked backend.`,
    );
  }

  const cwd = ctx.deps?.cwd ?? process.cwd();
  const env = ctx.deps?.env ?? process.env;
  const pointer = readDeployed(cwd)?.kind;
  // Off the pointer alone, before any credential or enumeration: a kind this
  // command cannot serve is refused the same way whatever its record says.
  if (pointer !== undefined) refuseUnservable(slot, pointer);

  const state = readEphemeralState(cwd);
  let scope: EnvScope | undefined;
  if (pointer === "ephemeral") {
    // Required: the project said it is on an ephemeral, and only a credential
    // can say which one. Its own failure (not signed in) is the right message.
    scope = await ctx.credential();
  } else if (pointer === undefined && Object.keys(state.environments).length > 0) {
    // The fallback's ephemeral check, attempted only when some ephemeral is
    // recorded at all — a project with none never touches the credential.
    scope = await silently(ctx.credential);
  }

  const decided = decide({ cwd, pointer, state, scope, engineRecorded: getEngineRecord(cwd, env) !== undefined }, slot);
  if ("refusal" in decided) {
    const { reachableFirst } = await import("./env-target.js");
    throw await reachableFirst(decided.refusal, scope);
  }
  refuseUnservable(slot, decided.kind);
  return { kind: decided.kind };
}

/**
 * Parse or default `slot`, then resolve it: the whole pipeline for a
 * single-slot handler.
 *
 * `file` is refused as an internal error — a slot that accepts a bundle file
 * reads it itself, so such a handler calls {@link selectBackend} and branches
 * before resolving.
 */
export async function resolveBackend(
  slot: BackendSlot,
  raw: string | undefined,
  ctx: TrackedContext,
): Promise<ResolvedSource> {
  const credential = memoCredential(ctx.credential);
  const source = await selectBackend(slot, raw, { ...ctx, credential });
  if (source.kind === "file") {
    throw new Error(`Internal: \`${commandPath(slot.command, slot.subcommand)}\` resolved a bundle file; read it before resolving a backend.`);
  }
  if (source.kind === "local") refuseProfileForLocal(ctx.profile, [source.kind], slot);
  return resolveSource(source, credential, { ...ctx.deps, cwd: ctx.deps?.cwd ?? process.cwd() }).catch((err: unknown) => {
    throw lookupRetry(err, slot);
  });
}

/**
 * A lookup that got no answer names THIS command as the rerun — "Retry." alone
 * left which one unsaid after a `test run-all` whose tests never started. The
 * dispatcher replaces it with the exact command line when it has one.
 */
function lookupRetry(err: unknown, slot: BackendSlot): unknown {
  if (!(err instanceof LookupFailedError)) return err;
  return err.withRerun(`xanosdk ${commandPath(slot.command, slot.subcommand)} …`, " as you ran it");
}

/**
 * Refuse `--profile` when none of an invocation's resolved kinds is hosted
 * (R9). A profile beside one hosted slot is legitimate — `deploy local`
 * to an ephemeral picks the destination's account with it — so this takes
 * every slot's kind, and a two-slot handler calls it once both have resolved.
 */
export function refuseProfileForLocal(
  profile: string | undefined,
  kinds: readonly SourceKind[],
  slot?: BackendSlot,
  /**
   * The run's other credential flags. Defaults to what the dispatcher recorded
   * (`typedCredentialFlags`), so every local backend refuses them
   * whichever command selected it — `tables local --config X` exited 0
   * with the file never read, as `deploy --local` already refused.
   */
  flags: { authFile?: string; local?: boolean; authHost?: string } = typedCredentialFlags(),
): void {
  if (kinds.some((k) => k !== "local")) return;
  const why = "and a Xano Engine takes none — it is reached with the engine's own bearer.";
  // No slot is `deploy --local`, whose destination is the flag itself:
  // "name a hosted backend on the command" read as keeping it.
  const or = slot === undefined ? "or add `--ephemeral` to deploy to a hosted backend." : `or ${nameOne(slot, "a hosted backend", true)}.`;
  if (profile !== undefined) {
    throw new UsageError(`\`--profile ${profile}\` selects a Xano credential, ${why} Drop \`--profile\`, ${or}`, hintOpts(slot));
  }
  if (flags.authFile !== undefined) {
    // The path the reader typed, as `deploy --local` names it; never
    // resolved or read — a Xano Engine never reaches it.
    throw new UsageError(`\`--config ${flags.authFile}\` names a Xano credential file, ${why} Drop \`--config\`, ${or}`, hintOpts(slot));
  }
  if (flags.local === true) {
    throw new UsageError(`\`--local-auth\` selects the project-local Xano credential file, ${why} Drop \`--local-auth\`, ${or}`, hintOpts(slot));
  }
  if (flags.authHost !== undefined) {
    // Not echoed: an origin can carry a `user:password@`.
    throw new UsageError(`\`--origin\` names a Xano sign-in server, ${why} ${ORIGIN_READ_ONLY_BY_REFRESH}`, hintOpts(slot));
  }
}

/** What `status` reports a bare command would go to. */
export type TrackedAnswer =
  | { kind: DeployedKind; via: "pointer" | "fallback"; reason: null }
  | { kind: null; via: null; reason: string };

/**
 * The read-only answer: pointer, then fallback, to a kind — or the reason a
 * bare command would refuse. No network, no credential fetch, no writes and no
 * liveness check: the caller hands in the scope of a credential it already
 * holds, or `undefined` when signed out, and gets the same decision a bare
 * command would reach before its resolve.
 */
export function readTrackedBackend(opts: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  scope: EnvScope | undefined;
}): TrackedAnswer {
  const decided = decide(
    {
      cwd: opts.cwd,
      pointer: readDeployed(opts.cwd)?.kind,
      state: readEphemeralState(opts.cwd),
      scope: opts.scope,
      engineRecorded: getEngineRecord(opts.cwd, opts.env ?? process.env) !== undefined,
    },
    undefined,
  );
  if ("refusal" in decided) return { kind: null, via: null, reason: decided.refusal.message };
  return { kind: decided.kind, via: decided.via, reason: null };
}

// ── The decision ─────────────────────────────────────────────────────────────

interface Facts {
  /** The project directory the records were read from — where a nested record is looked for below. */
  cwd: string;
  pointer: DeployedKind | undefined;
  state: EphemeralState;
  /** The current credential's scope, or undefined when none resolved. */
  scope: EnvScope | undefined;
  engineRecorded: boolean;
}

type Decision = { kind: DeployedKind; via: "pointer" | "fallback" } | { refusal: Error };

/**
 * The flowchart, as one pure function over what is on disk plus the scope.
 * Shared by the handler path and `status`, so the two cannot disagree about
 * what a bare command does.
 */
function decide(facts: Facts, slot: BackendSlot | undefined): Decision {
  const { cwd, pointer, state, scope, engineRecorded } = facts;
  const ephemeralHere = scope !== undefined && getEnvironment(state, scope) !== undefined;

  if (pointer === "local") {
    return engineRecorded ? { kind: "local", via: "pointer" } : { refusal: noEngineRecorded(slot) };
  }
  if (pointer === "ephemeral") {
    if (scope === undefined) return { refusal: signedOut(slot, state) };
    return ephemeralHere ? { kind: "ephemeral", via: "pointer" } : { refusal: untracked(cwd, state, scope, slot, true) };
  }

  if (ephemeralHere) return { kind: "ephemeral", via: "fallback" };
  if (engineRecorded) return { kind: "local", via: "fallback" };
  if (scope !== undefined) return { refusal: untracked(cwd, state, scope, slot, false) };
  return { refusal: nothingTracked(cwd, slot, Object.keys(state.environments).length > 0, state) };
}

/**
 * The credential, or `undefined` when none is stored — "signed out" is an
 * answer on the fallback, not a failure.
 *
 * Only absence is: a refresh that failed, a half-set environment credential or
 * an unreadable token is a credential that exists and did not work. Read as
 * signed out, it would skip the ephemeral check and quietly send a bare command
 * to the Xano Engine instead — so it throws, with its own fix.
 */
async function silently(credential: CredentialProvider): Promise<ResolvedAuth | undefined> {
  try {
    return await credential();
  } catch (err) {
    if (err instanceof NotSignedInError) return undefined;
    throw err;
  }
}

/** Refuse a kind the slot declares it cannot serve, or does not take, when it came from tracking. */
function refuseUnservable(slot: BackendSlot, kind: DeployedKind): void {
  const refusal = refusedKind(slot, kind, "tracked");
  if (refusal !== undefined) throw refusal;
  if (!slot.selector.accepted.includes(kind)) {
    throw new UsageError(
      `This project last deployed to ${KIND_PHRASE[kind]}, which \`xanosdk ${commandPath(slot.command, slot.subcommand)}\` does not take. ` +
        `Name one with \`${slot.spelling}\`: ${sourceSpellings(slot.selector.accepted)}.`,
      hintOpts(slot),
    );
  }
}

// ── The messages ─────────────────────────────────────────────────────────────

const KIND_PHRASE: Record<DeployedKind, string> = {
  ephemeral: "an ephemeral",
  "local": "a Xano Engine",
};

/**
 * A one-line pointer to the command's help, never the block. Every refusal here
 * is about what this project has on record, not about how the command was
 * typed, and each already names its fix; a usage block under it buries that.
 */
function hintOpts(slot: BackendSlot | undefined): { hintFor?: HelpTarget } {
  if (slot === undefined) return {};
  return {
    hintFor: slot.subcommand === undefined ? { command: slot.command } : { command: slot.command, subcommand: slot.subcommand },
  };
}

/**
 * "name a backend with `--to`: workspace, ephemeral, …", or the slot-less
 * wording `status` uses. A positional slot is named as the argument it is —
 * "with `<backend>`" read as a flag nobody can type.
 */
function nameOne(slot: BackendSlot | undefined, what = "a backend", hostedOnly = false): string {
  if (slot === undefined) return `name ${what} on the command explicitly`;
  // "Name a hosted backend" lists only hosted forms: a Xano Engine (or a
  // bundle file) among them is the choice the sentence just refused.
  const spellings = sourceSpellings(
    hostedOnly ? slot.selector.accepted.filter((k) => k !== "local" && k !== "file") : slot.selector.accepted,
  );
  if (!slot.spelling.startsWith("--")) {
    const verb = slot.subcommand === undefined ? slot.command : `${slot.command} ${slot.subcommand}`;
    return `name ${what} as its argument (\`xanosdk ${verb} ${slot.spelling}\`): ${spellings}`;
  }
  return `name ${what} with \`${slot.spelling}\`: ${spellings}`;
}

/**
 * The two ways to stand a backend up, the hosted one with this run's credential
 * flags — naming the entry when the directory has none of its own at the
 * default place, since a bare `xanosdk deploy` there finds nothing to deploy.
 */
function bothDeploys(cwd?: string): string {
  const flags = contextFlags();
  const entry = cwd === undefined ? "" : soleNestedEntry(cwd);
  // `--local-auth` selects the project-local CREDENTIAL, not a Xano Engine,
  // so the hosted deploy that carries it says so.
  const hosted = /(^| )--local-auth( |$)/.test(flags) ? "an ephemeral, with the project-local credential" : "an ephemeral";
  return `\`xanosdk deploy${entry} --local\` (a Xano Engine on this machine) or \`xanosdk deploy${entry} --ephemeral${flags}\` (${hosted})`;
}

/**
 * Nothing recorded under THIS credential — the three-way message. The two ways
 * to miss are different problems with different remedies: another PROFILE
 * needs `--profile`, another WORKSPACE needs a different sign-in. Telling
 * someone to sign in to a workspace they are already signed in to is a remedy
 * they cannot act on, and "you have never deployed" is wrong for both.
 */
function untracked(cwd: string, state: EphemeralState, scope: EnvScope, slot: BackendSlot | undefined, pointer: boolean): Error {
  const other = otherCredentialRefusal(state, scope, `or ${nameOne(slot)}`, hintOpts(slot));
  if (other !== undefined) return other;
  if (pointer) {
    // The record is gone — cleared when the ephemeral it named was found swept —
    // which is the same event as `ephemeral:<name>` naming one that no longer
    // exists, so it exits the same way: a SourceError, exit 8, a case a CI
    // wrapper retries by deploying again.
    // Said as what happened — the ephemeral is gone — not as "none under this
    // credential", which read as a credential mismatch (E2E pass 29); another
    // credential's record was answered above.
    const unreadable = unreadableEphemeralState(cwd);
    if (unreadable !== undefined) {
      // The record exists but cannot be read: nothing here knows whether its
      // ephemeral is alive, and "gone" would send the reader to make a second.
      return new SourceError(
        `This project last deployed to an ephemeral, but its record ${displayPath(unreadable)} is unreadable. ` +
          `\`xanosdk ephemeral list${contextFlags()}\` finds the ephemeral it recorded — then ${nameOne(slot, "it")}.`,
        "gone",
        "ephemeral",
      );
    }
    return new SourceError(
      `This project last deployed to an ephemeral, but the last one is gone (deleted or expired). Run \`xanosdk deploy --ephemeral${contextFlags()}\` to create one — or \`xanosdk deploy ` +
        `--local\` for a Xano Engine — or ${nameOne(slot)}.`,
      "gone",
      "ephemeral",
    );
  }
  return nothingTracked(cwd, slot, false);
}

/**
 * The refusal for a bare form with nothing behind it: no pointer and no record
 * of either kind.
 *
 * Its own class so a command with a way forward that needs no backend at all
 * can add it — `env pull` on a fresh clone can have its file filled in by hand —
 * without matching on the message.
 */
export class NothingTrackedError extends UsageError {}

/** No pointer and no record of either kind. */
function nothingTracked(
  cwd: string,
  slot: BackendSlot | undefined,
  ephemeralRecordedElsewhere: boolean,
  state?: EphemeralState,
): UsageError {
  // A backend in a directory below deployed and recorded its ephemeral THERE:
  // "has not deployed" would be false, and "deploy first" would stand up a
  // second one. Named — never picked: which one a bare command meant is the
  // reader's to say, and with several it cannot be guessed.
  const nested = ephemeralRecordedElsewhere ? [] : nestedTrackedBackends(cwd);
  if (nested.length > 0) {
    // `release create` compares against a compile, and `--entry` names which.
    // Only from a directory that is no project itself: from a project, an entry
    // another project owns is refused (see `enterProjectRoot`).
    const takesEntry = slot?.command === "release" && slot.subcommand === "create" && !isProjectDir(cwd);
    const shown = nested.map((n) => `\`${n.dir}\`${n.entry === undefined ? "" : ` (deployed from ${n.entry})`}`);
    const one = nested.length === 1 ? nested[0]! : undefined;
    return new NothingTrackedError(
      `This directory has no backend to default to: nothing deployed from here. ` +
        (one !== undefined
          ? `The backend below it at ${shown[0]} did, and its record is kept beside it. Run the command from there ` +
            `(\`cd ${shellQuote(one.dir)}\`)` +
            (takesEntry && one.entry !== undefined ? `, or name its entry with \`--entry=${shellQuote(one.entry)}\`` : "") +
            `, or ${nameOne(slot)}.`
          : `Backends below it did, each with its record kept beside it: ${shown.join(", ")}. Run the command from ` +
            `the one you mean (\`cd <dir>\`)` +
            (takesEntry ? `, or name its entry with \`--entry=<entry>\`` : "") +
            `, or ${nameOne(slot)}.`),
      hintOpts(slot),
    );
  }
  const flags = state === undefined ? undefined : recordedCredentialFlags(state);
  const signIn = !ephemeralRecordedElsewhere
    ? ""
    : flags !== undefined
      ? flags.env
        ? ` An ephemeral is recorded under ${flags.who} — set ${ENV_CREDENTIAL_VARS} for that workspace again to reach it.`
        : flags.signIn
        ? ` An ephemeral is recorded under ${flags.who}, which no credential file holds — add it again with ${flags.flags} to reach it.`
        : ` An ephemeral is recorded under ${flags.who}, and no credential is signed in — re-run with \`${flags.flags}\` to reach it.`
      : ` An ephemeral is recorded, but no credential is signed in to look it up — \`${runLogin()}\` reaches it.`;
  return new NothingTrackedError(
    `This project has no backend to default to: it has not deployed to an ephemeral under this ` +
      `credential or to a Xano Engine from this directory.${signIn} Deploy first with ${bothDeploys(cwd)}, ` +
      `or ${nameOne(slot)}.`,
    hintOpts(slot),
  );
}

/**
 * ` <entry>` for the one backend entry below `cwd` when `cwd` has none of its
 * own — a bare `xanosdk deploy` there finds nothing to deploy — else empty.
 */
function soleNestedEntry(cwd: string): string {
  if (existsSync(join(backendDirIn(cwd), "index.ts"))) return "";
  const entries = nestedBackendEntries(cwd, 2);
  return entries.length === 1 ? ` ${shellQuote(entries[0]!)}` : "";
}

/**
 * The backend entries (`<dir>/xano/index.ts`) below `cwd`, spelled from where
 * the command was typed — at most `limit`, bounded in depth, never inside
 * `node_modules` or a dot-directory. Read only to word a notice or refusal.
 */
export function nestedBackendEntries(cwd: string, limit = 10): string[] {
  const entries: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > NESTED_DEPTH || entries.length >= limit) return;
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const child = join(dir, name);
      const entry = join(backendDirIn(child), "index.ts");
      if (existsSync(entry)) entries.push(entry);
      else walk(child, depth + 1);
    }
  };
  walk(cwd, 1);
  return entries.slice(0, limit).map((entry) => pastePath(relative(cwd, entry)));
}

/** A backend below the run's directory that deployed and keeps its records beside it. */
interface NestedBackend {
  /** Its directory, spelled from where the command was typed. */
  dir: string;
  /** The entry its ephemeral record names, spelled from where the command was typed. */
  entry?: string;
}

/** How deep below the run's directory a nested backend's records are looked for. */
const NESTED_DEPTH = 4;

/**
 * Directories below `cwd` holding a deploy's records (`.xano/deployed.json`, or
 * an `.xano/ephemeral.json` with an ephemeral in it) — bounded in depth, and
 * never inside `node_modules` or a dot-directory. Read only to word a refusal.
 */
function nestedTrackedBackends(cwd: string): NestedBackend[] {
  const found: NestedBackend[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > NESTED_DEPTH || found.length >= 10) return;
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const child = join(dir, name);
      const state = readEphemeralState(child);
      const records = Object.values(state.environments);
      if (readDeployed(child) !== undefined || records.length > 0) {
        const entry = records.find((r) => typeof r.entry === "string")?.entry;
        found.push({
          dir: pastePath(relative(cwd, child)),
          ...(entry === undefined ? {} : { entry: pastePath(relative(cwd, join(child, entry))) }),
        });
        continue;
      }
      walk(child, depth + 1);
    }
  };
  walk(cwd, 1);
  return found;
}

/** The pointer says Xano Engine, and this directory has no engine recorded. */
function noEngineRecorded(slot: BackendSlot | undefined): SourceError {
  // A positional slot is rendered as the command it is (`xanosdk tables
  // local:<name>`), as {@link nameOne} does — `<backend> …` read as a
  // flag nobody can type.
  const named =
    slot === undefined
      ? "name one on the command"
      : slot.spelling.startsWith("--")
        ? `name one with \`${slot.spelling} local:<name>\``
        : `name one: \`xanosdk ${slot.subcommand === undefined ? slot.command : `${slot.command} ${slot.subcommand}`} local:<name>\``;
  // Exit 8, as the ephemeral case above: the record it pointed at is gone.
  return new SourceError(
    `This project last deployed to a Xano Engine, but no engine is recorded for this directory. ` +
      `Run \`xanosdk deploy --local\` to stand one up, or \`xanosdk local list\` to see what is ` +
      `running and ${named}. \`xanosdk deploy --ephemeral${contextFlags()}\` still deploys to an ephemeral.`,
    "gone",
    "local",
  );
}

/** The pointer says ephemeral, and there is no credential to find it under — `status`'s signed-out case. */
function signedOut(slot: BackendSlot | undefined, state: EphemeralState): UsageError {
  const flags = recordedCredentialFlags(state);
  return new UsageError(
    `This project last deployed to an ephemeral, and no credential is signed in to look it up. ` +
      (flags?.env
        ? `It is recorded under ${flags.who} — set ${ENV_CREDENTIAL_VARS} for that workspace again, or ${nameOne(slot)}.`
        : flags?.signIn
        ? `It is recorded under ${flags.who}, which no credential file holds — add it again with ${flags.flags}; or ${nameOne(slot)}.`
        : flags !== undefined
          ? `It is recorded under ${flags.who} — re-run with \`${flags.flags}\`, or ${nameOne(slot)}.`
          : `Run \`${runLogin()}\`, or ${nameOne(slot)}.`),
    hintOpts(slot),
  );
}

/**
 * The sign-in for THIS run's credential file and typed profile — `--config
 * <other.json>` / `--local-auth` carried, as `status`'s own `signIn` carries them. A
 * bare `xanosdk login` writes the shared file, which a run reading another never
 * sees.
 */
function runLogin(): string {
  return `xanosdk login${contextFlags()}`;
}

/**
 * Signed out, the credential the project's ephemerals are recorded under, as
 * the flags that select it — when every record names the same profile and
 * file. A bare `xanosdk login` signs in beside it (as `default`, on the shared
 * file), which does not reach a record kept under `live` in `live.json`.
 * Undefined when the records name no profile, or more than one.
 */
function recordedCredentialFlags(
  state: EphemeralState,
): { who: string; flags: string; signIn?: true; env?: true } | undefined {
  const seen = new Map<string, { profile: string; file: string | undefined; env: boolean }>();
  const entries = Object.entries(state.environments);
  for (const [key, record] of entries) {
    if (!key.includes("/")) return undefined; // a legacy key names no profile
    const profile = key.slice(0, key.indexOf("/"));
    const env = recordedByEnvCredential(record);
    seen.set(`${env ? "\u0001env" : profile}\u0000${record.credential_file ?? ""}`, { profile, file: record.credential_file, env });
  }
  if (seen.size !== 1) return undefined;
  const [{ profile, file, env }] = [...seen.values()] as [{ profile: string; file: string | undefined; env: boolean }];
  // Made under the environment credential: no profile or file reaches it,
  // and `--profile default` exits 8 when nothing stores a "default".
  if (env) return { who: "the environment credential", flags: "", env: true };
  // A profile no credential file holds any more: `--profile default` then
  // exits 8 naming a profile that does not exist. Signing in is the remedy,
  // and `login` creates the profile the record is kept under.
  if (!profileStored(profile, file)) {
    // A deleted TOKEN profile is not signed in with OAuth, and the record
    // cannot say which kind it was — so both, filled from a lone record. The
    // file by its path: a `shared` record under `$XANO_CONFIG` needs `--config`.
    const [key, record] = entries.length === 1 ? entries[0]! : [undefined, undefined];
    const target = {
      path: file !== undefined ? (recordedCredentialPath(file) ?? undefined) : undefined,
      instance: key === undefined ? undefined : (record?.instance ?? `https://${key.split("/").slice(1, -1).join("/")}`),
      workspaceId: key?.slice(key.lastIndexOf("/") + 1),
    };
    return {
      who: `profile "${profile}"`,
      flags: `\`${loginCommand(profile, target)}\` (OAuth), or \`${profileAddCommand(profile, target)}\` (meta API token)`,
      signIn: true,
    };
  }
  return {
    who: `profile "${profile}"`,
    flags: `--profile ${profile}${file !== undefined ? credentialFileFlagFor(file) : ""}`,
  };
}

/** The credential file a record's `credential_file` names, or undefined for the shared default. */
function recordedFilePath(file: string | undefined): string | undefined {
  if (file === undefined || file === "shared") return undefined;
  return file === "local" ? localAuthFilePath() : file;
}

/**
 * Whether `profile` is stored in the file the record names — or, when it names
 * none (an older record), in either default file. Advice only: an unreadable
 * file counts as holding it, so the remedy stays the one it always was.
 */
function profileStored(profile: string, file: string | undefined): boolean {
  const paths =
    file === undefined ? [globalAuthFilePath(), localAuthFilePath()] : [recordedFilePath(file) ?? globalAuthFilePath()];
  for (const path of paths) {
    try {
      const stored = readCredentialFile(path);
      if (stored !== null && Object.hasOwn(stored.profiles, profile)) return true;
    } catch {
      return true;
    }
  }
  return false;
}
