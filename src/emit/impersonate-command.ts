/**
 * `xanosdk impersonate [backend]` — open a backend's dashboard in the Xano
 * builder, for every kind.
 *
 * It was once three copies under `ephemeral`, `tenant` and `local`, each
 * with its own output shape. One verb with the selector grammar gives them one
 * shape and a tracked default: bare opens what the project last deployed to.
 *
 * **Per kind, the session comes from a different place.**
 *
 * - An ephemeral and a tenant — one primitive on the server — mint a one-time
 *   token through the tenant impersonation call, and the url is built from it
 *   under the instance origin, where the builder exchanges it for a session.
 * - A Xano Engine mints through its own loopback login-link endpoint with the
 *   bearer from its enumeration, and the url is the one the ENGINE returns: it
 *   knows where its own builder lives. No Xano credential is read.
 * - The workspace is refused by the slot: it is the account's own workspace,
 *   opened from the Xano dashboard as whoever is signed in there, so there is
 *   no session to mint and nothing this verb adds.
 *
 * **One JSON shape: `{ kind, name, display, url, guest }`.** The url carries the session token where
 * one was minted, so it is a credential and is written only on this channel or
 * handed to a browser. The bare token the per-noun verbs printed beside it is
 * gone: it was redundant with the url and was an owner session sitting in a
 * field a CI log keeps.
 *
 * **Output modes.** `--url-only` prints the bare url whatever stdout is — the
 * form `$(…)` wants. Otherwise machine output writes the document and never
 * opens anything; a terminal opens the browser once and prints the url on
 * stderr, so a headless or `XANO_NO_BROWSER` run still surfaces it.
 *
 * Node-only (fetch + OAuth); lazily imported by the dispatcher like its siblings.
 */
import { withArticle } from "../util/article.js";
import type { ParsedArgs } from "./cli.js";
import { getAccessToken } from "../auth/token.js";
import { openBrowser } from "../auth/loopback.js";
import { impersonateEphemeral } from "../deploy/ephemeral.js";
import { impersonateTenant } from "../deploy/tenant.js";
import { mintEngineLoginLink } from "../deploy/local-engine-process.js";
import type { EngineFetch } from "../deploy/local-engine-release.js";
import { requireBackendSlot } from "./backend-slot.js";
import { memoCredential, refuseProfileForLocal, selectBackend } from "./tracked-backend.js";
import { actualKind, describeBackend, resolveSource, type ResolveDeps, type ResolvedSource } from "./source-resolve.js";
import { isMachineOutput, writeJson } from "./output.js";
import { detail, step, success } from "./ui.js";

/** Seams the tests replace; production callers pass nothing. */
export interface ImpersonateCommandOptions {
  /** The resolver's seams (hosted lookups, the engine enumeration, where records live). */
  deps?: ResolveDeps;
  /** The request seam a Xano Engine's login link is minted through. */
  fetch?: EngineFetch;
}

export async function runImpersonateCommand(args: ParsedArgs, opts: ImpersonateCommandOptions = {}): Promise<void> {
  const deps = { ...opts.deps, cwd: opts.deps?.cwd ?? process.cwd() };
  const slot = requireBackendSlot("impersonate", undefined, "subject");
  const credential = memoCredential(() => getAccessToken(args));
  const source = await selectBackend(slot, args.positionals[0], { credential, deps });
  if (source.kind === "file") {
    // The slot does not accept a file, so `parseSlot` has already refused one.
    throw new Error("Internal: `impersonate` resolved a bundle file.");
  }
  refuseProfileForLocal(args.profile, [source.kind], slot);
  // The dashboard opens through the parent, workspace or not.
  const resolved = await resolveSource(source, credential, { ...deps, workspaceless: "any" });
  const url = await dashboardUrl(resolved, args.guest, opts);

  // Bare on a mere pipe — `$(xanosdk impersonate -u)` is the form it exists for —
  // but `--json` asked for by name gets the document, as `local token` does.
  if (args.urlOnly && args.json !== true) {
    process.stdout.write(`${url}\n`);
    return;
  }
  if (isMachineOutput(args)) {
    // `guest` always present: a read-only session and an owner one open the same
    // url shape, and a wrapper handing the link on must be able to tell them apart.
    // `name` and `display` as `tables` and `test` carry them: the backend's own
    // name whatever its kind, and the display name people call it by — null
    // where the kind has none, so the keys never depend on the kind.
    writeJson({
      kind: actualKind(resolved),
      name: resolved.backend.kind === "local" ? resolved.backend.engine.name : (resolved.target.env ?? null),
      display: resolved.target.display ?? null,
      url,
      guest: args.guest === true,
    });
    return;
  }
  step("Opening the Xano builder…");
  detail(url);
  openBrowser(url);
  success(`Impersonation session opened for ${describeBackend(resolved)}${args.guest ? " (read-only guest)" : ""}`);
}

/**
 * The url to open for a resolved backend, minting a session where the kind has
 * one. See the module header for why each kind differs.
 */
async function dashboardUrl(
  resolved: ResolvedSource,
  guest: boolean,
  opts: ImpersonateCommandOptions,
): Promise<string> {
  const backend = resolved.backend;
  if (backend.kind === "local") {
    const { url } = await mintEngineLoginLink(backend.engine, {
      guest,
      ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
    });
    return url;
  }
  const auth = backend.auth;
  switch (resolved.kind) {
    case "ephemeral":
    case "tenant": {
      // The resolver records the env's own name in `target.env`; `label` is
      // prose and is not parsed back out.
      const name = resolved.target.env ?? resolved.target.label;
      const { _ti } =
        resolved.kind === "ephemeral"
          ? await impersonateEphemeral(auth, { parentWorkspaceId: auth.workspaceId, name, guest })
          : await impersonateTenant(auth, { workspaceId: auth.workspaceId, name, guest });
      const url = new URL("/impersonate", auth.instance);
      url.searchParams.set("_ti", _ti);
      return url.href;
    }
    default:
      // The slot refuses the workspace and a release before anything resolves.
      throw new Error(`Internal: \`impersonate\` resolved ${withArticle(resolved.kind)}.`);
  }
}
