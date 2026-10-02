/**
 * The credential this run's last `getAccessToken` resolved, and the arguments
 * it was resolved from — held for one reader: the CLI, which names the fix for
 * it when an instance answers 401. Never printed itself; the remedy names where
 * the token came from, never its value.
 *
 * Carried by async context, one record per `run()`: two runs in one process (a
 * test driving `run()` concurrently, an embedder) would otherwise name each
 * other's credential in a refusal, or none when the other run ended first.
 * Outside a run nothing is recorded.
 *
 * Its own module, importing nothing, so a test that mocks `auth/token.ts`
 * leaves it intact rather than taking the run's clean-up with it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ResolvedAuth } from "../auth/token.js";
import type { ParsedArgs } from "../emit/cli.js";

interface Resolved {
  auth: ResolvedAuth;
  args: ParsedArgs;
}

interface RunState {
  last?: Resolved;
  /** The pinned workspace answered 404, or 500, to a meta request this run made. */
  workspaceMiss?: boolean;
}

const runScope = new AsyncLocalStorage<RunState>();

/** Run `fn` as one run with its own record of the credential it acts as. */
export function inCredentialScope<T>(fn: () => T): T {
  return runScope.run({}, fn);
}

/** Record the credential a run acts as, and the arguments that chose it. */
export function noteResolvedAuth(auth: ResolvedAuth, args: ParsedArgs): void {
  const state = runScope.getStore();
  if (state !== undefined) state.last = { auth, args };
}

/** The credential this run acts as, once one was resolved, with the arguments that chose it. */
export function lastResolvedAuth(): Resolved | undefined {
  return runScope.getStore()?.last;
}

/**
 * Note one meta API answer. A 404 or 500 to a request addressing the
 * credential's own pinned workspace, on its own instance, that says "Invalid
 * workspace" or nothing at all (the platform's bare not-found) may mean the pinned id is one the credential
 * cannot see — every route under it then fails that way, and a caller may
 * have turned it into a "not found" for whatever the route names. The CLI
 * checks the workspace list once, on failure only, before it reports the
 * run's error. Reads a clone of the body, so the caller's is untouched. Never
 * throws.
 */
export async function noteMetaAnswer(url: string, res: Response): Promise<void> {
  if (res.status !== 404 && res.status !== 500) return;
  const state = runScope.getStore();
  const auth = state?.last?.auth;
  if (state === undefined || auth === undefined || state.workspaceMiss === true) return;
  try {
    const at = new URL(url);
    if (at.origin !== new URL(auth.instance).origin) return;
    const id = /^\/api:meta\/workspace\/(\d+)(?:\/|$)/.exec(at.pathname)?.[1];
    if (id === undefined || Number(id) !== auth.workspaceId) return;
    const text = await res.clone().text();
    let said = text.trim();
    try {
      const message = (JSON.parse(said) as { message?: unknown }).message;
      said = typeof message === "string" ? message.trim() : "";
    } catch {
      // Not JSON: the text is what it said.
    }
    if (said === "" || /^invalid workspace\.?$/i.test(said)) state.workspaceMiss = true;
  } catch {
    // An unparseable URL addresses no workspace, and an unreadable body says nothing.
  }
}

/** Whether this run's pinned workspace answered a meta request 404 or 500 — see {@link noteMetaAnswer}. */
export function pinnedWorkspaceMissed(): boolean {
  return runScope.getStore()?.workspaceMiss === true;
}
