/**
 * Installing one package with npm, including the retry npm's peer resolution
 * makes necessary.
 *
 * ── Why this is not in `npm.ts` ─────────────────────────────────────────────
 *
 * `npm.ts` is the thin layer over the process spawn: it finds the binary,
 * quotes the arguments, runs it, and captures what came back. Nothing in it
 * decides anything.
 *
 * This ORCHESTRATES those primitives — two attempts and a rule for when the
 * second one happens — which makes it a different kind of thing, and the
 * separation is load-bearing rather than tidy. A caller's test mocks the
 * RUNNER to drive a failing install; with the orchestration living in the same
 * module as the runner, its calls would not cross a module boundary and the
 * mock could not intercept them, so the retry would silently run the real npm.
 * Keeping the two apart is what keeps the failure paths testable.
 *
 * Node-only; reached from the two installers.
 */

import { isPeerConflict, runNpmQuiet, NPM_RUN_TIMEOUT_MS, type NpmRunOutput } from "./npm.js";
import { addArgs, type PackageManager } from "./package-manager.js";

/** What an install attempt did, including whether a peer conflict forced a retry. */
export interface PeerRetryResult extends NpmRunOutput {
  /**
   * The FIRST attempt's output, when a peer conflict forced the retry — null
   * when the install needed no retry.
   *
   * Kept rather than discarded because it is the only record of what npm
   * refused. A retry that SUCCEEDS installed a tree npm deliberately declined,
   * and a retry that FAILS may fail for some second reason that never mentions
   * peers — so in both directions the fact that explains the episode is in the
   * first attempt's output, not the last one's.
   */
  readonly peerConflict: string | null;
  /**
   * Whether the `--legacy-peer-deps` attempt actually ran.
   *
   * `peerConflict` alone cannot say. It is set whenever npm refused over a peer
   * range, including when the shared budget was already spent and there was no
   * time to retry — and a caller reading it as "we retried" then tells the user
   * `--legacy-peer-deps did not resolve it either` about a command that was
   * never run.
   */
  readonly retried: boolean;
}

/**
 * `npm install <specifier>`, retried once with `--legacy-peer-deps` when npm
 * refused over a peer range. Several specifiers (a toolchain module's peers)
 * are added in ONE run, with the same retry and the same budget.
 *
 * Shared because both installers need it and only one had it. Every module
 * published today peers on `@xano/sdk` with a range that names no
 * prerelease, and npm excludes prereleases from those — so a PRERELEASE CLI
 * fails every module install for a reason that has nothing to do with the
 * module or with what the user asked for.
 *
 * Retried rather than pre-empted with the flag on the first attempt, because
 * `--legacy-peer-deps` up front would also hide a genuine incompatibility, and
 * that is worth reporting. What each caller does with {@link
 * PeerRetryResult.peerConflict} is the caller's — this function neither prints
 * nor decides fatality, like the runner it is built on.
 *
 * `onRetry` fires between the two attempts, for a caller with a live spinner to
 * relabel; a warning written there would be erased by the next frame.
 */
export async function installWithPeerRetry(
  spec: string | readonly string[],
  cwd: string,
  opts: InstallOptions = {},
): Promise<PeerRetryResult> {
  const specs = typeof spec === "string" ? [spec] : spec;
  const scope = opts.scope ?? [];
  // pnpm, yarn and bun add the package their own way and warn on a peer range
  // rather than refuse it, so there is nothing to retry.
  if (opts.manager !== undefined && opts.manager !== "npm") {
    const only = await runNpmQuiet([...addArgs(opts.manager, specs), ...scope], cwd, { manager: opts.manager, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
    return { ...only, peerConflict: null, retried: false };
  }
  // ONE budget for the episode, not one per attempt. Two calls each given the
  // full timeout is two timeouts, so a stalled registry would hold the command
  // for twice as long as the number anyone configured — and the second attempt
  // is a RETRY of the first, not a new request the user asked for. The retry
  // gets whatever is left.
  const budget = opts.timeoutMs ?? NPM_RUN_TIMEOUT_MS;
  const deadline = Date.now() + budget;

  const first = await runNpmQuiet(["install", ...specs, ...scope], cwd, { timeoutMs: budget });
  if (first.status === 0 || !isPeerConflict(first.output)) {
    return { ...first, peerConflict: null, retried: false };
  }

  // Nothing left to retry inside. Report the peer conflict as the failure it
  // is rather than spending a second budget to arrive at the same place.
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { ...first, peerConflict: first.output, retried: false };

  opts.onRetry?.();
  const second = await runNpmQuiet(["install", ...specs, ...scope, "--legacy-peer-deps"], cwd, {
    timeoutMs: remaining,
  });
  return { ...second, peerConflict: first.output, retried: true };
}

/** How {@link installWithPeerRetry} runs. */
export interface InstallOptions {
  readonly onRetry?: () => void;
  readonly timeoutMs?: number;
  readonly manager?: PackageManager;
  /** Arguments that aim the add at the project (`-w <member>`, `--ignore-workspace`); see `installSite`. */
  readonly scope?: readonly string[];
}
