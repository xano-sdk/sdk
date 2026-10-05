/**
 * Which engine a `deploy --local` runs, and what that does to the
 * project's pin.
 *
 * The deploy asks two things of this module: {@link chooseLocalEngine} before
 * anything is downloaded, and {@link pinAfterAcquire} to write the pin once the
 * engine it names is on disk and verified — never before, so a failed download
 * cannot move a pin.
 *
 * Node-only, reached by a lazy import from the deploy command.
 */
import {
  type EngineSourceSpec,
  engineOverrideFromEnv,
  LOCAL_ENGINE_OVERRIDE_ENV,
  resolveEngineSource,
  resolveEnginePlatform,
} from "../deploy/local-engine-config.js";
import { isUnusablePin, readPin, writePin } from "../deploy/local-engine-pin.js";
import {
  ENGINE_RELEASES_URL_ENV,
  EngineReleaseNotFoundError,
  usesCustomReleaseManager,
} from "../deploy/local-engine-releases.js";
import { resolveProjectEntry } from "./deploy-source.js";
import { info, warn } from "./ui.js";
import { UsageError } from "./errors.js";
import { ORIGIN_READ_ONLY_BY_REFRESH } from "./context-flags.js";

/**
 * Refuse the credential flags on a local deploy that reads no
 * credential — the `--profile` refusal's siblings. A Xano Engine is reached
 * with its own bearer, so each was accepted and never used: `--config` (a typo
 * in it, or a path that is a directory, passed without a word), `--local-auth` (the
 * project-local credential file), and `--origin` (the sign-in server). Allowed
 * when a SOURCE among `kinds` is hosted, which does read a credential.
 *
 * Their environment spellings — XANO_CONFIG, XANO_ORIGIN, XANO_PROFILE — stay
 * ignored without a word, deliberately: they are ambient, commonly exported
 * once in a shell rc for hosted work, and a note on every local deploy would be
 * noise about a setting nobody typed for THIS run. A flag is an instruction
 * for this run, so dropping one silently is what is refused.
 */
export function refuseCredentialFlagsForLocal(
  args: { authFile?: string; local?: boolean; authHost?: string },
  kinds: readonly string[],
): void {
  if (kinds.some((k) => k !== "local")) return;
  const why = "and a Xano Engine takes none — it is reached with the engine's own bearer.";
  const or = "or deploy from a hosted backend that reads it.";
  const refuse = (message: string): never => {
    throw new UsageError(message, { hintFor: { command: "deploy" } });
  };
  if (args.authFile !== undefined) {
    refuse(`\`--config ${args.authFile}\` names a Xano credential file, ${why} Drop \`--config\`, ${or}`);
  }
  if (args.local === true) {
    refuse(`\`--local-auth\` selects the project-local Xano credential file, ${why} Drop \`--local-auth\`, ${or}`);
  }
  if (args.authHost !== undefined) {
    // Not echoed: an origin can carry a `user:password@`, and the flag's name
    // is all the reader needs to find it. Not "or deploy from a hosted backend
    // that reads it": a hosted deploy refuses `--origin` too unless it
    // exchanges XANO_REFRESH_TOKEN — a stored profile refreshes at the server
    // recorded with it, and a meta API token never refreshes.
    refuse(`\`--origin\` names a Xano sign-in server, ${why} ${ORIGIN_READ_ONLY_BY_REFRESH}`);
  }
}

/** What a `--local` deploy did to the project's engine pin — see `DeploySummary`. */
export type LocalEnginePinOutcome = "unchanged" | "created" | "moved" | "none";

/**
 * What put a hand-picked engine in place of the pin: a value on `--local`,
 * XANOSDK_ENGINE_OVERRIDE, or a custom XANOSDK_ENGINE_RELEASES_URL. The
 * summary's `pin` is `none` for each of these AND for a deploy with nothing to
 * pin into, so this is what tells a run on another engine from one with no pin.
 */
export type LocalEngineOverride = "flag" | "env" | "releases-url";

/**
 * How this run's Xano Engine was chosen, and what that means for the pin.
 *
 * `pinWrite` is what to write once the engine is acquired — never before, so a
 * failed download cannot move a pin. `pin` is the summary's answer when
 * nothing gets written.
 */
export interface LocalEngineChoice {
  source: EngineSourceSpec;
  pinWrite: "create" | "move" | undefined;
  pin: LocalEnginePinOutcome;
  /** Set when an override chose the engine; see {@link LocalEngineOverride}. */
  override?: LocalEngineOverride;
}

/**
 * Decide the engine source for a `--local` run (KTD3): a value on the
 * flag, then XANOSDK_ENGINE_OVERRIDE, then the project's pin, then the
 * latest release.
 *
 * An override (flag or variable), or a custom XANOSDK_ENGINE_RELEASES_URL,
 * never reads or writes the pin and never asks about updates — a tester running a hand-picked engine must not have the
 * project's version moved under them. With a pin, the update check runs: an
 * interactive run is asked (default no, and a decline is remembered so the next
 * deploy only mentions it); any other run gets a one-line notice on stderr. The
 * pin moves only on an explicit yes.
 */
export async function chooseLocalEngine(
  flagValue: string | undefined,
  dir: string,
  machineOutput: boolean,
): Promise<LocalEngineChoice> {
  // An override is announced whichever route named it, so a run on a
  // hand-picked engine always says the pin was left alone.
  if (flagValue !== undefined && flagValue !== "") {
    const source = resolveEngineSource(flagValue);
    announceOverride(source, "--local", "run `--local` bare to go back to it");
    return { source, pinWrite: undefined, pin: "none", override: "flag" };
  }

  // The environment's experiment, second only to the flag. Announced every
  // run: a variable left exported in a shell rc would otherwise run an engine
  // nobody on the project chose, with nothing on screen to say so.
  const fromEnv = engineOverrideFromEnv();
  if (fromEnv !== undefined) {
    announceOverride(fromEnv, LOCAL_ENGINE_OVERRIDE_ENV, "unset the variable to go back to it");
    return { source: fromEnv, pinWrite: undefined, pin: "none", override: "env" };
  }

  // A release manager other than the default publishes its own versions, so
  // none is pinned into the project, compared against the pin, or cached by
  // version. Announced like the override, and for the same reason; the address
  // itself is not printed.
  if (usesCustomReleaseManager()) {
    info(
      `Running the latest engine from ${ENGINE_RELEASES_URL_ENV} instead of this project's pinned ` +
        `engine, downloaded fresh each deploy. The pin is left as is; unset the variable to go back to it.`,
    );
    return { source: resolveEngineSource(undefined), pinWrite: undefined, pin: "none", override: "releases-url" };
  }

  // A pin that is there but is not a version is the user's field: run on the
  // latest and leave it exactly as written — pinning over it would also
  // replace their running engine. `local update` is the explicit way
  // to overwrite it.
  const pin = readPin(dir, {
    warn: (message) =>
      warn(
        `${message} This deploy runs the latest Xano Engine and the field is left as written — ` +
          `set it to a version like "v0.1.5", or run \`xanosdk local update\` to pin one.`,
        "local.version-invalid",
      ),
  });
  if (isUnusablePin(pin)) {
    return { source: resolveEngineSource(undefined), pinWrite: undefined, pin: "unchanged" };
  }
  // No `package.json` in a directory that is not a project either (`cd ~`, a
  // `--bundle` from Downloads): there is nothing to pin into, and creating a
  // manifest there would litter a directory nobody commits.
  if (pin === undefined && resolveProjectEntry(dir) === undefined) {
    warn(
      `No package.json in ${dir}, and it is not a Xano SDK project, so the Xano Engine was not ` +
        `pinned — this deploy runs the latest engine.`,
      "local.not-pinned",
    );
    return { source: resolveEngineSource(undefined), pinWrite: undefined, pin: "none" };
  }
  // Unset, or a project with no `package.json`: the first run pins, creating
  // the manifest when there is none.
  if (pin === null || pin === undefined) {
    return { source: resolveEngineSource(undefined), pinWrite: "create", pin: "none" };
  }

  const keep: LocalEngineChoice = {
    source: resolveEngineSource(undefined, process.env, pin),
    pinWrite: undefined,
    pin: "unchanged",
  };
  const platform = resolveEnginePlatform();
  if (platform === undefined) return keep;

  const check = await import("../deploy/local-engine-update-check.js");
  // Bounded and silent: an unanswerable check is the same as no newer engine.
  const latest = await check.latestKnownVersion({ platform });
  if (latest === undefined) return keep;
  const decision = check.decideUpdate({
    pin,
    latest,
    interactive: check.isInteractive({ machineOutput }),
    declined: check.declinedVersion(dir),
  });
  if (decision === "keep") return keep;
  if (decision === "notify") {
    info(check.updateNoticeText(pin, latest));
    return keep;
  }

  // Asked only on a terminal (`isInteractive` said so), because the prompt
  // refuses a non-terminal stdin. Default no: a stray Enter keeps the pin.
  const { confirm } = await import("./prompt.js");
  const yes = await confirm(check.updatePromptText(pin, latest), {
    flag: "`xanosdk local update`",
    refusal: { details: { updated: false }, rerun: "xanosdk local update" },
  });
  if (!yes) {
    check.recordDeclined(dir, latest);
    return keep;
  }
  return {
    source: resolveEngineSource(undefined, process.env, latest),
    pinWrite: "move",
    pin: "unchanged",
  };
}

/**
 * Say that an override runs instead of the pinned engine and that the pin is
 * left as is. `from` names where the override came from; `back` is how to
 * return to the pin. A URL is never printed: it may carry a credential.
 */
function announceOverride(source: EngineSourceSpec, from: string, back: string): void {
  const what =
    source.kind === "release"
      ? `engine ${source.version ?? "latest"}`
      : /^https?:\/\//i.test(source.source)
        ? "the engine at the URL"
        : `the engine archive ${source.source}`;
  info(`Running ${what} from ${from} instead of this project's pinned engine. The pin is left as is; ${back}.`);
}

/**
 * An engine an OVERRIDE named could not be had — no such release, or none for
 * this platform. The release layer's remedy, `xanosdk local update`, moves
 * the PIN, and the pin is not what this run used: after following it the same
 * override names the same missing version again. The way back is dropping the
 * override. Anything else, and a pinned run's failure, passes through as is.
 */
export function explainOverrideFailure(choice: LocalEngineChoice, err: unknown): never {
  const override = choice.override;
  const message = err instanceof Error ? err.message : undefined;
  const missing = err instanceof EngineReleaseNotFoundError || (message?.includes("has no archive for") ?? false);
  if ((override !== "flag" && override !== "env") || message === undefined || !missing) throw err;
  const what = message.split("\n")[0]!;
  const remedy =
    override === "flag"
      ? "Check the version, or drop it: `xanosdk deploy --local` (bare) runs this project's pinned engine, " +
        "and `xanosdk local update` moves that pin to the latest release."
      : `Check ${LOCAL_ENGINE_OVERRIDE_ENV}, or unset it to run this project's pinned engine.`;
  const text = `${what}\n${remedy}`;
  throw err instanceof EngineReleaseNotFoundError
    ? new EngineReleaseNotFoundError(text, { cause: err })
    : new Error(text, { cause: err });
}

/** What {@link pinAfterAcquire} hands the deploy. */
export interface PinAfterAcquire {
  /** Given to acquisition: writes the pin the choice asked for, once the engine is verified. */
  onAcquired: (acquired: { version: string | undefined }) => void;
  /** What happened to the pin, for the summary. */
  outcome: () => LocalEnginePinOutcome;
  /** Say what happened to the pin, once the engine is up. */
  announce: () => void;
}

/**
 * Write the pin `choice` asked for once the engine it names is acquired and
 * verified: a failed download of an accepted update must leave the old pin —
 * which is still cached — exactly as it was.
 */
export function pinAfterAcquire(choice: LocalEngineChoice, dir: string): PinAfterAcquire {
  let outcome: LocalEnginePinOutcome = choice.pin;
  let written: { path: string; version: string; created: boolean } | undefined;
  let failure: string | undefined;
  return {
    onAcquired: (acquired) => {
      if (choice.pinWrite === undefined || acquired.version === undefined) return;
      try {
        const result = writePin(dir, acquired.version);
        outcome = choice.pinWrite === "create" ? "created" : "moved";
        written = { path: result.path, version: acquired.version, created: result.created };
      } catch (err) {
        failure = (err as Error).message;
      }
    },
    outcome: () => outcome,
    announce: () => announceLocalEnginePin({ choice, written, failure }),
  };
}

/** Say what happened to the pin: the write ({@link pinWrittenText}), or why there was none. */
function announceLocalEnginePin(ctx: {
  choice: LocalEngineChoice;
  written: { path: string; version: string; created: boolean } | undefined;
  failure: string | undefined;
}): void {
  const { choice, written, failure } = ctx;
  if (written !== undefined) {
    info(pinWrittenText({ ...written, moved: choice.pinWrite === "move" }));
    return;
  }
  if (failure !== undefined) warn(`The Xano Engine version was not pinned: ${failure}`, "local.not-pinned");
}

/**
 * The line that follows every pin write, for the deploy and `local
 * update` alike. It names the file — a write into the project tree — and asks
 * for it to be committed, because a pin only one checkout has pins nothing.
 */
export function pinWrittenText(written: {
  path: string;
  version: string;
  /** No `package.json` existed, so one holding only the pin was created. */
  created: boolean;
  /** An existing pin moved, rather than a first one being written. */
  moved: boolean;
}): string {
  const what = written.created
    ? `Created ${written.path} to pin Xano Engine ${written.version}`
    : `${written.moved ? "Moved the Xano Engine pin to" : "Pinned Xano Engine"} ${written.version} in ${written.path}`;
  return `${what} — commit it so everyone on this project runs the same engine.`;
}
