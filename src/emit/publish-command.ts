/**
 * `xanosdk publish <dir>` — put an already-built frontend on a static host, and
 * nothing else.
 *
 * `deploy --static` publishes a frontend as the tail of a backend deploy, and a
 * promote leaves static hosting alone. Neither can answer "the backend for
 * release X is live; now put X's frontend in front of it", and neither can
 * retry a frontend that failed after its backend already landed without
 * re-importing that backend. This is that step on its own: no compile, no
 * import, no backend write of any kind.
 *
 * ## One build, many destinations
 *
 * The destination's own base URL is injected as `window.XANO_HOST` at publish
 * time, merged under any `--static-env`. So a byte-identical build published to
 * an ephemeral and to the workspace serves two DIFFERENT documents — which is
 * the point (build once, configure per destination), not drift.
 *
 * ## What `--release` and `--branch` can and cannot prove
 *
 * A release carries no frontend, and no destination records which release it
 * serves. So the pairing is checked as far as the platform can see and REPORTED
 * at that strength rather than implied:
 *
 * - `--release` proves the release exists in this workspace. Nothing more.
 * - `--branch` proves that label is the one the workspace is serving right now,
 *   and refuses to publish when it is not — the frontend would otherwise sit in
 *   front of a backend it was not built for. It compares LABELS; it does not
 *   compare what is on the branch with what is in the release.
 *
 * ## What it does not check
 *
 * `deploy --static` scans the build for non-public seed values before it
 * publishes, because it holds the seed rows it is about to import. A publish
 * compiles nothing and holds no rows, so it cannot, and says so.
 *
 * Node-only and lazily imported so the browser-safe authoring bundle stays clean.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ParsedArgs } from "./cli.js";
import { suggest } from "../util/suggest.js";
import { getAccessToken } from "../auth/token.js";
import { LocalFileNotFoundError, statesOutcomeUnknown, UsageError } from "./errors.js";
import { isMachineOutput, writeJson, type JsonWarning } from "./output.js";
import { confirm } from "./prompt.js";
import { yesRerun } from "./retry-command.js";
import {
  detail,
  step,
  info,
  warn,
  credentialWriteTarget,
  discloseWriteTarget,
  writeTargetPayload,
  backendDestinationPayload,
  type WriteTarget,
} from "./ui.js";
import { getEnvironment, readEphemeralState, recordStaticUrl } from "../deploy/ephemeral-state.js";
import { actualKind, describeBackend, resolveSource, SourceError, type CredentialProvider } from "./source-resolve.js";
import { requireBackendSlot } from "./backend-slot.js";
import { isRealDeployment, memoCredential, selectBackend } from "./tracked-backend.js";
import { findRelease } from "../deploy/release.js";
import { contextFlags } from "./context-flags.js";
import { pipedYes } from "./retry-command.js";
import { withArticle } from "../util/article.js";
import { listBranches, liveBranchLabel } from "../deploy/branch.js";
import {
  buildStaticEnv,
  deployStaticTo,
  retryCommand,
  warnSecretLookingStaticEnv,
  withheldNote,
  type StaticEnvReport,
} from "./deploy-command.js";
import { EXIT_OUTCOME_UNKNOWN } from "./operation-registry.js";
import { SENT_AFTERMATH } from "../util/http.js";
import { shellQuote } from "../util/shell-quote.js";

const HELP = { helpFor: { command: "publish" } } as const;
/** A refusal of the situation, not the invocation: the message names the fix, so one pointer line, no block. */
const HINT = { hintFor: { command: "publish" } } as const;

/**
 * A directory beside the missing `dir` whose name is one slip from its last
 * segment, spelled with the prefix as typed (`./frontend/dsit` → `./frontend/dist`).
 */
function nearSiblingDir(dir: string): string | undefined {
  const trimmed = dir.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const prefix = trimmed.slice(0, cut + 1);
  const last = trimmed.slice(cut + 1);
  if (last === "" || last === "." || last === "..") return undefined;
  let names: string[];
  try {
    names = readdirSync(prefix === "" ? "." : prefix, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return undefined;
  }
  const near = suggest(last, names);
  return near === undefined ? undefined : `${prefix}${near}`;
}

/**
 * How strongly this publish is tied to a release, as a reader of `--json` needs
 * it said: by what was actually checked, not by what the caller asserted.
 *
 * - `none` — no `--release`; the publish claims no pairing.
 * - `release-exists` — the release was found, and that is all that was checked.
 * - `live-branch` — the release was found AND `--branch` is the label the
 *   workspace serves. Still a label match, not a content comparison.
 */
export type ReleaseAssociation = "none" | "release-exists" | "live-branch";

/** Whether the edge was seen serving this build, or why that is unknown. */
export type RolloutVerification = "live" | "unconfirmed" | "skipped";

export interface PublishSummary {
  verb: "publish";
  /**
   * Where the build went, in the shape `deploy` and `tenant deploy` report:
   * `instance` and `workspaceId` are the credential's (the parent an ephemeral
   * or tenant lives under — what a wrapper compares against its configured
   * instance), `kind` says which backend, and `url` is an ephemeral's or
   * tenant's own base. The static site's address is the top-level `url`.
   */
  destination: ReturnType<typeof writeTargetPayload> & { url?: string; display?: string };
  release?: { instance: string; workspaceId: number; id: number | undefined; name: string };
  branch?: { expected: string; live: string };
  association: ReleaseAssociation;
  /** False only on a declined confirmation (`declined: true`): a failed upload throws. */
  published: boolean;
  /**
   * True when the confirmation was answered no: nothing was uploaded, and the
   * run exits 0. Always present, so the document has one shape either way.
   */
  declined: boolean;
  /** True only when the edge served this build's canonical inside the wait window. */
  verified: boolean;
  verification: RolloutVerification;
  url: string | undefined;
  canonical?: string;
  /** The routing shape the build was declared with — inferred, or `--static-routing`. Absent on a declined publish. */
  routing?: "spa" | "multipage";
  /**
   * Whether the `window.*` config (`XANO_HOST` and every `--static-env` key)
   * reached the build's HTML — `deploy --static`'s field, the same shape.
   * Absent on a declined publish and when there was no config to inject.
   */
  staticEnv?: StaticEnvReport;
  /**
   * Every warning the run printed, which did not stop it — a `--static-env` key
   * that looks like a secret (`static-env.secret-like`), an `index.html` that
   * loads TypeScript/JSX source (`publish.unbuilt-source`). Merged in by the
   * run's collector; absent when there are none.
   */
  warnings?: JsonWarning[];
}

/**
 * Refuse a build the static host cannot serve, before signing in or uploading
 * anything, in publish's own words. An empty directory has nothing to upload,
 * and one with no `index.html` at its root has no entry page: the host takes
 * the upload and then fails the rollout, after the bytes are already sent.
 * Almost always the wrong directory — the project root instead of its build
 * output — so the message says that.
 */
function assertPublishableBuild(dir: string): void {
  if (readdirSync(dir).length === 0) {
    throw new UsageError(
      `"${dir}" is empty, so there is nothing to publish. Run your build first (\`npm run build\`), ` +
        `or point publish at the directory the build writes to.`,
      HINT,
    );
  }
  let hasIndex: boolean;
  try {
    hasIndex = statSync(join(dir, "index.html")).isFile();
  } catch {
    hasIndex = false;
  }
  if (!hasIndex) {
    throw new UsageError(
      `"${dir}" has no index.html at its root, so the static host would have no entry page. ` +
        `Point publish at the build output directory — the one that holds index.html ` +
        `(e.g. \`xanosdk publish ./frontend/dist\`). Nothing was uploaded.`,
      HINT,
    );
  }
}

/** A module script a browser cannot execute: TypeScript or JSX source, by extension. */
const SOURCE_SCRIPT = /\.(?:tsx?|jsx|mts|cts)$/i;

/**
 * Does this look like the SOURCE directory rather than the build output? A
 * Vite project's root `index.html` loads `/src/main.tsx`, which the dev server
 * compiles on the fly and a static host serves as-is — the browser refuses it
 * and the page stays blank. Published anyway (it is a real `index.html`, and a
 * hand-written page may be exactly this), but said, with the build step.
 */
function unbuiltSourceWarning(dir: string): string | undefined {
  let html: string;
  try {
    html = readFileSync(join(dir, "index.html"), "utf8");
  } catch {
    return undefined;
  }
  for (const tag of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
    const path = (src?.[1] ?? src?.[2] ?? src?.[3] ?? "").split(/[?#]/)[0]!;
    if (!SOURCE_SCRIPT.test(path)) continue;
    return (
      `${join(dir, "index.html")} loads ${path}, TypeScript/JSX source a browser cannot run — this looks like the ` +
      `frontend's source directory, not its build. Build it first (\`npm run build\`) and publish the output, ` +
      `e.g. \`xanosdk publish ${join(dir, "dist")}\`.`
    );
  }
  return undefined;
}

export async function runPublishCommand(args: ParsedArgs): Promise<void> {
  const dir = args.positionals[0];
  if (dir === undefined || dir === "") {
    throw new UsageError(
      "`xanosdk publish` needs the directory of a built frontend, e.g. `xanosdk publish ./frontend/dist`. " +
        "Build it first — publish compiles nothing.",
      HELP,
    );
  }
  // Before auth: a missing build is the likeliest mistake (the build step was
  // skipped), and "not signed in" would answer the wrong question.
  let kind: "dir" | "file" | "none";
  try {
    kind = statSync(dir).isDirectory() ? "dir" : "file";
  } catch {
    kind = "none";
  }
  // A file is not a missing build: "run your build first" would send the reader
  // to rebuild something that is already there, at the wrong path.
  if (kind === "file") {
    throw new UsageError(
      `"${dir}" is a file, and publish takes the DIRECTORY of a built frontend (the folder holding ` +
        `index.html, e.g. \`./frontend/dist\`).`,
      HINT,
    );
  }
  if (kind === "none") {
    // A missing local input: a usage failure, exit 1, as every one.
    // A directory one slip from the one typed (`dsit` for `dist`) is named —
    // likelier than a build never run (E2E pass 28).
    const near = nearSiblingDir(dir);
    throw new LocalFileNotFoundError(
      near === undefined
        ? `No built frontend at "${dir}". Run your build first (\`npm run build\`) — publish ships what is on disk and compiles nothing.`
        : `No built frontend at "${dir}" — nothing is there, but "${near}" is: \`xanosdk publish ${shellQuote(near)}\`.`,
      { ...HINT, ...(near === undefined ? {} : { suggestion: near }) },
    );
  }
  // Before auth, like the directory checks: a secret-looking pair is worth
  // saying whatever happens next — it is published with the build. Every
  // warning printed is carried in the `--json` document too — a success's
  // `warnings[]`, a failure's `error.details.warnings` — by the run's collector.
  warnSecretLookingStaticEnv(args.staticEnv);
  // `--to`, or bare: the backend this project last deployed to, through the one
  // tracked-backend resolver. The slot refuses a local engine with its reason
  // (a local engine takes its frontend from `deploy --local-engine --static`)
  // whether it was typed or came from the pointer, so a bare
  // publish after a local deploy says so instead of uploading somewhere else.
  const slot = requireBackendSlot("publish", undefined, "to");
  // Credential resolution's own warnings (no project pin, a shadowed global
  // credential) are printed as `!` like the rest, so they are carried too.
  const credential = memoCredential(() => getAccessToken(args));
  const dest = await selectBackend(slot, args.to, { credential });
  // After the destination parses — a `--to` it cannot take is the more basic
  // mistake — and before anything is uploaded.
  assertPublishableBuild(dir);
  const unbuilt = unbuiltSourceWarning(dir);
  if (unbuilt !== undefined) {
    warn(unbuilt, "publish.unbuilt-source");
  }
  await publishChecked(args, dir, dest, credential);
}

/**
 * An upload whose answer was lost, with the check named. The shared aftermath
 * ("check before retrying") names none, and for a publish the check IS the
 * retry: a publish replaces the host's build, so running the same command again
 * is safe and settles the outcome either way. Exits 9 (outcome unknown), as
 * `deploy --static`'s lost upload does. Anything else passes through.
 */
/** This publish again, as the reader re-runs it: what settles a sent upload either way. */
function publishRerun(args: ParsedArgs, dir: string): { command: string; withheld: readonly string[] } {
  return args.argv === undefined ? { command: `xanosdk publish ${shellQuote(dir)}${contextFlags(args)}`, withheld: [] } : retryCommand(args);
}

function uploadOutcomeUnknown(err: unknown, args: ParsedArgs, dir: string): unknown {
  if (!(err instanceof Error) || !statesOutcomeUnknown(err.message)) return err;
  const retry = publishRerun(args, dir);
  const said =
    `The upload was sent, so it may or may not have published. A publish replaces the host's build, so running ` +
    `the same publish again is safe and settles it either way: \`${retry.command}\`.${withheldNote(retry.withheld)}`;
  err.message = err.message.includes(SENT_AFTERMATH) ? err.message.replace(SENT_AFTERMATH, said) : `${err.message}\n${said}`;
  (err as Error & { exitCode?: number }).exitCode = EXIT_OUTCOME_UNKNOWN;
  return err;
}

/** Everything after the build checks that produce warnings: resolve, confirm, upload, report. */
async function publishChecked(
  args: ParsedArgs,
  dir: string,
  dest: Awaited<ReturnType<typeof selectBackend>>,
  credential: CredentialProvider,
): Promise<void> {
  // The upload cap too, before the prompt and the upload: a build over it can
  // never be published, so a confirmation for it would be asked for nothing.
  {
    const { assertStaticDir, StaticDirError } = await import("../deploy/static-host.js");
    try {
      assertStaticDir(dir);
    } catch (err) {
      if (err instanceof StaticDirError) throw new UsageError(`${err.message} Nothing was uploaded.`, HINT);
      throw err;
    }
  }
  if (dest.kind !== "workspace" && dest.kind !== "ephemeral" && dest.kind !== "tenant") {
    throw new Error(`Internal: \`publish --to\` selected ${withArticle(dest.kind)}, which its slot does not accept.`);
  }

  // Only the workspace has a live branch to compare against: an environment or
  // a tenant serves one backend, with no label a caller could name. Refused
  // rather than skipped, so a check the caller asked for is never reported as
  // passed by omission.
  if (args.branch !== undefined && dest.kind !== "workspace") {
    // A bare publish goes to the TRACKED ephemeral: naming `--to ephemeral`
    // there named a flag nobody passed.
    let where = `\`--to ${args.to}\``;
    if (args.to === undefined) {
      // The selector already needed the credential to pick the tracked
      // ephemeral, so reading its name here costs nothing more.
      const tracked = dest.kind === "ephemeral" ? getEnvironment(readEphemeralState(process.cwd()), await credential()) : undefined;
      where = `this publish goes to the tracked ephemeral${tracked === undefined ? "" : ` "${tracked.name}"`}, which`;
    }
    throw new UsageError(
      `\`--branch\` checks which branch your workspace is serving, and ${where} has no branches to check. ` +
        `\`--branch\` applies to \`--to workspace\`: drop it, or publish with \`--to workspace\`.`,
      HINT,
    );
  }

  const auth = await credential();
  const resolved = await resolveSource(dest, credential, { workspaceless: "write" });
  const { base, workspaceId } = resolved.target;
  // What the target IS, not how it was spelled: `--to tenant:<name>` can name
  // an ephemeral, which is disposable and prompts for nothing.
  const destKind = actualKind(resolved);
  // `ephemeral "e4f2-…" ("My App")`, `tenant "eu"`, `your workspace`.
  const named = describeBackend(resolved);
  // The credential's own workspace is named by the credential; anything else
  // carries its label so the disclosure says which environment or tenant.
  // Either way the machine payload carries the kind (R11).
  const destination: WriteTarget =
    dest.kind === "workspace"
      ? { ...credentialWriteTarget(auth), kind: dest.kind }
      : { base, workspaceId, label: named, kind: dest.kind };

  let release: PublishSummary["release"];
  if (args.release !== undefined) {
    const found = await findRelease(auth, { workspaceId: auth.workspaceId, name: args.release });
    if (found === null) {
      // Not-found, exit 8 — what `release show <missing>` answers. The command
      // was typed correctly; the workspace holds no such release.
      throw new SourceError(
        `No release named "${args.release}". \`xanosdk release list${contextFlags(args)}\` shows the ones that exist. Nothing was published.`,
        "gone",
        "release",
      );
    }
    release = { instance: auth.instance, workspaceId: auth.workspaceId, id: found.id, name: found.name };
  }

  // Not `assertUsableBranchLabel`: that guards a label about to be WRITTEN to,
  // and refuses the default one. This only reads which label is live, and the
  // default is very often the answer.
  let branch: PublishSummary["branch"];
  if (args.branch !== undefined) {
    const branches = await listBranches(auth, { baseUrl: base, workspaceId });
    const live = liveBranchLabel(branches);
    if (live !== args.branch) {
      // Nothing is published: the frontend would reach traffic in front of a
      // backend it was not built against, and that is the failure this flag
      // exists to catch rather than to report afterwards.
      throw new Error(
        `Branch "${args.branch}" is not live — ${live === undefined ? "no branch reports as live" : `"${live}" is`}. ` +
          `Nothing was published.\n` +
          `Make it live first (\`xanosdk workspace branch set-live ${args.branch}${pipedYes(args)}${contextFlags(args)}\`), then publish again.`,
      );
    }
    branch = { expected: args.branch, live };
  }

  const association: ReleaseAssociation =
    release === undefined ? "none" : branch === undefined ? "release-exists" : "live-branch";

  // Headline first, then where it lands — the order `deploy --to`, `tenant
  // deploy` and `promote` print in. The disclosure alone used to open the
  // output, reading as the tail of whatever the terminal showed before.
  step(`Publishing ${dir} → ${named}${args.staticHost !== undefined ? ` (host: ${args.staticHost})` : ""}`);
  // The host line only: the headline already named the target, display name
  // and all, and saying it again under itself is noise.
  discloseWriteTarget({ ...destination, label: undefined });

  // The one destination shape (`backendDestinationPayload`): the parent's
  // instance and workspace, the target's actual kind, its bare name, its URL,
  // and the name people call it.
  const destinationPayload: PublishSummary["destination"] =
    dest.kind === "workspace"
      ? writeTargetPayload(destination)
      : backendDestinationPayload(auth, {
          kind: destKind === "ephemeral" ? "ephemeral" : "tenant",
          name: resolved.target.label,
          url: base,
          // Only when it says something the name does not.
          ...(resolved.target.display !== undefined && resolved.target.display !== resolved.target.label
            ? { display: resolved.target.display }
            : {}),
        });

  // An ephemeral is disposable and `deploy` replaces its frontend without asking;
  // a workspace or tenant frontend is what real users are served. The one
  // predicate decides, so every verb prompts for the same kinds.
  if (isRealDeployment(destKind) && args.yes !== true) {
    // Asked by what it will do, read from the platform: "replace the frontend
    // served by …" about a host that serves none asked about one that does not
    // exist. An unread answer keeps the replace wording — the careful one.
    const { listServingStaticHosts } = await import("../deploy/static-host.js");
    const host = args.staticHost ?? "default";
    const servesNone = await listServingStaticHosts({ baseUrl: base, workspaceId, accessToken: auth.access_token }).then(
      (serving) => !serving.some((s) => s.host === host),
      () => false,
    );
    const ok = await confirm(
      servesNone
        ? `Publish a frontend to ${named} (it has none yet) from ${dir}?`
        : `Replace the frontend served by ${named} with ${dir}?`,
      { flag: "--yes", refusal: { details: { uploaded: false }, ...yesRerun(args, "publish") } },
    );
    if (!ok) {
      info("Publish cancelled — nothing was uploaded.");
      // A decline answers `--json` too, exit 0: the caller asked a question and
      // is owed a document saying the answer was no, not an empty stdout.
      if (isMachineOutput(args)) {
        const declined: PublishSummary = {
          verb: "publish",
          destination: destinationPayload,
          ...(release !== undefined ? { release } : {}),
          ...(branch !== undefined ? { branch } : {}),
          association,
          published: false,
          declined: true,
          verified: false,
          verification: "skipped",
          url: undefined,
        };
        writeJson(declined);
      }
      return;
    }
  }

  const env = buildStaticEnv(base, args.staticEnv);
  const published = await deployStaticTo(
    dir,
    auth,
    { baseUrl: base, workspaceId, label: destination.label, announced: true },
    env,
    Object.keys(args.staticEnv).length > 0,
    args.staticHost,
    args.skipLiveness,
    args.staticRouting,
    undefined,
    { rerun: publishRerun(args, dir).command },
  ).catch((err: unknown) => {
    throw uploadOutcomeUnknown(err, args, dir);
  });

  // A publish into the tracked ephemeral is the next publish `static_down`
  // waits for: without clearing it, a later replace that takes this frontend
  // down again would not say so.
  if (destKind === "ephemeral" && published.url !== undefined) {
    const tracked = getEnvironment(readEphemeralState(process.cwd()), auth);
    if (tracked?.name === resolved.target.label) recordStaticUrl(process.cwd(), auth, published.url);
  }

  const verification: RolloutVerification =
    published.verified === undefined ? "skipped" : published.verified ? "live" : "unconfirmed";

  if (isMachineOutput(args)) {
    const summary: PublishSummary = {
      verb: "publish",
      destination: destinationPayload,
      ...(release !== undefined ? { release } : {}),
      ...(branch !== undefined ? { branch } : {}),
      association,
      published: true,
      declined: false,
      verified: verification === "live",
      verification,
      url: published.url,
      ...(published.canonical !== undefined ? { canonical: published.canonical } : {}),
      ...(published.routing !== undefined ? { routing: published.routing } : {}),
      ...(published.staticEnv !== undefined ? { staticEnv: published.staticEnv } : {}),
    };
    writeJson(summary);
    return;
  }

  if (release !== undefined) {
    detail(
      branch !== undefined
        ? `For release ${release.name}, in front of live branch "${branch.live}" — the label matches; the branch's contents were not compared with the release.`
        : `For release ${release.name} — the release exists; which backend is serving was not checked (\`--branch\` checks it on your workspace).`,
    );
  }
  detail("Not scanned for non-public seed values — publish holds no seed rows. `deploy --static` runs that scan.");
}
