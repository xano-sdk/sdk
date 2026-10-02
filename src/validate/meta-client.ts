/**
 * Client for the public Xano meta API, used by `xanosdk preflight`.
 *
 * Every route here is a public `/api:meta/...` path (plus public `/api:{canonical}`
 * invocation). The SDK emits a JSON bundle and reads objects back as JSON; the one
 * text route, {@link MetaClient.exportMultidoc}, reads the engine's own
 * rendering of the workspace for an installed toolchain module to compare against.
 *
 * The import uses the SAME transport `deploy` and `release` use — the
 * `gzip(tar(workspace.json))` archive posted to `workspace/{id}/xanosdk/import`
 * with `mode=replace`. There is exactly one way into an instance, so a bug in the
 * deploy path is a bug validate reproduces rather than routes around.
 *
 * Each run gets its OWN ephemeral environment, created up front and deleted in
 * {@link MetaClient.dispose}. That is what makes the round-trip trustworthy: the
 * objects read back can only have come from this bundle, never from something a
 * previous run left behind. The env carries a short expiry so a killed process
 * leaks nothing permanent.
 *
 * Node-only; lazily imported by the command layer.
 */
import { createEphemeral, deleteEphemeral, waitUntilReady, isEphemeralDisabled } from "../deploy/ephemeral.js";
import { xanosdkImport } from "../deploy/xanosdk-import.js";
import { decodeWorkspaceArchive, encodeWorkspaceArchive } from "./archive.js";
import type { ResolvedAuth } from "../auth/token.js";
import type { ValidateConfig } from "./config.js";
import { explainFetchFailure, fetchReadOrExplain, httpFailureError } from "../util/http.js";

/** Bound each read/run so a stalled endpoint can't hang the CLI. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * An ephemeral env's internal workspace id is always `1`. The import into it is
 * an explicit `mode=replace` — a full clear-then-import, which is the
 * clean-slate semantics the round-trip diff depends on.
 */
const ENV_WORKSPACE_ID = 1;

/** Parent workspace used when the config names none. */
const DEFAULT_PARENT_WORKSPACE_ID = 1;

/**
 * Expiry on the per-run env. It is deleted in `dispose()`, so this only matters
 * when the process dies first — short enough that a crashed run sweeps itself.
 */
const ENV_EXPIRES_HOURS = 1;

/** Result of importing a compiled bundle into this run's ephemeral environment. */
export interface ImportResult {
  /** The imported workspace's numeric id — the key for reading objects back. */
  workspaceId: number | undefined;
  /** The environment's public base URL. */
  baseUrl: string | undefined;
  /** Raw response body, kept for diagnostics. */
  raw: string;
}

/** Outcome of running a function: its status plus the parsed (or raw) body. */
export interface InvokeResult {
  status: number;
  ok: boolean;
  /** Parsed JSON body when the response was JSON, else the raw text. */
  body: unknown;
}

/**
 * A client bound to one instance + token. Read methods (`exportWorkspace`,
 * `exportMultidoc`) throw on a non-2xx with the endpoint's body attached;
 * {@link runFunction} returns the status so callers can inspect error responses.
 */
export class MetaClient {
  /**
   * Origin that post-import reads/runs target. The objects land in this run's
   * ephemeral ENVIRONMENT, served under a `/tenant/<slug>` path, so reads must hit
   * that env-scoped origin rather than the parent instance — this is switched to
   * the env URL after a successful import (and starts at the parent instance, which
   * is what `verifyToken` and any pre-import call use).
   */
  private readBase: string;

  /** This run's ephemeral env, once created — the handle `dispose()` deletes. */
  private env: { parentWorkspaceId: number; name: string } | undefined;

  constructor(private readonly config: ValidateConfig) {
    this.readBase = config.instance;
  }

  /**
   * The validate config as the deploy transports' `ResolvedAuth`. Validate is
   * engineer tooling authenticated by a bare instance token from the environment,
   * never the interactive OAuth store — hence `credentialType: "token"`.
   */
  private deployAuth(workspaceId: number): ResolvedAuth {
    return {
      access_token: this.config.token,
      instance: this.config.instance,
      workspaceId,
      credentialType: "token",
    };
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.token}` };
  }

  /**
   * Build a read/run URL against {@link readBase}, APPENDING the route so any
   * `/tenant/<slug>` path prefix survives (a leading-slash `new URL(path, base)`
   * would drop it back to the origin).
   */
  private readUrl(path: string): URL {
    return new URL(`${this.readBase}${path}`);
  }

  /**
   * Create this run's ephemeral environment and import the compiled bundle into
   * it, as the `gzip(tar(workspace.json))` archive.
   *
   * There is no `reset` knob: the import is ALWAYS a full replace, and the env
   * is brand new besides. A flag that could not change the outcome would only
   * invite the belief that a merge import exists here.
   *
   * `preserveGuids` is deliberately left unset (the route's default, `false`):
   * the round-trip diff already expects the engine to re-mint every guid and
   * translates them back (see `./guid-remap.ts`), so preserving them buys
   * nothing — and asking would additionally refuse a bundle carrying a
   * duplicate or malformed guid, a deploy-time contract preflight has no reason
   * to impose on a bundle it only reads back. Unset is also exactly what this
   * import sent before it moved routes.
   */
  async importBundle(bundle: string): Promise<ImportResult> {
    const parentWorkspaceId = this.config.workspaceId ?? DEFAULT_PARENT_WORKSPACE_ID;
    const auth = this.deployAuth(parentWorkspaceId);

    const env = await createEphemeral(auth, {
      parentWorkspaceId,
      display: "xanosdk-preflight",
      description: "Disposable environment for `xanosdk preflight`.",
      expiresHours: ENV_EXPIRES_HOURS,
    }).catch((err: unknown) => {
      // Same instance capability as the deploy path, and with no
      // fallback to offer: this runs against a throwaway environment by
      // construction, so there is nowhere else for it to go.
      if (!isEphemeralDisabled(err)) throw err;
      throw new Error(
        "Ephemeral environments are not enabled on this instance, so `xanosdk preflight` has " +
          "nowhere disposable to run. Ask whoever administers the instance to enable them — " +
          "`xanosdk export` still writes the bundle without one.",
      );
    });
    // Track it before the first thing that can throw, so `dispose()` can still
    // clean up an env whose import failed.
    this.env = { parentWorkspaceId, name: env.name };
    await waitUntilReady(auth, { parentWorkspaceId, name: env.name });

    // An env with no domain has no URL to import into or read back from, and every
    // later step would fail with a less obvious message.
    const envUrl = env.url;
    if (envUrl === undefined || envUrl === "") {
      throw new Error(
        `The validation environment (${env.name}) came back without a URL, so there is nothing to deploy into.`,
      );
    }

    const result = await xanosdkImport(auth, {
      baseUrl: envUrl,
      archive: encodeWorkspaceArchive(bundle),
      workspaceId: ENV_WORKSPACE_ID,
      mode: "replace",
      dryRun: false,
    });

    // Reads and runs target the env, not the parent instance.
    this.readBase = envUrl.replace(/\/+$/, "");
    return {
      workspaceId: result.workspace.id ?? ENV_WORKSPACE_ID,
      baseUrl: env.url,
      raw: result.raw,
    };
  }

  /**
   * Delete this run's ephemeral environment. Safe to call when no env was ever
   * created, and never throws: a cleanup failure must not mask the validation
   * result the caller is about to report. The env's own expiry is the backstop.
   */
  async dispose(): Promise<{ deleted: boolean; error?: string }> {
    const env = this.env;
    if (env === undefined) return { deleted: false };
    this.env = undefined;
    try {
      await deleteEphemeral(this.deployAuth(env.parentWorkspaceId), {
        parentWorkspaceId: env.parentWorkspaceId,
        name: env.name,
        // Made by this run through the ephemeral create route.
        verified: true,
      });
      return { deleted: true };
    } catch (err) {
      return { deleted: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Export the workspace (this run's environment, post-import) as a `packageExport`
   * bundle — the SAME shape the SDK emits, carrying full object logic. This is
   * the faithful round-trip source: the response is a gzipped tar of
   * `workspace.json`, decoded here into its bundle object. Table rows and stored
   * file bytes are skipped (`records`/`vault: false`): only `workspace.json` is
   * read, and it carries the file library's metadata either way.
   */
  async exportWorkspace(workspaceId: number): Promise<{ payload: Record<string, unknown> }> {
    const url = this.readUrl(`/api:meta/workspace/${workspaceId}/export`);
    // Changes nothing, so it is retried and explained as a read.
    const res = await fetchReadOrExplain(
      url.href,
      {
        method: "POST",
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ branch: "", password: "", records: false, vault: false }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      `Export of workspace ${workspaceId}`,
      REQUEST_TIMEOUT_MS,
    );
    if (!res.ok) {
      const text = await res.text();
      throw httpFailureError(`Export of workspace ${workspaceId}`, res, text);
    }
    const decoded = decodeWorkspaceArchive(new Uint8Array(await res.arrayBuffer())) as {
      payload?: Record<string, unknown>;
    };
    return { payload: decoded.payload ?? {} };
  }

  /**
   * The engine's own rendering of the workspace (this run's environment,
   * post-import) — the same multidoc `xanosdk ephemeral export --format multidoc`
   * returns. `preflight` hands it to an installed toolchain module.
   */
  async exportMultidoc(workspaceId: number): Promise<string> {
    const url = this.readUrl(`/api:meta/workspace/${workspaceId}/multidoc`);
    // A pure read: retried on a dropped connection, and a transport failure is
    // explained rather than surfaced as a bare `fetch failed`.
    const res = await fetchReadOrExplain(
      url.href,
      {
        headers: { ...this.authHeaders(), accept: "text/x-xanoscript" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      `XanoScript export of workspace ${workspaceId}`,
      REQUEST_TIMEOUT_MS,
    );
    const text = await res.text();
    if (!res.ok) throw httpFailureError(`XanoScript export of workspace ${workspaceId}`, res, text);
    return text;
  }

  /**
   * Run a named workspace function via the meta function-run route. Unlike the
   * read methods this returns the status (rather than throwing) so a caller can
   * report an engine error + logs as a runtime outcome.
   */
  async runFunction(workspaceId: number, name: string, input?: unknown): Promise<InvokeResult> {
    const url = this.readUrl(`/api:meta/workspace/${workspaceId}/function/run`);
    let res: Response;
    try {
      res = await fetch(url.href, {
        method: "POST",
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name, input: input ?? {} }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw explainFetchFailure(err, { url: url.href, what: `Running function "${name}"`, timeoutMs: REQUEST_TIMEOUT_MS });
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      /* non-JSON — keep the raw text */
    }
    return { status: res.status, ok: res.ok, body };
  }
}
