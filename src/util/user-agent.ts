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
 * Two layers carry it, and a request that sets its own `User-Agent` keeps it
 * in both:
 *
 * - The SDK's own transports to Xano set it on the request: every Meta API
 *   request, through the shared `util/http.ts` transport ({@link withUserAgent})
 *   or {@link withUserAgentHeaders} where a module calls `fetch` itself, and the
 *   local engine's loopback calls, the MCP bridge's `node:http` POST included.
 *   So `run()` from `@xano/sdk/node` sends it too, without touching the
 *   caller's `fetch`.
 * - The bin also wraps the global `fetch` once ({@link installUserAgent}), the
 *   way write tracking does, so a CLI run's other requests carry it with no
 *   per-site plumbing. Library use (`import "@xano/sdk"`) never patches the
 *   caller's `fetch`.
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

/** The SDK version the header names, once the bin or a `run()` has said it. */
let sdkVersion: string | undefined;

/** Record this installation's SDK version for {@link sdkUserAgent}; `undefined` forgets it. */
export function noteUserAgentVersion(version: string | undefined): void {
  sdkVersion = version;
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

/** The header value the SDK's own transports send: {@link userAgent} for the noted version (`unknown` before one is). */
export function sdkUserAgent(): string {
  return userAgent(sdkVersion ?? "unknown");
}

/** Any `HeadersInit` shape `fetch` takes (the DOM lib's name is not in this build's types). */
type HeaderInit = NonNullable<RequestInit["headers"]>;

/** Whether `headers` already carry a `User-Agent`, in any case and any `HeadersInit` shape. */
function hasUserAgent(headers: HeaderInit): boolean {
  if (headers instanceof Headers) return headers.has("user-agent");
  const names = Array.isArray(headers) ? headers.map((pair) => pair[0] ?? "") : Object.keys(headers);
  return names.some((name) => name.toLowerCase() === "user-agent");
}

/**
 * `headers` with {@link sdkUserAgent} added, in the shape they came in (a plain
 * object stays a plain object, so a `node:http` request or a seam reading
 * `init.headers` by key still can). Headers that already carry a `User-Agent`,
 * in any case, come back unchanged: the caller's wins.
 */
export function withUserAgentHeaders(headers: Record<string, string>): Record<string, string>;
export function withUserAgentHeaders(headers?: HeaderInit): HeaderInit;
export function withUserAgentHeaders(headers?: HeaderInit): HeaderInit {
  if (headers === undefined) return { "user-agent": sdkUserAgent() };
  if (hasUserAgent(headers)) return headers;
  if (headers instanceof Headers) {
    const copy = new Headers(headers);
    copy.set("user-agent", sdkUserAgent());
    return copy;
  }
  if (Array.isArray(headers)) return [...headers, ["user-agent", sdkUserAgent()]];
  return { ...headers, "user-agent": sdkUserAgent() };
}

/** `init` with {@link withUserAgentHeaders} applied to its headers. */
export function withUserAgent(init: RequestInit = {}): RequestInit {
  return { ...init, headers: withUserAgentHeaders(init.headers) };
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
  noteUserAgentVersion(version);
  if (installed) return;
  installed = true;
  globalThis.fetch = userAgentFetch(globalThis.fetch.bind(globalThis), version);
}
