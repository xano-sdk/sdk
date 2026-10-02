/**
 * `xanosdk env set NAME [VALUE]` / `xanosdk env unset NAME` — change ONE backend
 * env var on a running backend, by name.
 *
 * Every other write path carries the whole env set in an import archive, and
 * neither import mode can change one existing value: a merge is add-only, and a
 * replace rewrites the workspace. So rotating one secret used to mean a full
 * deploy, or a trip to the Xano UI. These verbs send only the name (and, for a
 * set, its value), and nothing else on the backend moves.
 *
 * Where: `--to` with any backend kind (`workspace`, `ephemeral[:<name>]`,
 * `local-engine[:<name>]`, `tenant:<name>`), or — none given — the backend this
 * project last deployed to, an ephemeral or a local engine (never a workspace or
 * a tenant: see `tracked-backend.ts`). A workspace or tenant is a real
 * deployment, so a write there confirms first; an ephemeral or a local engine is
 * throwaway and does not. A local engine is reached with its own bearer, so no
 * Xano credential is fetched for it — a signed-out developer iterating locally
 * never meets a login prompt.
 *
 * The value is never printed — not in the confirmation, the success line, the
 * JSON document, or an error. It is read from the second argument, or from
 * stdin when that is omitted, which keeps it out of shell history. Nothing
 * local is touched: `xano/.env` is what the NEXT deploy sends, and this command
 * does not edit it.
 *
 * Node-only (fetch, stdin); lazily imported by the dispatcher like its siblings.
 */
import { assertOneName } from "./name-argument.js";
import { describeWrite } from "../util/sent-writes.js";
import type { ParsedArgs } from "./cli.js";
import { getAccessToken, type BearerTarget } from "../auth/token.js";
import { UsageError } from "./errors.js";
import { contextFlags } from "./context-flags.js";
import { shellQuote } from "../util/shell-quote.js";
import { confirm, readStdin } from "./prompt.js";
import { certificateFailureCode, SENT_AFTERMATH, type BindingContext } from "../util/http.js";
import { backendDestinationPayload, discloseWriteTarget, info, success, writeTargetPayload, type DisclosureTarget } from "./ui.js";
import { isMachineOutput, writeJson } from "./output.js";
import type { SourceKind } from "./source-selector.js";
import { WORKSPACE_ENV_FILE, defaultWorkspaceEnvPath, workspaceEnvPathIn } from "./workspace-env.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { relForwardSlash } from "../util/rel-path.js";
import { actualKind, describeBackend, resolveSource, type ResolveDeps } from "./source-resolve.js";
import { requireBackendSlot } from "./backend-slot.js";
import { isRealDeployment, memoCredential, refuseProfileForLocal, selectBackend } from "./tracked-backend.js";
import { isRepresentableName } from "../util/env-name.js";
import {
  EnvVarRouteMissingError,
  setWorkspaceEnvVar,
  unsetWorkspaceEnvVar,
  type EnvSetAction,
  type EnvUnsetAction,
} from "../deploy/workspace-env-var.js";

type Verb = "set" | "unset";

/** Where the write lands, resolved and ready to send. */
interface EnvVarDestination {
  /** The kind that received it — the receipt's `kind`, for every kind. */
  kind: SourceKind;
  auth: BearerTarget;
  baseUrl: string;
  workspaceId: number;
  /** What the lines this command prints call it: `your workspace`, `ephemeral:e4f2`. */
  label: string;
  disclosure: DisclosureTarget;
  /** {@link isRealDeployment}: the workspace or a tenant, rather than a throwaway. */
  real: boolean;
  /** A hosted backend's name (an ephemeral's handle), to find what landed there. */
  name?: string;
  /** Absent for the local engine, whose bearer is its own and bound to nothing. */
  binding?: BindingContext;
  /** The `--json` receipt's `destination`, in the shape `deploy` and `tenant deploy` report. */
  receipt: ReturnType<typeof writeTargetPayload> & { url?: string; display?: string };
}

/** Seams the tests replace; production callers pass nothing. */
export interface EnvVarCommandOptions {
  /** The value when none is given as an argument. Defaults to reading stdin. */
  readStdin?: () => Promise<string | undefined>;
  /** The resolver's seams (hosted lookups, the engine enumeration, where records live). */
  deps?: ResolveDeps;
}

export async function runEnvVarCommand(
  args: ParsedArgs,
  verb: Verb,
  opts: EnvVarCommandOptions = {},
): Promise<void> {
  const help = { command: "env", subcommand: verb } as const;
  const name = args.positionals[0] ?? "";
  if (name.trim() === "") {
    throw new UsageError(`\`xanosdk env ${verb}\` needs the NAME of the env var.`, { helpFor: help });
  }
  assertOneName(name, `the NAME given to \`xanosdk env ${verb}\``, { helpFor: help, echo: false });
  if (name.includes("=")) {
    // `env set KEY=value` is the `--env-var` spelling carried over. Refused
    // rather than split, and the token is NOT echoed: the half after `=` is the
    // value, and this family never prints one.
    // `unset` takes no value at all, so its remedy is the name alone — read up
    // to the `=`, which is the part that is never the secret.
    throw new UsageError(
      verb === "unset"
        ? `\`xanosdk env unset\` takes only the name (\`xanosdk env unset ${name.slice(0, name.indexOf("=")) || "NAME"}\`), ` +
            `and a name cannot contain "=".`
        : `\`xanosdk env ${verb}\` takes the name and the value as separate arguments ` +
            `(\`xanosdk env set NAME VALUE\`), and a name cannot contain "=".`,
      { hintFor: help },
    );
  }
  // Only a name `xano/.env` can hold may be created: any other is one `env pull`
  // refuses to write back and no deploy can supply. `unset` stays
  // permissive so a name created some other way can still be removed. The name
  // is not echoed: this fires exactly when the arguments were swapped, and then
  // the "name" is the secret.
  if (verb === "set" && !isRepresentableName(name)) {
    throw new UsageError(
      `\`xanosdk env set\`: the first argument is not a usable env var name (it is not repeated here in ` +
        `case the arguments are swapped). A name is letters, digits and \`_\`, and does not start with a ` +
        `digit (e.g. STRIPE_KEY); the value comes second, or on stdin.`,
      { hintFor: help },
    );
  }

  // The same three names `--env-var` refuses: JavaScript object machinery, not
  // names a value can be stored under. `env set __proto__ x` was accepted while
  // `--env-var __proto__=x` was refused.
  if (verb === "set" && ["__proto__", "constructor", "prototype"].includes(name)) {
    throw new UsageError(
      `\`xanosdk env set\`: \`${name}\` cannot be an env var name — \`__proto__\`, \`constructor\` and ` +
        `\`prototype\` are reserved JavaScript object keys, as \`--env-var\` refuses them. Choose another name.`,
      { hintFor: help },
    );
  }

  // The value BEFORE the destination: a missing value is a local mistake, and
  // it should not cost an authenticated lookup to find out.
  const value = verb === "set" ? await readValue(args, name, help, opts) : undefined;
  const destination = await resolveDestination(args, verb, opts.deps);

  if (destination.real && args.yes !== true) {
    info(
      verb === "set"
        ? `${name} will be set on ${destination.label}. Every other env var there is left as it is.`
        : `${name} will be cleared on ${destination.label}. Every other env var there is left as it is.`,
    );
    discloseWriteTarget(destination.disclosure);
    // The rerun never reprints the value: a set's is piped back in by the reader.
    const ok = await confirm(verb === "set" ? `Set ${name}?` : `Clear ${name}?`, {
      flag: "--yes",
      refusal: {
        details: { verb, name, action: null, declined: false },
        rerun:
          verb === "set"
            ? `printf %s "$VALUE" | xanosdk env set ${shellQuote(name)} --yes${args.json === true ? " --json" : ""}${sameDestination(args)}`
            : `xanosdk env ${verb} ${shellQuote(name)} --yes${args.json === true ? " --json" : ""}${sameDestination(args)}`,
        ...(verb === "set" ? { note: " Its value is not reprinted: pipe it in as shown, or pass it as the second argument." } : {}),
      },
    });
    if (!ok) {
      // A declined confirmation is not a failure — and it answers `--json` too,
      // in the shape a write does, so a wrapper reads one document either way.
      info(`${verb === "set" ? "Set" : "Clear"} cancelled — nothing was written.`);
      if (isMachineOutput(args)) {
        writeJson({ verb, name, action: null, destination: destination.receipt, declined: true });
      }
      return;
    }
  }

  const target = {
    baseUrl: destination.baseUrl,
    workspaceId: destination.workspaceId,
    name,
    binding: destination.binding,
  };
  let action: EnvSetAction | EnvUnsetAction;
  try {
    // A signal while the write is on the wire names it and how to settle it.
    action = await describeWrite(
      {
        what: `the ${verb === "set" ? "set" : "clear"} of ${name}`,
        check: lostAnswerAftermath(verb, name, args).replace(/^The request was sent, so it may or may not have taken effect\. /, ""),
      },
      () =>
        value !== undefined
          ? setWorkspaceEnvVar(destination.auth, { ...target, value })
          : unsetWorkspaceEnvVar(destination.auth, target),
    );
  } catch (err) {
    if (err instanceof EnvVarRouteMissingError) {
      const cwd = opts.deps?.cwd ?? process.cwd();
      // The backend that landed on this target, not whichever one this
      // directory defaults to: a nested backend's value goes in ITS `.env`, and
      // the redeploy names its entry, or it replaces the target with another.
      const { entry, recorded } = await landedEntry(destination, cwd);
      // The `.env` a deploy of that entry reads; this directory's when no
      // landing recorded which backend it was.
      const envFile =
        (recorded
          ? relForwardSlash(cwd, defaultWorkspaceEnvPath(resolve(cwd, entry!)))
          : relForwardSlash(cwd, workspaceEnvPathIn(cwd))) || WORKSPACE_ENV_FILE;
      throw new Error(
        `${err.message} ${routeMissingHint(verb, name, destination.kind, envFile, contextFlags(args), entry, args.to)}`,
        { cause: err },
      );
    }
    // A certificate the handshake refused: nothing was sent and the outcome
    // is known — exit 8 as an unreachable backend, rerun once it is trusted.
    if (certificateFailureCode(err) !== undefined) {
      const { LookupFailedError } = await import("./source-resolve.js");
      const { command, value, withheld } = await notSentRerun(verb, name, args);
      const head = (err as Error).message.trim().replace(/[.:]$/, "");
      const refused = new LookupFailedError(head, "unreachable", destination.kind, `run \`${command}\` again${value}`);
      refused.message += withheld;
      refused.cause = err;
      throw refused;
    }
    if (err instanceof Error && err.message.includes(SENT_AFTERMATH)) {
      err.message = err.message.replace(SENT_AFTERMATH, lostAnswerAftermath(verb, name, args));
    } else if (err instanceof Error && err.message.endsWith(NOT_SENT_AFTERMATH)) {
      err.message = err.message.slice(0, -NOT_SENT_AFTERMATH.length) + (await notSentAftermath(verb, name, args));
    }
    throw err;
  }

  if (isMachineOutput(args)) {
    // `kind` for every kind: the local payload's `local: true` answers "is this
    // hosted", a different question from which kind received the write.
    writeJson({ verb, name, action, destination: destination.receipt, declined: false });
    // The one-line result on stderr too, as `env pull` prints its progress off
    // a terminal: a CI log read without the document said nothing happened.
    success(outcomeLine(name, action, destination.label));
    return;
  }
  success(outcomeLine(name, action, destination.label));
  if (!destination.real || args.yes === true) discloseWriteTarget(destination.disclosure);
}

/**
 * The way round a backend with no single-name env route: a deploy carrying the
 * change. Which deploy, and what it does to env, depends on the kind.
 *
 * The workspace and a tenant take a MERGE by default, which adds new names and
 * never removes one — so a set can ride one, but only `--replace` clears. An
 * ephemeral or a local engine is fully replaced by a deploy without
 * `--keep-data` (or with `--keep-data --reset`), env included, so the change is
 * made in what the deploy resolves; a `--keep-data` merge keeps the live value,
 * and `--replace` names nothing there. `envFile` is that file as THIS project keeps it, beside its backend.
 */
function routeMissingHint(
  verb: Verb,
  name: string,
  kind: SourceKind,
  envFile: string,
  flags = "",
  /** The entry the redeploy compiles (see {@link landedEntry}); unnamed when none is known. */
  entry?: string,
  /** This run's `--to`, which a real backend's redeploy names too. */
  to?: string,
): string {
  const file = entry === undefined ? "" : ` ${shellQuote(entry)}`;
  if (kind === "workspace" || kind === "tenant") {
    const deploy = to === undefined ? undefined : `xanosdk deploy${file} --to ${shellQuote(to)} --env-var ${name}=...${flags}`;
    return verb === "set"
      ? `Deploy the value with \`--env-var ${name}=...\` instead${deploy === undefined ? "" : ` (\`${deploy}\`)`} — a merge ` +
          `only adds new names; \`--replace\` rewrites every one.`
      : `A merge deploy never removes a name; only a \`--replace\` deploy, which rewrites every env ` +
          `var from the deploy's own set, clears it.`;
  }
  // A local engine takes no credential flags; an ephemeral's deploy reads the run's account.
  const base = kind === "local-engine" ? "xanosdk deploy --local-engine" : `xanosdk deploy${file}${flags}`;
  // A `--keep-data` merge never updates a value, so the redeploy that carries
  // the change is a replace — which rewrites the rows too, and says so (E2E
  // pass 27: "every deploy replaces the whole env set" sent a `--keep-data`
  // redeploy that kept the live value).
  const redeploy =
    `\`${base}\` (or \`${base} --keep-data --reset\`) — a replace, which applies the env set it resolves ` +
    `and also replaces the rows with the seed rows; a \`--keep-data\` deploy without \`--reset\` keeps the live value.`;
  return verb === "set"
    ? `Put the value in \`${envFile}\`, or pass \`--env-var ${name}=...\`, and redeploy with ${redeploy}`
    : `Remove ${name} from \`${envFile}\` (and from \`workspaceConfig({ env })\` if it is ` +
        `declared there) and redeploy with ${redeploy}`;
}

/**
 * The entry a redeploy of `destination` compiles: the one the deploy that
 * landed there recorded (an ephemeral's record keeps it), else this
 * directory's default backend — named either way, so the printed deploy
 * cannot quietly compile another backend over it.
 */
async function landedEntry(destination: EnvVarDestination, cwd: string): Promise<{ entry: string | undefined; recorded: boolean }> {
  const { readEphemeralState } = await import("../deploy/ephemeral-state.js");
  const { resolveProjectEntry } = await import("./deploy-source.js");
  if (destination.kind === "ephemeral" && destination.name !== undefined) {
    const entry = Object.values(readEphemeralState(cwd).environments).find((r) => r.name === destination.name)?.entry;
    if (entry !== undefined && existsSync(resolve(cwd, entry))) return { entry, recorded: true };
  }
  return { entry: resolveProjectEntry(cwd), recorded: false };
}

/** A write whose connection never opened (refused, unresolved): the generic line {@link notSentAftermath} replaces. */
const NOT_SENT_AFTERMATH = "Nothing was sent — retry.";

/**
 * In place of the bare "Nothing was sent — retry." (E2E pass 22): the command
 * to rerun, as typed — the credential flags kept, and a set's VALUE left out
 * and said to be (never reprinted: it is a secret on the command line).
 */
export async function notSentAftermath(verb: Verb, name: string, args: ParsedArgs): Promise<string> {
  const { command, value, withheld } = await notSentRerun(verb, name, args);
  return `Nothing was sent, so nothing changed — once it is reachable, run \`${command}\` again${value}.${withheld}`;
}

/** The command a write that was never sent is rerun with, the value left out (see {@link notSentAftermath}). */
async function notSentRerun(
  verb: Verb,
  name: string,
  args: ParsedArgs,
): Promise<{ command: string; value: string; withheld: string }> {
  let command: string;
  let withheld = "";
  if (args.argv !== undefined) {
    const { withoutSecretValue } = await import("./cli.js");
    const { retryCommand, withheldNote } = await import("./deploy-command.js");
    const retry = retryCommand(verb === "set" ? withoutSecretValue(args) : args);
    command = retry.command;
    withheld = withheldNote(retry.withheld);
  } else {
    const to = args.to !== undefined ? ` --to ${shellQuote(args.to)}` : "";
    command = `xanosdk env ${verb} ${shellQuote(name)}${to}${contextFlags(args)}${args.yes === true ? " --yes" : ""}`;
  }
  const value = verb === "set" ? " with its value (not repeated here — pass it again, or pipe it on stdin)" : "";
  return { command, value, withheld };
}

/**
 * In place of the generic "check before retrying" after a lost answer: both
 * verbs are idempotent by name, so the same command settles it either way —
 * a set writes the same value again, an unset of a cleared name answers "not
 * set". `env pull` is the read that shows which way it went. The value is
 * never repeated, so a set's command is named, not spelled out. Keeps "may or
 * may not have taken effect": that is what exits 9.
 */
export function lostAnswerAftermath(verb: Verb, name: string, args: ParsedArgs): string {
  const to = args.to !== undefined ? ` --to ${shellQuote(args.to)}` : "";
  const flags = contextFlags(args);
  const yes = args.yes === true ? " --yes" : "";
  const again =
    verb === "set"
      ? `re-run the same \`xanosdk env set ${shellQuote(name)}${to}${flags}${yes}\` command, with its value (not repeated here)`
      : `re-run \`xanosdk env unset ${shellQuote(name)}${to}${flags}${yes}\``;
  return (
    `The request was sent, so it may or may not have taken effect. ${verb === "set" ? "Setting" : "Clearing"} ` +
    `a name is safe to repeat: ${again} and it settles it either way — or see what the backend holds with ` +
    `\`xanosdk env pull${to === "" ? "" : ` --from ${shellQuote(args.to!)}`}${flags}\`.`
  );
}

function outcomeLine(name: string, action: EnvSetAction | EnvUnsetAction, label: string): string {
  switch (action) {
    case "created":
      return `Created ${name} on ${label}.`;
    case "updated":
      return `Replaced the value of ${name} on ${label}.`;
    case "deleted":
      return `Cleared ${name} on ${label}.`;
    case "absent":
      return `${name} was not set on ${label} — nothing to clear.`;
  }
}

/**
 * The value: the second argument, else stdin.
 *
 * Stdin is the form for a secret — `printf %s "$KEY" | xanosdk env set KEY` —
 * because an argument lands in shell history and in the process list. One
 * trailing newline is dropped, since `echo` adds one nobody meant to store.
 *
 * Empty is refused unless `--allow-empty-env` names this variable: an empty
 * value is far more often an unset shell variable than an intent, and storing
 * it would silently blank a working secret. Clearing is `env unset`.
 */
async function readValue(
  args: ParsedArgs,
  name: string,
  help: { command: "env"; subcommand: Verb },
  opts: EnvVarCommandOptions,
): Promise<string> {
  let value = args.positionals[1];
  if (value === undefined) {
    const piped = await (opts.readStdin ?? readStdin)();
    if (piped === undefined) {
      throw new UsageError(
        `\`xanosdk env set ${name}\` needs a value: pass it as the second argument, or pipe it on ` +
          `stdin (\`printf %s "$VALUE" | xanosdk env set ${name}${sameDestination(args)}\`) to keep it out of shell history.`,
        { helpFor: help },
      );
    }
    value = piped.replace(/\r?\n$/, "");
  }
  if (value === "" && !args.allowEmptyEnv.includes(name)) {
    // No usage block: the value parsed, and the message names both ways out.
    throw new UsageError(
      `The value for ${name} is empty — usually an unset shell variable rather than an intent. ` +
        `To store an empty value, re-run with \`--allow-empty-env=${name}\`; to remove the variable, ` +
        `use \`xanosdk env unset ${name}${sameDestination(args)}\`.`,
    );
  }
  return value;
}

/**
 * What a printed `xanosdk env …` needs to act where THIS run did: its `--to`,
 * and its credential flags (see `contextFlags`) — except for a local engine,
 * which refuses them.
 */
function sameDestination(args: ParsedArgs): string {
  const to = args.to === undefined ? "" : ` --to ${shellQuote(args.to)}`;
  return args.to !== undefined && /^local-engine\b/.test(args.to) ? to : `${to}${contextFlags(args)}`;
}

/**
 * The destination: `--to`, else the tracked backend — then resolved.
 *
 * The order is the point. The value was already read (a local mistake costs no
 * lookup); the pointer is read next, without a credential; the credential is
 * fetched only when the kind is hosted — the resolver never asks for one on a
 * local engine — and only then is the backend looked up. One memoized provider
 * serves the tracked lookup and the resolve, so an OAuth refresh happens once.
 */
async function resolveDestination(
  args: ParsedArgs,
  verb: Verb,
  deps: ResolveDeps | undefined,
): Promise<EnvVarDestination> {
  const slot = requireBackendSlot("env", verb, "to");
  const cwd = deps?.cwd ?? process.cwd();
  const credential = memoCredential(() => getAccessToken(args));
  const source = await selectBackend(slot, args.to, { credential, deps: { ...deps, cwd } });
  if (source.kind === "file") {
    // The slot does not accept a file, so `parseSlot` has already refused one.
    throw new Error("Internal: `env` resolved a bundle file as a write destination.");
  }
  refuseProfileForLocal(args.profile, [source.kind], slot);
  const resolved = await resolveSource(source, credential, { ...deps, cwd, workspaceless: "write" });
  const { base, workspaceId } = resolved.target;
  // The target's ACTUAL kind: an ephemeral named as `tenant:<name>` is a
  // throwaway, and asking to confirm a write to it as a real tenant was wrong.
  const real = isRealDeployment(actualKind(resolved));

  if (resolved.backend.kind === "local") {
    const disclosure: DisclosureTarget = { kind: "local-engine", url: resolved.backend.engine.url, workspaceId };
    return {
      kind: resolved.kind,
      auth: resolved.bearer,
      baseUrl: base,
      workspaceId,
      label: describeBackend(resolved),
      disclosure,
      real,
      // `kind` for every kind: the local payload's `local: true` answers "is
      // this hosted", a different question from which kind received the write.
      receipt: { kind: "local-engine", ...writeTargetPayload(disclosure) },
    };
  }
  const kind = actualKind(resolved) as "workspace" | "ephemeral" | "tenant";
  // An ephemeral or tenant is not an instance: its own URL as `instance` could
  // never match the instance a wrapper has configured. So the receipt names the
  // instance and workspace it lives under — the credential's — and its own URL
  // under `url`, the shape `deploy` and `tenant deploy` report.
  const parent = kind === "workspace" ? undefined : await credential();
  const receipt =
    parent === undefined || kind === "workspace"
      ? { kind, ...writeTargetPayload({ base, workspaceId, kind }) }
      : backendDestinationPayload(parent, {
          kind,
          name: resolved.target.label,
          url: base,
          // Only when it says something the name does not.
          ...(resolved.target.display !== undefined && resolved.target.display !== resolved.target.label
            ? { display: resolved.target.display }
            : {}),
        });
  return {
    receipt,
    kind,
    auth: resolved.bearer,
    baseUrl: base,
    workspaceId,
    label: describeBackend(resolved),
    // No label, for any kind: the line before it (the confirmation's "will be
    // set on …" or the outcome line) already names the backend, display name
    // and all — the one location-line format `publish` and `deploy` print.
    // An ephemeral or tenant by the workspace it lives under, as the receipt
    // names it: its own internal workspace is always #1 (E2E pass 36).
    disclosure: { base, workspaceId: parent?.workspaceId ?? workspaceId, kind },
    real,
    name: resolved.target.label,
    binding: resolved.backend.binding,
  };
}
