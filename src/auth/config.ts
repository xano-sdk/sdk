/**
 * Small flag→env→saved→default resolvers shared by the `login` and `push`
 * command modules, so both agree on how the instance, auth host, and scope are
 * chosen. Pure; no I/O.
 */
import type { ParsedArgs } from "../emit/cli.js";
import { UsageError } from "../emit/errors.js";
import { readEnvVar } from "../util/env.js";
import { DEFAULT_AUTH_HOST, DEFAULT_SCOPE } from "./oauth.js";

/** Xano control-plane OAuth host: `--origin` → `$XANO_ORIGIN` → saved → default. */
export function resolveAuthHost(args: ParsedArgs, saved?: string): string {
  return args.authHost ?? envOrigin() ?? saved ?? DEFAULT_AUTH_HOST;
}

/**
 * `$XANO_ORIGIN`, or undefined when it is unset OR empty: `XANO_ORIGIN=""` is
 * how a shell clears a variable, and refusing it as "not a valid URL" read a
 * cleared setting as a typed one.
 */
export function envOrigin(): string | undefined {
  return readEnvVar("XANO_ORIGIN");
}

/**
 * Requested scopes: `--scope` → the built-in default set.
 *
 * An empty `--scope` is refused, like every other empty flag value: it is far
 * more often an unset shell variable than an intent, and requesting no scope
 * mints a credential that can do nothing.
 */
export function resolveScope(args: ParsedArgs): string {
  if (args.scope !== undefined && args.scope.trim() === "") {
    throw new UsageError(
      "--scope is empty — usually an unset shell variable. Pass the space-separated OAuth scopes " +
        'to request (e.g. --scope "offline_access workspace:read"). Drop --scope to request the default set.',
      { hintFor: { command: "login" } },
    );
  }
  return args.scope ?? DEFAULT_SCOPE;
}

/**
 * Reject a non-https origin before any token or auth code crosses it. Plain
 * http is permitted only for loopback hosts (local dev). Also surfaces a clear
 * error for a scheme-less value instead of a bare "Invalid URL" deep in a fetch.
 */
export function assertHttpsOrigin(origin: string, label: string): void {
  refuseMistypedScheme(origin, label);
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`${label} is not a valid URL: "${origin}" (expected e.g. https://your-instance.xano.io).`);
  }
  // `URL` keeps the brackets on an IPv6 host (`[::1]`), so both spellings count.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  // Neither http nor https: "must use https … http is allowed only for
  // localhost" read wrong for `ftp://127.0.0.1`, whose host IS localhost.
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `${label} must use https://, or http:// for localhost (got "${origin}", whose scheme is ${url.protocol}).`,
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error(`${label} must use https:// (got "${origin}"). Plain http is allowed only for localhost.`);
  }
}

/**
 * {@link assertHttpsOrigin}, plus: a sign-in server is an ORIGIN. Discovery is
 * read from `<origin>/.well-known/…`, so a path, query or fragment on the value
 * is carried into that lookup and fails as a bare "unexpected HTTP response
 * status code" after the loopback is already up. Refused rather than trimmed:
 * a pasted URL with a path is as likely the wrong URL as the right host.
 */
export function assertSignInOrigin(origin: string, label: string): void {
  assertNoUserinfo(origin, label);
  assertHttpsOrigin(origin, label);
  const url = new URL(origin);
  if ((url.pathname === "" || url.pathname === "/") && url.search === "" && url.hash === "") return;
  throw new Error(
    `${label} must be an origin — a scheme and host, with no path, query or fragment ` +
      `(got "${origin}"). Use ${url.origin}.`,
  );
}

/**
 * A TYPED instance URL (`profile add --instance`) is an origin, as
 * `login --origin` is: every meta API call is built as
 * `new URL("/api:meta/…", instance)`, so a path on the value was silently
 * dropped — `https://u:p@host/path` verified and stored as the bare host, and
 * the reader never learned that half of what they typed was ignored. A user
 * name or password is refused WITHOUT echoing the value (the meta API token
 * authenticates; a pasted password is a leaked one), a path/query/fragment
 * with it. Runs before {@link assertHttpsOrigin}, whose message quotes the
 * value. A trailing `/` is the origin. A STORED record or the environment
 * triple keeps normalizing to the origin: refusing there would break a
 * credential that works today, with nobody at a prompt to retype it.
 */
export function assertInstanceOrigin(value: string, label: string): void {
  refuseMistypedScheme(value, label);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return; // Not a URL at all — the caller's parse names that.
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(
      `${label} must not carry a user name or password (the \`user:password@\` part) — an instance is ` +
        `addressed by its origin, and the meta API token is what authenticates. Use ${url.origin}` +
        `${url.password === "" ? "" : ", and treat that password as exposed"}.`,
    );
  }
  if ((url.pathname === "" || url.pathname === "/") && url.search === "" && url.hash === "") return;
  throw new Error(
    `${label} must be the instance's origin — a scheme and host, with no path, query or fragment ` +
      `(got "${value}"). Use ${url.origin}.`,
  );
}

/**
 * Refuse a scheme typed twice (`http://https://host`) or not at all
 * (`host.xano.io`), naming the origin meant. `URL` reads the first as host
 * `https` — "Use http://https." — and the second as no URL, or as a scheme
 * (`host.xano.io:443`). The suggestion is an origin, so any `user:password@`
 * in the value is never echoed.
 */
function refuseMistypedScheme(value: string, label: string): void {
  const doubled = /^([a-z][a-z0-9+.-]*):\/\/+([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(value.trim());
  // A bare HOST only — dotted, or `localhost` — so a stray word is still "not a valid URL".
  const bare = value.trim();
  const hostLike = !bare.includes("://") && /^(?:[^\s/:@]+@)?(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?\/?$/i.test(bare);
  // Always https: `https://http://host` meant https, and `http://http://host`
  // suggested as `http://host` was then refused as not https (E2E pass 23).
  // Plain http is kept only where it is accepted — a loopback host.
  const loopback = doubled !== null && /^(?:[^/@]*@)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(doubled[3]!);
  const scheme = loopback && [doubled[1]!, doubled[2]!].every((x) => x.toLowerCase() === "http") ? "http" : "https";
  const meant = doubled !== null ? `${scheme}://${doubled[3]!}` : hostLike ? `https://${bare}` : undefined;
  if (meant === undefined) return;
  let origin: string;
  try {
    origin = new URL(meant).origin;
  } catch {
    return; // Still not a URL: the caller's parse names that.
  }
  if (origin === "null") return;
  throw new Error(
    doubled !== null
      ? `${label} has its scheme twice. Use ${origin}.`
      : `${label} needs a scheme (https://). Use ${origin}.`,
  );
}

/**
 * Refuse a sign-in server URL carrying a user name or password
 * (`https://user:pw@host`). An OAuth sign-in never authenticates that way, so
 * it is a pasted URL with a secret in it — and every later message that quoted
 * the value would print the secret into the terminal and the CI log. Refused
 * WITHOUT echoing the value: only the origin it names, which `URL` strips of
 * the userinfo.
 */
export function assertNoUserinfo(origin: string, label: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return; // Not a URL at all — assertHttpsOrigin names that.
  }
  if (url.username === "" && url.password === "") return;
  throw new Error(
    `${label} must not carry a user name or password (the \`user:password@\` part). A sign-in server ` +
      `is an origin, and the sign-in itself happens in the browser. Use ${url.origin}` +
      `${url.password === "" ? "" : ", and treat that password as exposed"}.`,
  );
}
