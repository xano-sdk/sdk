/**
 * Normalize what a user pastes back from the browser into a callback URL the
 * authorization-code exchange will accept.
 *
 * This is the `--paste` login mode's one piece of new logic. When the browser
 * cannot reach the CLI's loopback (a remote shell, a container, a Codespace),
 * the redirect still happens — it just lands on a "can't connect" page whose
 * address bar holds the code. The user pastes that back; this turns it into the
 * exact shape `openid-client` expects.
 *
 * Pure: no I/O, no `node:http`, no clock. Every branch is unit-testable.
 */

/** What the paste is rebuilt against, plus the values a bare code has to borrow. */
export interface PasteContext {
  /** The registered `redirect_uri` — every result is rebuilt against this. */
  redirectUri: string;
  /** The `state` THIS run generated. Supplied for a bare code; verified at exchange. */
  state: string;
  /** The authorization server's issuer, for the `iss` a bare code cannot carry. */
  issuer: string;
}

/** An authorization error the user pasted back, carrying the raw OAuth code. */
export interface PastedAuthError extends Error {
  /** The raw `error` parameter (openid-client's convention), e.g. `access_denied`. */
  error?: string;
}

const EXAMPLE =
  "Paste either the full URL from your browser's address bar " +
  "(http://127.0.0.1:…/oauth/callback?code=…) or just the code=… value from it.";

/**
 * Turn a pasted redirect URL, query string, or bare code into a callback URL.
 *
 * Always rebuilt against `ctx.redirectUri` rather than the pasted origin: the
 * exchange derives its token-request `redirect_uri` from this URL's origin+path,
 * and that has to match what was registered exactly. Only the query survives
 * from the paste — which is where `code`, `state`, and `iss` live anyway. This
 * is the same discipline the loopback server applies when it reconstructs its
 * own callback URL.
 *
 * A bare code borrows `state` and `iss` from the run, and any paste missing
 * `state` or `iss` has it filled in. That makes the state and RFC 9207 issuer
 * checks vacuous for those pastes, which is the accepted cost of accepting them
 * at all: RFC 9207 defends against mix-ups between MULTIPLE authorization
 * servers, the CLI talks to exactly the one it just discovered, and PKCE still
 * binds the exchange to this run. A `state` or `iss` that is present and WRONG
 * is refused here, with a message saying which — that is a signal, not a copy
 * artifact.
 */
export function normalizePastedCallback(input: string, ctx: PasteContext): string {
  const trimmed = input.trim();
  if (trimmed === "") throw new Error(`Nothing was pasted. ${EXAMPLE}`);

  const params = extractParams(trimmed, ctx);

  // Surface a pasted authorization error the same way the loopback server does —
  // raw code on `.error` — so the caller's `invalid_client` recovery still fires.
  const error = params.get("error");
  if (error) {
    const description = params.get("error_description");
    const authError: PastedAuthError = new Error(
      `Authorization server returned error: ${error}${description ? ` (${description})` : ""}`,
    );
    authError.error = error;
    throw authError;
  }

  if (!params.get("code")) {
    throw new Error(`That paste carries no \`code\` value. ${EXAMPLE}`);
  }

  // Checked HERE, with a message naming what is wrong, rather than left to the
  // exchange: the OAuth library reports every one of these as a bare "invalid
  // response encountered".
  for (const key of ["code", "state", "iss"]) {
    if (params.getAll(key).length > 1) {
      throw new Error(`That paste carries \`${key}\` more than once, so it is not one redirect. ${EXAMPLE}`);
    }
  }
  const state = params.get("state");
  if (state && state !== ctx.state) {
    throw new Error(
      "That URL is from a different sign-in attempt — its `state` does not match this one. " +
        "Finish signing in with the link printed above and paste the URL that one lands on.",
    );
  }
  const iss = params.get("iss");
  if (iss && iss !== ctx.issuer) {
    throw new Error(
      `That URL was issued by ${iss}, not by ${ctx.issuer}, which this sign-in is talking to. ` +
        "Finish signing in with the link printed above and paste the URL that one lands on.",
    );
  }

  // Fill in an ABSENT `state` and `iss` — a partial copy out of an address bar
  // loses them, and their absence is a hard validation failure that reads as
  // "invalid response" with nothing pointing at the cause. The same trade a
  // bare code makes; see the docstring on the cost. A present-but-wrong value
  // is a real signal, refused above.
  if (!state) params.set("state", ctx.state);
  if (!iss) params.set("iss", ctx.issuer);

  return `${ctx.redirectUri}?${params.toString()}`;
}

/**
 * Read the query parameters out of whatever shape was pasted: a full URL, a bare
 * query string, or a bare code (which has none, so they are synthesized).
 */
function extractParams(trimmed: string, ctx: PasteContext): URLSearchParams {
  // A full URL — or something URL-shaped. Take its query and drop its origin.
  const url = parseUrl(trimmed);
  if (url) return url.searchParams;

  // Anything with a query on it that `new URL` refused: a scheme-less paste
  // (`127.0.0.1:47100/oauth/callback?code=…`), or the `localhost:` form, which
  // parses as protocol `localhost:` and is rejected above. Read from the FIRST
  // `?` so every parameter survives, not just the one that matched.
  const queryStart = trimmed.indexOf("?");
  if (queryStart !== -1 && isRecognizedQuery(trimmed.slice(queryStart + 1))) {
    return new URLSearchParams(trimmed.slice(queryStart + 1));
  }

  // A bare query string with no `?` at all. Keyed on an actual recognized
  // parameter, NOT on a bare `=`: authorization codes are opaque and may
  // legitimately contain `=` (base64 padding), and reading one of those as a
  // query string would send an empty code to the token endpoint.
  if (isRecognizedQuery(trimmed)) return new URLSearchParams(trimmed);

  // A bare code: borrow the run's state and the server's issuer.
  return new URLSearchParams({ code: trimmed, state: ctx.state, iss: ctx.issuer });
}

/** Does this look like a callback query — i.e. does it carry `code` or `error`? */
function isRecognizedQuery(value: string): boolean {
  return /(^|&)(code|error)=/.test(value);
}

/** Parse an http(s) URL, or undefined for anything else (including a bare code). */
function parseUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
