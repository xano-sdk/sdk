/**
 * What a replacing import is about to take down on the static-host side.
 *
 * A replace clears EVERY static host in the workspace it lands in — the
 * engine's clear does, and no option keeps one — so a frontend serving there
 * stops the moment the import starts. Which frontends those are is read from
 * the platform, not from this project's `.xano/ephemeral.json`: that record
 * knows only what THIS project published, and says nothing of a frontend
 * another project or the dashboard put on the same environment, nor of one an
 * earlier `deploy --to … --replace` already took down.
 *
 * The record is the fallback for a read that failed, and is then reported as
 * unverified — never as the platform's answer.
 *
 * Shared by every replacing path: `deploy` refreshing its ephemeral (whatever
 * the source) and `deploy --to … --replace` (a workspace, a tenant, or an
 * ephemeral named as one).
 */
import type { ResolvedAuth } from "../auth/token.js";
import type { ParsedArgs } from "./cli.js";
import { UsageError } from "./errors.js";
import { retryCommand, withheldNote } from "./retry-command.js";
import { detail, warn } from "./ui.js";
import { closeSentence, READ_AFTERMATH, SENT_AFTERMATH } from "../util/http.js";
import { shellQuote } from "../util/shell-quote.js";
import { contextFlags, type ContextArgs } from "./context-flags.js";
import { pastePath } from "./typed-cwd.js";

/** The frontends a replace takes down, for the `--json` summary's `staticRemoved`. */
export interface StaticTeardown {
  /** Every URL serving on the target that stops when the replace lands. */
  urls: string[];
  /**
   * `true` when read from the platform. `false` when the read failed and the
   * URL is this project's own record of its last publish — which may already
   * be down, and misses anything another project published there.
   */
  verified: boolean;
  /**
   * Why the platform could not be read, when `verified` is false. With no
   * `urls`, nothing is known either way: a frontend may serve there, and the
   * replace takes down any that does.
   */
  reason?: string;
}

/** The outcome of the read, before anything is said about it. */
export interface StaticTeardownRead {
  /** What the replace takes down, or undefined when nothing is known to serve. */
  teardown: StaticTeardown | undefined;
  /** The live read's serving URLs, or undefined when the read failed. */
  live: string[] | undefined;
  /** Why the read failed, when it did. */
  error?: string;
}

/**
 * Read the serving frontends on `target`, falling back to `recorded` (this
 * project's own record of its last publish there) only when the read fails.
 */
export async function readStaticTeardown(
  auth: Pick<ResolvedAuth, "access_token">,
  target: { baseUrl: string; workspaceId: number },
  recorded: string | undefined,
): Promise<StaticTeardownRead> {
  const { listServingStaticHosts } = await import("../deploy/static-host.js");
  try {
    const serving = await listServingStaticHosts({ ...target, accessToken: auth.access_token });
    const urls = serving.map((s) => s.url);
    return { teardown: urls.length > 0 ? { urls, verified: true } : undefined, live: urls };
  } catch (err) {
    // Without the read's own aftermath ("Nothing was changed — retry."): the
    // deploy is not retrying, it proceeds, and says so itself.
    const error = withoutReadAftermath(err instanceof Error ? err.message : String(err));
    // Unread is never "nothing serves": the teardown is carried, unverified,
    // even with no URL to name — so `--json` says it as the warning does.
    return {
      teardown: { urls: recorded === undefined ? [] : [recorded], verified: false, reason: error },
      live: undefined,
      error,
    };
  }
}

/**
 * Ask `doubted` — a URL this project's record says an earlier replace took
 * down, or could not check — before the listing's word is taken for it.
 *
 * A refused replace rolls the static-host ROW back while the content its clear
 * deleted stays deleted, so the listing still names a URL answering 404. Taken
 * at its word, the next replace warned it "takes down" a site that was not
 * serving, and reported the removal verified. A URL that answers no longer is
 * dropped; one that gives no answer stays, unverified. `unchecked` is whether
 * it is still in doubt, for the record.
 */
export async function recheckDoubtedFrontend(
  read: StaticTeardownRead,
  doubted: string | undefined,
): Promise<{ read: StaticTeardownRead; unchecked: boolean }> {
  const { teardown, live } = read;
  if (doubted === undefined || live === undefined || teardown === undefined || !live.includes(doubted)) {
    return { read, unchecked: false };
  }
  const { probeFrontend } = await import("../deploy/verify-rollout.js");
  const state = await probeFrontend(doubted);
  if (state === "serving") return { read, unchecked: false };
  if (state === "down") {
    const urls = teardown.urls.filter((u) => u !== doubted);
    return {
      read: { ...read, live: live.filter((u) => u !== doubted), teardown: urls.length > 0 ? { ...teardown, urls } : undefined },
      unchecked: false,
    };
  }
  const reason = `${doubted} could not be reached to check — an earlier failed replace may already have taken it down.`;
  return { read: { ...read, teardown: { ...teardown, verified: false, reason } }, unchecked: true };
}

/** `message` less the line a failed read ends with — right for a read the reader retries, wrong for one a run proceeds past. */
function withoutReadAftermath(message: string): string {
  return message
    .split("\n")
    .filter((line) => line !== READ_AFTERMATH)
    .join("\n");
}

/**
 * Say, BEFORE the import and while it can still be stopped, that the replace
 * takes these frontends down.
 *
 * `where` names the target (`ephemeral "e4f2"`, `tenant "eu"`, `workspace #3`).
 * `publishing` is whether this run republishes with `--static`: then the loss
 * is a URL change rather than an outage, and is said as one. `keepHint` is the
 * way to leave the frontend serving on this command (`--keep-data` for an
 * ephemeral's refresh, dropping `--replace` for `--to`). Returns whether it
 * printed anything, for a caller whose blocks each end with a blank line.
 */
export function warnStaticTeardown(
  read: StaticTeardownRead,
  where: string,
  opts: { publishing: boolean; keepHint: string },
): boolean {
  const { teardown } = read;
  if (teardown === undefined) return false;
  // The read's own failure, as a sentence of its own below the line — never
  // nested inside it as a capitalised clause in parentheses.
  const reason = closeSentence(read.error ?? teardown.reason ?? "The read failed for an unknown reason.");
  if (teardown.urls.length === 0) {
    // Nothing known to serve, but nothing read either: said, not assumed away.
    if (opts.publishing) {
      detail(
        `Could not read ${where}'s static hosting, so this cannot say whether a frontend serves there; ` +
          `this replace takes down any that does, and \`--static\` publishes the new one after the import.`,
      );
      detail(reason);
    } else {
      warn(
        `Could not read ${where}'s static hosting, so this cannot say whether a frontend serves there — ` +
          `this replace takes down any that does.`,
        "static.teardown-unknown",
        [
          reason,
          `Re-run with \`--static <dir>\` to publish again (the URL may change), or ${opts.keepHint}.`,
        ],
      );
    }
    return true;
  }
  const urls = teardown.urls.join(", ");
  const one = teardown.urls.length === 1;
  if (opts.publishing) {
    detail(
      `This replace clears the frontend${one ? "" : "s"} serving at ${urls}; \`--static\` publishes the ` +
        `new one after the import (the URL may change).`,
    );
  } else {
    warn(
      `This replace takes the frontend${one ? "" : "s"} at ${urls} down — a replace clears ${where}'s ` +
        `static hosting, and this one publishes none.`,
      "static.teardown",
      [`Re-run with \`--static <dir>\` to publish again (the URL may change), or ${opts.keepHint}.`],
    );
  }
  if (!teardown.verified && read.live !== undefined) detail(`Unverified: ${reason}`);
  else if (!teardown.verified) {
    detail(
      `Unverified: ${where}'s static hosting could not be read, so this is this project's record of its ` +
        `last publish there — it may already be down.`,
    );
    detail(reason);
  }
  return true;
}

/**
 * The `staticRemoved` a summary carries: the teardown, less any URL the run's
 * own `--static` publish serves again. Undefined when nothing was lost.
 */
export function staticRemovedField(
  teardown: StaticTeardown | undefined,
  republished: string | undefined,
): { staticRemoved: StaticTeardown } | Record<string, never> {
  if (teardown === undefined) return {};
  const urls = teardown.urls.filter((u) => u !== republished);
  // An unread target is reported even with no URL left to name: nothing says
  // the replace took nothing down.
  return urls.length === 0 && teardown.verified ? {} : { staticRemoved: { ...teardown, urls } };
}

/** A `--static-host` naming a host other than the one the build route creates. */
function namedStaticHost(args: Pick<ParsedArgs, "static" | "staticHost">): string | undefined {
  if (args.static === undefined || args.staticHost === undefined || args.staticHost === "default") return undefined;
  return args.staticHost;
}

/**
 * Refuse, before anything is signed into or imported, a `--static-host` that a
 * replace is certain to delete.
 *
 * A replacing import clears every static host on its target, and the build
 * route re-creates only `default`. So after a replace a host of any other name
 * cannot exist, and the publish behind it was bound to fail — AFTER the old
 * frontend was already taken down. `replaces` is whether this run replaces for
 * certain: `--to … --replace`, or a deploy without `--keep-data` (or with
 * `--reset`). A `--keep-data` deploy that replaces anyway is caught where its
 * arm is decided, by {@link assertStaticHostSurvivesArm}.
 */
export function refuseStaticHostAReplaceClears(
  args: ParsedArgs,
  replaces: boolean,
  command: "deploy" | "release" = "deploy",
): void {
  const host = namedStaticHost(args);
  if (host === undefined || !replaces) return;
  throw new UsageError(
    `\`--static-host ${shellQuote(host)}\` names a host this replace deletes: a replace clears every static ` +
      `host on its target, and the publish after it re-creates only \`default\`. Nothing was deployed. ` +
      `Drop \`--static-host\` to publish to \`default\`${survivingRemedy(args, command)}`,
    { hintFor: { command } },
  );
}

/**
 * How the named host survives instead, as a command to run: a merge keeps the
 * target's static hosts as they are. A named host is created in the dashboard —
 * a deploy creates only `default` — so the merge works once one exists.
 */
function survivingRemedy(args: ParsedArgs, command: "deploy" | "release"): string {
  if (command === "release" || args.replace) return `, or drop \`--replace\` so the host survives.`;
  const host = shellQuote(namedStaticHost(args) ?? "");
  // A `--keep-data` run that replaces anyway is a new environment: it has no
  // host but `default` until one is created for it.
  if (args.keepData && !args.reset) {
    return (
      `. A new environment holds only \`default\`: deploy once, create the static host \`${host}\` in the ` +
      `dashboard, then deploy with \`--keep-data --static-host ${host}\`.`
    );
  }
  const merge = retryCommand(args, { add: ["--keep-data"], drop: ["--reset"] });
  return (
    `, or merge so the host survives — once the environment has a static host named \`${host}\` (created in the ` +
    `dashboard; a deploy creates only \`default\`): \`${merge.command}\`.${withheldNote(merge.withheld)}`
  );
}

/**
 * Before a MERGE's import: the named `--static-host` exists on the target.
 *
 * A merge leaves static hosting as it was, so the host has to be there already
 * — the build route creates only `default`. Checked by listing, so a typo is
 * refused while nothing has been written; a list that cannot be read proves
 * nothing, and the publish itself still answers then.
 */
export async function assertStaticHostExists(
  args: Pick<ParsedArgs, "static" | "staticHost">,
  auth: Pick<ResolvedAuth, "access_token">,
  target: { baseUrl: string; workspaceId: number },
): Promise<void> {
  const host = namedStaticHost(args);
  if (host === undefined) return;
  const { listStaticHostNames, StaticHostNotFoundError } = await import("../deploy/static-host.js");
  let names: string[];
  try {
    names = await listStaticHostNames({ ...target, accessToken: auth.access_token });
  } catch {
    return;
  }
  // Checked before the import, so the backend was not deployed either.
  if (!names.includes(host)) throw new StaticHostNotFoundError(host, names, "Nothing was deployed or published.");
}

/**
 * The `publish` line that retries only a failed `--static` step.
 *
 * `publish`, not the deploy again: a redeploy would re-import the backend that
 * just landed to retry an upload that has nothing to do with it.
 * `--static-routing` and `--static-env` are carried — dropping routing lets the
 * retry re-infer what the caller overrode. `--static-host` is carried too,
 * unless it IS the failure: repeating a host the target does not hold hands
 * the reader a command that fails the same way.
 */
export function staticRetryHint(
  dir: string,
  to: string,
  args: Pick<ParsedArgs, "staticHost" | "staticRouting" | "staticEnv"> & Partial<ContextArgs>,
  err: unknown,
): string {
  // By name: this module must not pull the upload transport in to ask.
  const badHost = err instanceof Error && err.name === "StaticHostNotFoundError";
  return (
    `Retry just the static step: \`${staticRetryCommand(dir, to, args, err)}\`` +
    (badHost ? ` (that publishes to \`default\`; add \`--static-host <name>\` for a host the target holds)` : "")
  );
}

/**
 * The command {@link staticRetryHint} prints, alone: the `--json` summary's
 * `static.retry`, so a document whose error says "the retry" carries one.
 */
export function staticRetryCommand(
  dir: string,
  to: string,
  args: Pick<ParsedArgs, "staticHost" | "staticRouting" | "staticEnv"> & Partial<ContextArgs>,
  err: unknown,
): string {
  const badHost = err instanceof Error && err.name === "StaticHostNotFoundError";
  // With this run's `--config`/`--local-auth`/`--profile`: a bare `publish` reads
  // the machine's default account, which may not reach the target at all.
  return (
    // Spelled from where the user typed: a run moved to its project's root
    // found `dir` from there, and a pasted `publish` resolves it from here.
    `xanosdk publish ${shellQuote(pastePath(dir))} --to ${shellQuote(to)}` +
    (args.staticHost && !badHost ? ` --static-host ${shellQuote(args.staticHost)}` : "") +
    (args.staticRouting ? ` --static-routing ${args.staticRouting}` : "") +
    Object.entries(args.staticEnv)
      .map(([k, v]) => ` --static-env ${shellQuote(`${k}=${v}`)}`)
      .join("") +
    contextFlags({ authFile: args.authFile, local: args.local ?? false, profile: args.profile })
  );
}

/**
 * After a replace whose `--static` publish FAILED: the frontends the replace
 * took down, which nothing now serves. Silent when nothing was serving.
 * Exported for `deploy --to`, which reaches the same state.
 */
export function noteStaticTakenDown(
  teardown: StaticTeardown | undefined,
  /** The publish's outcome is unknown: it may have landed, at a URL of its own (E2E pass 24). */
  unknown = false,
): void {
  if (teardown === undefined || teardown.urls.length === 0) return;
  const one = teardown.urls.length === 1;
  warn(
    `The replace took down the frontend${one ? "" : "s"} at ${teardown.urls.join(", ")}, and the publish ` +
      `that was to replace ${one ? "it" : "them"} ` +
      (unknown
        ? `may or may not have landed — at a URL of its own if it did; the retry prints where the frontend serves.`
        : `failed — nothing serves there until a publish succeeds.`) +
      (teardown.verified ? "" : " (Unverified: this project's record of its last publish there.)"),
    "static.teardown",
  );
}


/** What became of one frontend a failed replace warned about. */
export type FrontendAfterFailure = "serving" | "down" | "unknown";

/**
 * After a replace whose import FAILED: ask each frontend it warned about
 * whether it still serves.
 *
 * The static-host listing is not enough. A refused replace rolls the host ROW
 * back while the content its clear deleted stays deleted (E2E pass 18: the row
 * still listed a URL answering `404 NoSuchKey`), so a URL the listing names is
 * asked over HTTP. A URL the listing no longer names is down without asking;
 * one the listing could not be read for is asked all the same. A URL that gave
 * no answer is `unknown`, and nothing is claimed about it.
 */
export async function readFrontendsAfterFailure(
  auth: Pick<ResolvedAuth, "access_token">,
  target: { baseUrl: string; workspaceId: number },
  warned: readonly string[],
): Promise<Record<string, FrontendAfterFailure>> {
  const { live } = await readStaticTeardown(auth, target, undefined);
  const { probeFrontend } = await import("../deploy/verify-rollout.js");
  const states: Record<string, FrontendAfterFailure> = {};
  for (const url of warned) {
    states[url] = live !== undefined && !live.includes(url) ? "down" : await probeFrontend(url);
  }
  return states;
}

/**
 * The sentence for what a failed replace (refused, or its outcome unknown)
 * that published no `--static` left of the frontends it warned about, from
 * {@link readFrontendsAfterFailure}.
 *
 * Never inferred from the failure itself. The clear that opens a replace runs
 * before most of what can refuse the import, so a refused replace can still
 * have taken static hosting down — and stays down, since nothing republishes —
 * while one refused in the pre-flight left it serving. A frontend that could
 * not be asked is claimed neither way, and the reader is told how to check.
 *
 * `publish` is the command that brings a frontend back, as printed.
 */
export function staticAfterFailedReplace(
  warned: readonly string[],
  states: Readonly<Record<string, FrontendAfterFailure>>,
  opts: { unknown: boolean; publish: string },
): { text: string; down: readonly string[] } {
  const again = `ublish again with \`${opts.publish}\`, or re-run the deploy with \`--static <dir>\`.`;
  const remedy = `P${again}`;
  const head = opts.unknown ? "The import's outcome is unknown" : "The import was refused";
  const by = (s: FrontendAfterFailure): string[] => warned.filter((u) => (states[u] ?? "unknown") === s);
  const down = by("down");
  const unasked = by("unknown");
  const plural = (urls: readonly string[]): { s: string; it: string } =>
    urls.length === 1 ? { s: "", it: "it" } : { s: "s", it: "them" };
  // The check for a frontend that gave no answer: named, never assumed away.
  const unaskedText = (lead: string): string => {
    const p = plural(unasked);
    return (
      `${lead}the frontend${p.s} at ${unasked.join(", ")} could not be reached to check — the clear that opens ` +
      `a replace may already have taken ${p.it} down. Open ${p.it} to check; if nothing serves there: p${again}`
    );
  };
  if (down.length > 0) {
    const p = plural(down);
    const text =
      `${head}, but the clear that opens a replace already took the frontend${p.s} at ${down.join(", ")} ` +
      `down — nothing serves there now. ${remedy}` +
      (unasked.length > 0 ? ` ${unaskedText("And ")}` : "");
    return { text, down };
  }
  if (unasked.length > 0) return { text: unaskedText(`${head}, and `), down };
  const p = plural(warned);
  return {
    text: `${head}, and the frontend${p.s} at ${warned.join(", ")} still serve${p.s === "" ? "s" : ""}.`,
    down,
  };
}

/** Exit code for a post-commit static failure (the backend import itself succeeded). */
export const EXIT_STATIC_FAILED = 3;

/**
 * A `--static` upload whose answer was lost, with the check named: the shared
 * aftermath ("check before retrying") names none, and the check is the retry —
 * a publish replaces the host's build, so it settles the outcome either way and
 * prints the URL the frontend serves at. Shared by `deploy --static` and `deploy --to … --static`.
 */
export function unknownStaticOutcome(message: string, unknown: boolean): string {
  if (!unknown) return message;
  const said =
    "The upload was sent, so it may or may not have published. A publish replaces the host's build, so the " +
    "retry below settles it either way and prints the URL it serves at.";
  return message.includes(SENT_AFTERMATH) ? message.replace(SENT_AFTERMATH, said) : `${message}\n${said}`;
}
