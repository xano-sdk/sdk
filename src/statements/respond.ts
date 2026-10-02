/**
 * `respond.*` — set the HTTP status, redirect, or add a response header.
 *
 * A Xano SDK endpoint answers **200** for everything that succeeds. The only other
 * statuses reachable were the five FAILURE codes `s.precondition` maps
 * (400/401/403/404/429), so a created resource could not answer 201 and there
 * was no redirect at all.
 *
 * `s.util.set_header` turns out to reach the status line: the engine passes its
 * value straight to the platform's header call, which special-cases a string
 * beginning `HTTP/`. All three helpers here are sugar over that one statement —
 * the emitted bytes are exactly what writing the header string by hand produces.
 * What they add is the spelling (nothing tells you the magic string), and the
 * refusals below.
 *
 * ## What a live sweep of every registered status code found
 *
 * Measured over real HTTP against a deployed endpoint, one endpoint per code.
 * Most codes take. These do NOT, and each one **silently answers 200** — the
 * header is written, the platform declines to act on it, and nothing reports
 * anything:
 *
 *   `308` Permanent Redirect · `425` Too Early · `451` Unavailable For Legal
 *   Reasons · `102` Processing · `103` Early Hints
 *
 * Those are all real, registered codes a reasonable person would reach for —
 * `451` for geo-blocking, `308` for a permanent API move — so each is refused
 * here by name, pointing at the nearest code that does work. A code the platform
 * does not know (an unregistered one) degrades the same silent way.
 *
 * `100` and `101` are worse than ignored: the response becomes unparseable and
 * an HTTP client errors rather than reading a status. `407` breaks a client too.
 * All three are refused.
 *
 * ## Two behaviors worth knowing
 *
 * **A later status wins.** Setting 201 and then 202 answers 202.
 *
 * **A failing `precondition` still wins**, whatever was set before it: a stack
 * that sets 201 and then fails an `accessdenied` precondition answers **403**
 * with the error body. So a status helper cannot defeat a guard placed after it,
 * which is the safe direction.
 */
import { generated } from "./generated/factories.generated.js";
import { c, withFilters } from "../values/value.js";
import { fl } from "../values/generated/filters.generated.js";
import type { Value } from "../values/value.js";
import type { Statement } from "./statement.js";
import { describeEntry, isTaggedArg } from "./args.js";
import { HEADER_BREAK, HEADER_NAME, literalText } from "./special/coerce.js";

/** The redirect statuses {@link RedirectStatus} names, checked at runtime too. */
const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307];

/**
 * A header value is a string or a tagged value. Through `any`, `null` was
 * concatenated onto the name (`concat [null]`) and stored a header line the
 * engine renders as the bare name.
 */
function assertHeaderValue(helper: string, field: string, v: unknown): void {
  if (typeof v === "string" || isTaggedArg(v)) return;
  throw new Error(`${helper}: ${field} must be a string or a tagged value (\`ref()\`, \`inp()\`, …) — got ${describeEntry(v)}.`);
}

/** A literal header value carrying CR, LF or NUL — a second header spliced into the response. */
function assertNoHeaderBreak(helper: string, field: string, v: unknown): void {
  const literal = literalText(v);
  if (literal === undefined || !HEADER_BREAK.test(literal)) return;
  throw new Error(
    `${helper}: ${field} ${JSON.stringify(literal)} contains a newline or NUL, which would splice a second header ` +
      `into the response. Strip it.`,
  );
}

/** Emit one raw header line. */
const setHeader = (value: Value, duplicates?: "replace" | "append"): Statement =>
  generated.util.set_header(
    duplicates === undefined ? { value } : { value, duplicates },
  ) as Statement;

/**
 * Codes the platform WRITES and then ignores, so the response is 200 — with the
 * nearest code that does work.
 *
 * Each measured over real HTTP; see the module note.
 */
const IGNORED_STATUS: Readonly<Record<number, string>> = {
  102: "an interim status a final response cannot carry — drop it",
  103: "an interim status a final response cannot carry — drop it",
  308: "use 301 (Moved Permanently), which is honored; 307 is the temporary equivalent",
  425: "use 429 (Too Many Requests) or 400, both honored",
  451: "use 403 (Forbidden), which is honored",
};

/**
 * Codes that make the response unparseable, so a client raises a transport error
 * instead of reading a status.
 */
const UNPARSEABLE_STATUS: Readonly<Record<number, string>> = {
  100: "an informational status is not a final response; an HTTP client errors on it",
  101: "a protocol switch is not something a stack can answer; an HTTP client errors on it",
  407: "proxy authentication needs headers this surface cannot supply; an HTTP client errors on it",
};

/** Redirect statuses measured to work. `308` is deliberately absent. */
export type RedirectStatus = 301 | 302 | 303 | 307;

function assertStatus(code: number): void {
  if (!Number.isInteger(code) || code < 100 || code > 599) {
    throw new Error(
      `respond.status(${code}): not an HTTP status code. Pass an integer between 100 and 599.`,
    );
  }
  const unparseable = (Object.hasOwn(UNPARSEABLE_STATUS, code) ? UNPARSEABLE_STATUS[code] : undefined);
  if (unparseable !== undefined) {
    throw new Error(`respond.status(${code}) is refused: ${unparseable}.`);
  }
  const ignored = (Object.hasOwn(IGNORED_STATUS, code) ? IGNORED_STATUS[code] : undefined);
  if (ignored !== undefined) {
    throw new Error(
      `respond.status(${code}) is refused: the platform writes the header and does not act on ` +
        `it, so the response is 200 — measured live, with nothing reported anywhere. ` +
        `Instead, ${ignored}.`,
    );
  }
}

export interface HeaderOptions {
  /**
   * `replace` (the default) overwrites a header of the same name; `append` adds
   * another line, which is what a multi-value header like `Set-Cookie` needs.
   */
  duplicates?: "replace" | "append";
}

export const respond = {
  /**
   * Answer with `code` instead of 200.
   *
   * ```ts
   * stack: [s.db.add({ table: notes, row, as: "note" }), respond.status(201)],
   * ```
   *
   * Position does not matter — the header is written while the stack runs and
   * the body is serialized afterwards, so this works before or after the
   * statement that builds the response.
   *
   * ⚠ A `204` answers with an EMPTY body whatever the def's `response` says:
   * that is HTTP, not this helper. Do not pair it with a response a client
   * needs to read.
   *
   * See the module note for the codes this refuses and why.
   */
  status: (code: number): Statement => {
    assertStatus(code);
    return setHeader(c.text(`HTTP/1.1 ${code}`));
  },

  /**
   * Redirect to `url` — the status line plus the `Location` header, as a
   * fixed-arity tuple to spread:
   *
   * ```ts
   * stack: [s.set_var("target", ref("row.url")), ...respond.redirect(ref("target"))],
   * ```
   *
   * `url` takes a literal or any `Value` (a `ref`, an `inp`, a filtered chain);
   * a computed one is concatenated onto the header at request time.
   *
   * Defaults to **302** (temporary, and a client may switch the method to GET).
   * `301` is the permanent form, `307` the temporary one that PRESERVES the
   * method, and `303` forces GET. **`308` is not offered** — the platform
   * ignores it and answers 200, measured live.
   *
   * ⚠ A `Location` header alone does NOT redirect: without the status line the
   * response is a 200 carrying a header no client acts on. That is the whole
   * reason this emits both.
   */
  redirect: (url: string | Value, opts: { status?: RedirectStatus } = {}) => {
    assertHeaderValue("respond.redirect", "url", url);
    assertNoHeaderBreak("respond.redirect", "url", url);
    // `null` options (through `any`) are the defaults they mean.
    opts = opts ?? {};
    if (opts.status !== undefined && !REDIRECT_STATUSES.includes(opts.status)) {
      throw new Error(
        `respond.redirect: status ${JSON.stringify(opts.status)} is not a redirect — use ${REDIRECT_STATUSES.join(", ")} ` +
          `(302 when omitted). 308 is not offered: the platform answers 200 for it. A non-3xx status with a ` +
          `Location header redirects nothing; for another status use respond.status().`,
      );
    }
    const location =
      typeof url === "string"
        ? c.text(`Location: ${url}`)
        : withFilters(c.text("Location: "), fl.concat(url));
    return [respond.status(opts.status ?? 302), setHeader(location)] as const satisfies readonly Statement[];
  },

  /**
   * Add a response header, `name` and `value` given separately.
   *
   * The underlying statement takes ONE string — `"X-Request-Id: abc"` — so a
   * computed value has to be concatenated onto the name by hand. This does that,
   * and keeps a literal a literal.
   *
   * ```ts
   * respond.header("Cache-Control", "public, max-age=60"),
   * respond.header("X-Request-Id", ref("id")),
   * ```
   */
  header: (name: string, value: string | Value, opts: HeaderOptions = {}): Statement => {
    if (typeof name !== "string") {
      throw new Error(`respond.header: the header name must be a string — got ${describeEntry(name)}.`);
    }
    assertHeaderValue("respond.header", "value", value);
    opts = opts ?? {};
    if (opts.duplicates !== undefined && opts.duplicates !== "replace" && opts.duplicates !== "append") {
      throw new Error(
        `respond.header: duplicates accepts only "replace" | "append" — got ${typeof opts.duplicates === "string" ? JSON.stringify(opts.duplicates) : describeEntry(opts.duplicates)}.`,
      );
    }
    if (!HEADER_NAME.test(name)) {
      throw new Error(
        `respond.header: ${JSON.stringify(name)} is not a header name — use the token charset (letters, digits and ` +
          "!#$%&'*+-.^_`|~), with no whitespace and no colon (the colon is added for you). Pass the name and the " +
          `value separately: respond.header("X-Request-Id", ref("id")).`,
      );
    }
    assertNoHeaderBreak("respond.header", "value", value);
    const line =
      typeof value === "string"
        ? c.text(`${name}: ${value}`)
        : withFilters(c.text(`${name}: `), fl.concat(value));
    return setHeader(line, opts.duplicates);
  },
} as const;
