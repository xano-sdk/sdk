/**
 * The `User-Agent` every CLI request carries:
 *
 *     xanosdk/1.0.20 (deploy; node 22.11.0; darwin arm64)
 *     xanosdk/1.0.20 (workspace export; node 22.11.0; linux x64; ci)
 *
 * Without it a request goes out as Node's own `node`, and the server cannot
 * tell a `xanosdk` run from any other script. The header names the SDK
 * version, the command (only once it is known to be a real one, never its
 * arguments), the Node version and the platform, plus `ci` under a CI runner.
 * Nothing about the project, the workspace or the person running it.
 *
 * The bin wraps the global `fetch` once ({@link installUserAgent}), the way
 * write tracking does, so every call site carries it with no per-site
 * plumbing. A request that sets its own `User-Agent` keeps it. Library use
 * (`import "@xano/sdk"`) never patches the caller's `fetch`.
 *
 * Imports nothing of the SDK's own: the bin loads it before any command.
 */

/** The command this run is executing, once parsed and known: `deploy`, `workspace export`. */
let runCommand: string | undefined;

/**
 * Record the run's command for the header. Pass only a command the CLI
 * recognised; `undefined` clears it (between runs in one process).
 */
export function noteUserAgentCommand(command: string | undefined): void {
  runCommand = command;
}

/** Whether this process runs under a CI runner (the `CI` convention every major provider sets). */
function underCi(env: NodeJS.ProcessEnv): boolean {
  const v = env.CI?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

/** The header value for this SDK `version`, as of now. */
export function userAgent(
  version: string,
  opts: { command?: string; env?: NodeJS.ProcessEnv; node?: string; platform?: string; arch?: string } = {},
): string {
  const command = "command" in opts ? opts.command : runCommand;
  const parts = [
    ...(command === undefined ? [] : [command]),
    `node ${opts.node ?? process.versions.node}`,
    `${opts.platform ?? process.platform} ${opts.arch ?? process.arch}`,
    ...(underCi(opts.env ?? process.env) ? ["ci"] : []),
  ];
  return `xanosdk/${version} (${parts.join("; ")})`;
}

/** `fetchImpl`, sending {@link userAgent} on every request that does not set its own. */
export function userAgentFetch(fetchImpl: typeof fetch, version: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.has("user-agent")) return fetchImpl(input, init);
    headers.set("user-agent", userAgent(version));
    return fetchImpl(input, { ...init, headers });
  };
}

let installed = false;

/** Wrap the global `fetch` with {@link userAgentFetch}. Idempotent. */
export function installUserAgent(version: string): void {
  if (installed) return;
  installed = true;
  globalThis.fetch = userAgentFetch(globalThis.fetch.bind(globalThis), version);
}
