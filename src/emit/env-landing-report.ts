/**
 * What a release will do to a destination's env vars, said before it lands.
 *
 * A release import merges env ADD-ONLY and BY NAME: a name the destination
 * already holds keeps the destination's value, so one release promotes to
 * several environments without carrying the credentials it was cut with.
 *
 * The gap is a name the release's objects READ that the destination does not
 * hold. Measured: a release stores no env values (its archive's env list is
 * empty, whether it was cut from an ephemeral or a workspace), so such a name
 * is not created by the landing at all — the objects read it as null there
 * until someone sets it, and nothing in the result says so. This names exactly
 * that set, before the confirmation, with the command that sets each one. A
 * release that does carry a value for a missing name is said apart: that one
 * is created with the cut's value.
 *
 * Best effort by construction: this is a courtesy on top of a valid operation,
 * so every failure degrades to one line and the landing proceeds.
 *
 * NAMES only. Values are never read out of either side, never compared aloud,
 * and never printed.
 */
import type { ResolvedAuth } from "../auth/token.js";
import { downloadRelease } from "../deploy/release.js";
import { exportWorkspaceBundle, type ExportedBundle } from "../deploy/workspace-export.js";
import { envValuesOf } from "../deploy/live-diff.js";
import { decodeWorkspaceArchive } from "../validate/archive.js";
import { detail, warn, withoutUrls } from "./ui.js";
import { safeNames } from "./workspace-env.js";
import { envNamesRead } from "../workspace/guards.js";
import { shellQuote } from "../util/shell-quote.js";

/** Where something lives on an instance: base URL plus workspace. */
interface MetaTarget {
  readonly base: string;
  readonly workspaceId: number;
}

export async function reportEnvLanding(
  auth: ResolvedAuth,
  opts: {
    /** The release about to land, and the workspace hosting it. */
    readonly release: { readonly id: number | undefined; readonly name: string };
    readonly releaseHost: MetaTarget;
    /** The DESTINATION whose env set is about to be merged into. */
    readonly target: MetaTarget;
    /** How the destination reads in output — "your workspace", `tenant "prod"`. */
    readonly targetLabel: string;
    /**
     * How `env set` names the destination, and what it needs to run as printed:
     * `--to workspace --yes`, `--to tenant:prod --yes`, `--to ephemeral:x`, with
     * this run's credential flags.
     */
    readonly envSetTo: string;
    /**
     * Where the decoded release archive comes from, when the caller already has
     * a way to get it.
     *
     * A promote reads the SAME archive again after landing, to check what
     * arrived, so without this the bytes are fetched and decoded twice in one
     * command. Passing a shared loader lets the two share one download while
     * leaving this path's best-effort posture intact: a loader that throws is
     * caught below exactly as an inline download would be.
     *
     * Omitted, this downloads the archive itself, which is what the callers
     * that read it only once do.
     */
    readonly loadArchive?: () => Promise<unknown>;
    /** The destination's export, when the caller reads it too (its table check); omitted, this reads it. */
    readonly loadLive?: () => Promise<ExportedBundle>;
  },
): Promise<void> {
  // The archive is addressed by id. A summary that carries none cannot be
  // downloaded, so there is nothing to compare — and a courtesy is not worth an
  // error about its own inputs.
  if (opts.release.id === undefined) return;
  try {
    // The release FIRST. A release that reads no env and carries none can
    // leave nothing unset — the common case for a workspace that does not use
    // env vars at all — and short-circuiting saves the destination export.
    const archive =
      opts.loadArchive !== undefined
        ? await opts.loadArchive()
        : decodeWorkspaceArchive(
            await downloadRelease(auth, {
              workspaceId: opts.releaseHost.workspaceId,
              id: opts.release.id,
              base: opts.releaseHost.base,
            }),
          );
    const releaseEnv = envValuesOf(archive);
    const read = envNamesRead(payloadSections(archive));
    const named = [...new Set([...releaseEnv.keys(), ...read])];
    if (named.length === 0) return;

    const live =
      opts.loadLive !== undefined
        ? await opts.loadLive()
        : await exportWorkspaceBundle(auth, {
            base: opts.target.base,
            workspaceId: opts.target.workspaceId,
            label: `reading ${opts.targetLabel}`,
            // This reads a destination someone keeps. A failure here must not echo a
            // response body, for the same reason `env pull` must not.
            safeErrors: true,
          });
    const destination = envValuesOf(live);
    const missing = named.filter((name) => !destination.has(name));

    const created = missing.filter((name) => releaseEnv.has(name));
    if (created.length > 0) {
      warn(
        `${created.length} env var${created.length === 1 ? "" : "s"} in "${opts.release.name}" ${created.length === 1 ? "is" : "are"} NOT set on ${opts.targetLabel} ` +
          `and will be CREATED carrying the value the release was cut with: ${safeNames(created)}.`,
        "release.env-created",
        [
          `Every other name keeps ${opts.targetLabel}'s own value — a release merge is add-only by name.`,
          `Set these on the destination first if they should differ there.`,
        ],
      );
    }
    const unset = missing.filter((name) => !releaseEnv.has(name));
    if (unset.length > 0) {
      const one = unset.length === 1;
      warn(
        `Release "${opts.release.name}" reads ${unset.length} env var${one ? "" : "s"} ${opts.targetLabel} doesn't set: ` +
          `${safeNames(unset)}. A release carries no env values, so ${one ? "it reads" : "they read"} as null there until set — run:`,
        "release.env-unset",
        unset.map((name) => `printf %s "$VALUE" | xanosdk env set ${shellQuote(name)}${opts.envSetTo}`),
      );
    }
  } catch (err) {
    // A courtesy that cannot run is a courtesy that cannot run. Never a refusal:
    // the promote itself is valid and this check is not what authorizes it.
    //
    // The message is SCRUBBED of anything URL-shaped before it is printed. One
    // of the two calls this wraps fetches the release archive from a signed
    // storage link — a credential carrying its own signature in the query
    // string — and while the transport that fetches it is careful never to name
    // it, this line is where a future one that was not careful would surface.
    // A reader loses nothing: which check could not run is the actionable half,
    // and the URL was never it.
    detail(
      `Could not check which env vars this release reads that the destination lacks ` +
        // Its first line only: a transport error's own aftermath ("Nothing was
      // changed — retry.") speaks for a read, not for the command going on.
      `(${withoutUrls(((err instanceof Error ? err.message : String(err)).trim().split("\n")[0] ?? "").replace(/[.:]$/, ""))}).`,
    );
  }
}

/** The decoded archive's object arrays, keyed as the payload keys them. */
function payloadSections(archive: unknown): Record<string, unknown[]> {
  const payload = (archive as { payload?: unknown } | null)?.payload;
  const out: Record<string, unknown[]> = {};
  if (payload === null || typeof payload !== "object") return out;
  for (const [key, value] of Object.entries(payload)) if (Array.isArray(value)) out[key] = value;
  return out;
}

