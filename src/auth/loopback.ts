/**
 * Loopback redirect handling for the CLI's authorization-code flow. Binds a
 * short-lived `127.0.0.1` HTTP server to catch the browser's `?code=…&state=…`
 * redirect, and opens the user's browser to the authorize URL.
 *
 * Node-only (`node:http`, `node:child_process`). Never reachable from the
 * browser-safe `index.ts` surface — imported only by the `login` command.
 *
 * Testability: the server is driven directly by `fetch`ing the callback URL (no
 * real browser needed), and `openBrowser` is a no-op when `XANO_NO_BROWSER` is
 * set, so tests never spawn a browser.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo, Socket } from "node:net";
import { envFlagSet } from "../util/env.js";

/** How long to wait for the browser redirect before giving up (ms). */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** The redirect the browser lands on once the user authorizes. */
export interface CallbackResult {
  /** The authorization `code` (already state-validated). */
  code: string;
  /**
   * The full callback URL (`redirectUri` + the AS's query string), preserving
   * `state`/`iss` alongside `code`. openid-client's `authorizationCodeGrant`
   * derives the token-request `redirect_uri` from this URL's origin+path, so it
   * is reconstructed against `redirectUri` exactly — never the ephemeral socket.
   */
  callbackUrl: string;
}

/** A listening loopback callback server awaiting one authorization redirect. */
export interface CallbackListener {
  /** The exact `redirect_uri` to send in the authorize request (with bound port). */
  redirectUri: string;
  /** Resolves with the callback once the browser redirects back. */
  waitForCallback: Promise<CallbackResult>;
  /** Tear the server down (safe to call more than once). */
  close(): void;
}

export interface CallbackOptions {
  /** Path the redirect lands on (e.g. `/oauth/callback`). */
  callbackPath: string;
  /** The `state` value that must be echoed back, else the flow is rejected. */
  expectedState: string;
  /** Fixed port to bind; omit/0 for an OS-assigned ephemeral port. */
  port?: number;
  /** Override the redirect timeout (ms). */
  timeoutMs?: number;
}

/**
 * The exact `redirect_uri` for a given loopback port — the one string both login
 * modes must agree on. The bound server derives it from its real port; the paste
 * flow (which binds nothing) derives it from the requested port. Same function,
 * so the value the authorization server sees is identical either way and the
 * cached client registration is reused rather than duplicated.
 */
export function loopbackRedirectUri(port: number, callbackPath: string): string {
  return `http://127.0.0.1:${port}${callbackPath}`;
}

/** `300000` → `5 minutes`. Sub-minute windows stay in seconds. */
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

const CLOSE_TAB_HTML =
  "<!doctype html><meta charset=utf-8><title>xanosdk</title>" +
  "<body style=\"font-family:system-ui;padding:3rem;text-align:center\">" +
  "<h1>Authentication complete</h1><p>You can close this tab and return to the terminal.</p></body>";

/**
 * Start the loopback server and begin listening. Resolves once the socket is
 * bound (so `redirectUri` carries the real port) — the `waitForCallback`
 * promise resolves later, when the browser redirect arrives.
 */
export function startCallbackServer(opts: CallbackOptions): Promise<CallbackListener> {
  const { callbackPath, expectedState, port, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  return new Promise<CallbackListener>((resolveListener, rejectListener) => {
    let resolveResult!: (result: CallbackResult) => void;
    let rejectResult!: (err: Error) => void;
    const waitForCallback = new Promise<CallbackResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });
    // A caller that gives up before awaiting (`close()` after the authorize URL
    // fails to build) would otherwise leave this rejection unhandled — which
    // Node turns into a crash reporting "Login cancelled." INSTEAD of the real
    // error. A no-op handler marks it handled without swallowing anything: the
    // caller's own `await` still observes the rejection.
    waitForCallback.catch(() => {});
    // Set once the socket is bound; the callback URL is rebuilt against this so
    // its origin+path matches the registered redirect_uri exactly.
    let redirectUri = "";

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== callbackPath) {
        respond(res, 404, "Not found");
        return;
      }
      // Validate state FIRST and do NOT settle the one-shot server on a
      // mismatch: any local process could otherwise hit the callback with a
      // wrong/absent state and tear the server down before the real redirect
      // arrives (a login DoS). A spoofed request is answered 400 and ignored;
      // only a correct-state callback can complete or fail the flow.
      const state = url.searchParams.get("state");
      if (state !== expectedState) {
        respond(res, 400, "Unexpected or missing state — ignoring this request.");
        return;
      }
      // Never reflect the server-supplied `error` value into the HTML response
      // (reflected-injection footgun); keep the raw value in the thrown Error /
      // stderr only.
      const error = url.searchParams.get("error");
      if (error) {
        // Carry the raw code on `.error` (openid-client's convention) so callers
        // can recover from an authorize-time `invalid_client` the same way they
        // recover from one at the token endpoint. Settle only after the page has
        // flushed (see `finish` — it destroys the socket).
        const authError: Error & { error?: string } = new Error(
          `Authorization server returned error: ${error}`,
        );
        authError.error = error;
        respond(res, 400, "Authorization failed. Check the terminal for details.", () => finish(authError));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        respond(res, 400, "Missing authorization code.", () =>
          finish(new Error("Callback carried no authorization code.")),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html", Connection: "close" }).end(CLOSE_TAB_HTML, () => {
        // Rebuild the callback URL against the registered redirect_uri (not the raw
        // socket address) so its origin+path matches exactly, preserving every AS
        // query param (code, state, iss) for openid-client to validate. Settle from
        // the flush callback so the "close this tab" page reaches the browser before
        // `finish` tears the socket down.
        finish(undefined, { code, callbackUrl: `${redirectUri}?${url.searchParams.toString()}` });
      });
    });

    // Track live sockets so `finish` can destroy them. `server.close()` only stops
    // accepting NEW connections; the browser keeps the callback socket (and any
    // speculative preconnect sockets) open with keep-alive, and those linger long
    // enough to keep Node's event loop alive — so the CLI would appear to hang for
    // ~seconds after a successful login. Destroying them lets the process exit at
    // once. Terminal responses settle from their flush callback, so the page is
    // already sent by the time we destroy.
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      // A one-shot server that closes right after responding can leave a socket
      // mid-flight; swallow those resets so they don't surface as unhandled errors.
      socket.on("error", () => {});
    });

    // One-shot: after the first (in)valid callback, resolve/reject and close.
    const timer = setTimeout(() => {
      finish(new Error(`Timed out after ${formatDuration(timeoutMs)} waiting for the browser redirect.`));
    }, timeoutMs);
    timer.unref?.();

    let settled = false;
    function finish(err?: Error, result?: CallbackResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      // Actively tear down every remaining socket (keep-alive callback + idle
      // preconnects) so the event loop drains and the CLI exits promptly.
      for (const socket of sockets) socket.destroy();
      if (err) rejectResult(err);
      else resolveResult(result!);
    }

    server.on("error", (err) => {
      if (!settled) rejectListener(err);
    });

    server.listen(port ?? 0, "127.0.0.1", () => {
      // The redirect_uri is derived from the SAME helper the paste flow uses, so
      // the two login modes can never drift apart. Drift would be silent and
      // expensive: the DCR cache is keyed on (auth host + redirect URI), so a
      // one-character difference re-registers a fresh client instead of reusing
      // the registered one. An ephemeral port (`--port 0`) still works, but only
      // here — it cannot be pasted, because nothing is listening in that mode.
      const boundPort = (server.address() as AddressInfo).port;
      redirectUri = loopbackRedirectUri(boundPort, callbackPath);
      resolveListener({
        redirectUri,
        waitForCallback,
        close: () => finish(new Error("Login cancelled.")),
      });
    });
  });
}

function respond(res: ServerResponse, status: number, message: string, onFlush?: () => void): void {
  // `Connection: close` tells the browser not to keep this socket alive, so it is
  // torn down once the response is read rather than lingering against server exit.
  res.writeHead(status, { "Content-Type": "text/html", Connection: "close" }).end(
    `<!doctype html><meta charset=utf-8><body style="font-family:system-ui;padding:3rem;text-align:center">${message}</body>`,
    onFlush,
  );
}

/** Resolve the platform browser-open command. Pure, for per-platform testing. */
export function browserCommand(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  switch (platform) {
    case "darwin":
      return { cmd: "open", args: [url] };
    case "win32":
      // `cmd /c start` treats `&` as a command separator, which mangles the
      // multi-param authorize URL; caret-escape it so the whole URL opens.
      return { cmd: "cmd", args: ["/c", "start", "", url.replace(/&/g, "^&")] };
    default:
      return { cmd: "xdg-open", args: [url] };
  }
}

/**
 * Best-effort browser launch. A no-op when `XANO_NO_BROWSER` is set (CI/tests),
 * where the caller prints the URL to stderr for the user to open manually.
 */
export function openBrowser(url: string): void {
  if (envFlagSet("XANO_NO_BROWSER")) return;
  const { cmd, args } = browserCommand(process.platform, url);
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* opener missing — the caller already printed the URL as a fallback. */
    });
    child.unref();
  } catch {
    /* best-effort — never fail login because the browser couldn't be spawned. */
  }
}
