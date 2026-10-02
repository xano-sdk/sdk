/**
 * The flags a printed `xanosdk …` hint must carry so it acts as THIS run did.
 *
 * A hint is a command the reader pastes. A run that read its credential from
 * `--config livecred.json`, the project-local file, or a named `--profile`
 * printed a bare `xanosdk ephemeral get <n>` that then read the machine's
 * default account — a different backend, or none. So every hint names the
 * credential file (never the shared one, which is what a bare command reads
 * anyway) and the profile the run was TOLD to use. A profile chosen by the
 * project pin or the environment is chosen again by the same rung, and is left
 * out.
 */
import {
  credentialFileFlag,
  recordedCredentialFile,
  recordedCredentialPath,
  resolveAuthFilePath,
} from "../auth/store.js";
import { readEnvVar } from "../util/env.js";
import { shellQuote } from "../util/shell-quote.js";
import type { ParsedArgs } from "./cli.js";

/**
 * The `--origin` refusal's remedy on a local-engine backend. Not "or deploy
 * from a hosted backend that reads it": a hosted run refuses `--origin` too
 * unless it exchanges XANO_REFRESH_TOKEN — the one arm that picks its OAuth
 * host per run. Shared with the other local-engine commands' refusal.
 */
export const ORIGIN_READ_ONLY_BY_REFRESH =
  "Drop `--origin` — only a XANO_REFRESH_TOKEN exchange reads it; a stored profile refreshes at the " +
  "server recorded with it, and a meta API token never refreshes.";

/** What {@link contextFlags} reads: the credential-selecting flags. */
export type ContextArgs = Pick<ParsedArgs, "authFile" | "local" | "profile">;

/**
 * The run's own flags, set once by the dispatcher after parsing. For the hints
 * printed several layers below any `args` — the backend resolver, the tracked
 * default — which every command shares and none threads its command line into.
 * A caller holding `args` passes them instead.
 */
let ambient: (ContextArgs & { authHost?: string }) | undefined;

/** Record this run's command line for {@link contextFlags}. `undefined` forgets it (tests). */
export function setHintContext(args: (ContextArgs & { authHost?: string }) | undefined): void {
  ambient =
    args === undefined
      ? undefined
      : { authFile: args.authFile, local: args.local, profile: args.profile, authHost: args.authHost };
}

/**
 * The credential flags this run was TYPED with, for a refusal made below any
 * `args`: a local engine takes none, and each was otherwise accepted and
 * dropped. `{}` outside a dispatched run.
 */
export function typedCredentialFlags(): { authFile?: string; local?: boolean; authHost?: string; profile?: string } {
  if (ambient === undefined) return {};
  return {
    ...(ambient.authFile !== undefined ? { authFile: ambient.authFile } : {}),
    ...(ambient.local ? { local: true } : {}),
    ...(ambient.authHost !== undefined ? { authHost: ambient.authHost } : {}),
    ...(ambient.profile !== undefined ? { profile: ambient.profile } : {}),
  };
}

/**
 * Where a credential was read from, as a tracked record keeps it: `shared`
 * (this machine's file), `local` (the project's `.xano/auth.json`), or the
 * absolute path `--config`/`XANO_CONFIG` named. `undefined` when it cannot be
 * resolved.
 */
export function credentialFileOf(args: ContextArgs | undefined = ambient): string | undefined {
  if (args === undefined || envCredentialResolves()) return undefined;
  try {
    return recordedCredentialFile(resolveAuthFilePath(args));
  } catch {
    return undefined;
  }
}

/**
 * The flag that reads the credential file {@link credentialFileOf} recorded:
 * `""`, ` --local`, or ` --config '<p>'` — by {@link credentialFileFlag}'s rule,
 * so under `$XANO_CONFIG` naming another file a `shared`/`local` record still
 * gets the `--config` that reaches it.
 */
export function credentialFileFlagFor(recorded: string): string {
  return credentialFileFlag(recordedCredentialPath(recorded) ?? undefined);
}

/**
 * ` --profile <p> --config '<path>'` / ` --local`, as this run used them, with
 * a leading space — or `""` when the run used the defaults. Spliced straight
 * after the verb: `` `xanosdk ephemeral get ${name}${contextFlags(args)}` ``.
 *
 * Never throws: a run that got far enough to print advice already resolved
 * its credential file, and advice must not fail a run on its own.
 */
export function contextFlags(
  args: ContextArgs | undefined = ambient,
  opts: { credentialStore?: boolean } = {},
): string {
  // An environment credential outranks every file and profile for a command
  // that authenticates: a hint carrying `--config` names a file the next run
  // ignores just as this one did. A verb that acts on the credential FILE
  // itself reads it whatever the environment holds, so it keeps its flags.
  if (args === undefined || (opts.credentialStore !== true && envCredentialResolves())) return "";
  // A file `$XANO_CONFIG` chose is chosen again by the same variable in the
  // shell the hint is pasted into — credentialFileFlag leaves it out, as a
  // pinned profile is.
  let file: string;
  try {
    file = credentialFileFlag(resolveAuthFilePath(args));
  } catch {
    file = args.local ? " --local" : args.authFile !== undefined ? ` --config ${shellQuote(args.authFile)}` : "";
  }
  const profile = args.profile !== undefined && args.profile !== "" ? ` --profile ${shellQuote(args.profile)}` : "";
  return `${profile}${file}`;
}

/**
 * Commands that act on the credential store or the project pin rather than
 * authenticate with it: `--config`, `--local` and `--profile` pick the file
 * and profile they change even under an environment credential, so their
 * printed reruns keep them.
 */
export const CREDENTIAL_STORE_COMMANDS: ReadonlySet<string> = new Set(["login", "logout", "profile"]);

/** Does `args` name a {@link CREDENTIAL_STORE_COMMANDS} verb? */
export function isCredentialStoreCommand(args: Pick<ParsedArgs, "command">): boolean {
  return args.command !== undefined && CREDENTIAL_STORE_COMMANDS.has(args.command);
}

/**
 * Does a COMPLETE environment credential (the meta-token triple, or a refresh
 * token with its client id) resolve this run? Then no `--config`, `--local` or
 * `--profile` selects anything — the file was displaced and named on stderr.
 */
function envCredentialResolves(): boolean {
  // The arms `getAccessToken` takes before any file, read here directly: this
  // module is advice every command imports, and must not pull the resolver in.
  const meta = ["XANO_INSTANCE_URL", "XANO_WORKSPACE_ID", "XANO_META_TOKEN"].filter((v) => readEnvVar(v) !== undefined);
  if (meta.length === 3) return true;
  return meta.length === 0 && readEnvVar("XANO_REFRESH_TOKEN") !== undefined && readEnvVar("XANO_CLIENT_ID") !== undefined;
}

/** The variables that make up an environment credential, as a remedy names them. */
export const ENV_CREDENTIAL_VARS = "XANO_INSTANCE_URL, XANO_WORKSPACE_ID and XANO_META_TOKEN (or XANO_REFRESH_TOKEN)";

/**
 * Was this tracked ephemeral record made under an environment credential? It
 * keys as `default` (it has no profile), so re-running with `--profile default`
 * names a profile that may not exist — what reaches it is the variables, set
 * again. The deploy stamps it; see `EphemeralRecord.credential`.
 */
export function recordedByEnvCredential(record: { credential?: string } | undefined): boolean {
  return record?.credential === "environment";
}
