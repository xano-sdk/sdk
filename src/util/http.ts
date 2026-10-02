/**
 * The two ways a meta-API call goes wrong, phrased for a human reading a
 * terminal — shared by every transport in `src/deploy/` and every command in
 * `src/emit/` so a failure reads the same wherever it happened.
 *
 *   • The instance answered, badly (4xx/5xx). The server already wrote a
 *     sentence explaining itself; {@link httpFailure} shows THAT, on one line,
 *     instead of pasting the whole JSON envelope into the middle of a progress
 *     log. The raw body stays one env var away — see {@link debugEnabled}.
 *   • The instance never answered. `fetch` collapses every transport failure
 *     into the same opaque `TypeError: fetch failed` and hides the reason a
 *     level down in `cause`, so {@link fetchOrExplain} names the URL it was
 *     trying to reach and the code that killed it.
 *
 * Plain `fetch` and `process.env` only: no Node built-ins, so importing this
 * from a browser-reachable module costs nothing.
 */

/** How long the raw body may run before the one-line form truncates it. */
const MAX_DETAIL_CHARS = 500;

/**
 * Whether to print the diagnostics a normal run suppresses.
 *
 * Follows `XANOSDK_NO_UPDATE_CHECK` in update-check.ts: presence is the signal,
 * with the two values people type to mean "off" honored so `XANOSDK_DEBUG=0`
 * cannot silently turn debugging ON.
 */
export function debugEnabled(): boolean {
  const v = readEnvVar("XANOSDK_DEBUG")?.trim();
  return v !== undefined && v !== "0" && v.toLowerCase() !== "false";
}

/**
 * The server's own sentence, mined out of an error body.
 *
 * The meta API and the catalogue both answer a failure with
 * `{code, message, payload}`, and `message` is already the readable half — the
 * rest is an envelope the reader has to skip. JSON without a `message` has no
 * sentence (`undefined`) — its payload is never echoed; an HTML page is named by
 * its title; plain text contributes its first line only. `undefined` means
 * there was nothing to say.
 *
 * Always one line, so it can be appended to a status line without turning one
 * failure into a page. The full text remains available under `XANOSDK_DEBUG`.
 */
export function serverMessage(text: string): string | undefined {
  let parsed: unknown;
  let isJson = false;
  try {
    parsed = JSON.parse(text);
    isJson = true;
  } catch {
    /* not JSON */
  }
  if (isJson) {
    // The server's `message`, and only that: the rest of a JSON body is an
    // envelope or a payload, never something to paste into a status line.
    const message =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { message?: unknown }).message
        : undefined;
    if (typeof message !== "string") return undefined;
    const flat = message.replace(/\s+/g, " ").trim();
    if (flat === "") return undefined;
    return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS)}…` : flat;
  }
  // An HTML page (a proxy's 404, a login wall, a wrong host entirely) is never
  // a sentence: printed raw it is hundreds of characters of markup.
  const page = markupSummary(text);
  if (page !== undefined) return page;
  // Plain text: its first line, which is where a server puts its sentence — a
  // whole body (a stack trace, a dump) is never echoed. `XANOSDK_DEBUG` has it.
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
  if (first === undefined) return undefined;
  const flat = first.replace(/\s+/g, " ");
  return flat.length > MAX_LINE_CHARS ? `${flat.slice(0, MAX_LINE_CHARS)}…` : flat;
}

/** How long a plain-text body's first line may run before it is cut. */
const MAX_LINE_CHARS = 200;

/**
 * A one-line stand-in for an error body that is an HTML page, or undefined when
 * it is not one. The page's `<title>` is the only part worth reading; the rest
 * is markup that turns a one-line failure into a screenful. Callers print this
 * INSTEAD of the body, so no raw HTML reaches an error message. A noun phrase,
 * not a sentence: callers set it after their own "answered HTTP 500 —", so it
 * must not repeat the verb.
 */
export function markupSummary(text: string): string | undefined {
  const head = text.trimStart().slice(0, 512).toLowerCase();
  const isMarkup =
    head.startsWith("<!doctype html") || head.startsWith("<html") || /<(html|head|body|title)[\s>]/.test(head);
  if (!isMarkup) return undefined;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.replace(/\s+/g, " ").trim();
  // No title: a bare `<html>502 Bad Gateway</html>` is still worth quoting —
  // but only when its text is short enough to be a sentence, not a page.
  const bare = text
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const shown =
    title !== undefined && title !== "" ? title.slice(0, 120) : bare !== "" && bare.length <= 120 ? bare : undefined;
  return shown !== undefined
    ? `an HTML page ("${shown}"), not an API response`
    : "an HTML page, not an API response";
}

/**
 * The failure for a 2xx answer that is not JSON, in one line: WHO answered (the
 * host, as {@link transportTarget} names it) and WHAT came back, summarised.
 *
 * Never the route path — it is the SDK's wire protocol, not something a reader
 * acts on — and never the body: a captive portal or a proxy answers with a
 * whole page, and an unlabelled body from a real workspace can carry anything.
 * An HTML page is named by its `<title>` alone, which is what tells a login
 * wall from a gateway error; its text is never quoted. Anything else is only
 * said to not be JSON.
 *
 * `safe` is for a route that reaches a real workspace or tenant (the
 * {@link safeHttpFailure} callers): not even the title is quoted, and the body
 * is not appended under `XANOSDK_DEBUG` either. Elsewhere the raw body stays one
 * env var away ({@link debugEnabled}).
 */
export function notJsonError(
  action: string,
  text: string,
  url?: string,
  opts: { safe?: boolean; aftermath?: string } = {},
): Error {
  const where = url === undefined || url === "" ? "the instance" : transportTarget(url);
  const isPage = markupSummary(text) !== undefined;
  const titled = isPage && opts.safe !== true && /<title[^>]*>\s*\S[\s\S]*?<\/title>/i.test(text);
  const what = isPage
    ? `${titled ? markupSummary(text) : "an HTML page, not an API response"} — a proxy or captive portal between you and the instance?`
    : text.trim() === ""
      ? "an empty body, not an API response."
      : "something that is not JSON, not an API response.";
  const head = `${action}: ${where} answered with ${what}${opts.aftermath !== undefined ? `\n${opts.aftermath}` : ""}`;
  return new Error(opts.safe !== true && debugEnabled() && text.trim() !== "" ? `${head}\n${text}` : head);
}

/**
 * The failure for a 2xx that IS JSON but not the answer the request expects —
 * a wrong-shaped body from a proxy, a stub, or a route that changed. The same
 * refusal as {@link notJsonError}, for the half that parsed: a 200 is only
 * success when it carries what success carries, so a caller never reads
 * "no name" or "no url" off a stranger's body as an empty result.
 *
 * Never the body, never the route (the raw body is one {@link debugEnabled}
 * away unless `safe`). `aftermath` says what the unreadable answer means for a
 * write — {@link SENT_AFTERMATH} for most — and is omitted for a read.
 */
export function unexpectedAnswerError(
  action: string,
  text: string,
  url?: string,
  opts: { safe?: boolean; aftermath?: string } = {},
): Error {
  const where = url === undefined || url === "" ? "the instance" : transportTarget(url);
  const head =
    `${action}: ${where} answered with something that is not the answer this request expects.` +
    `${opts.aftermath !== undefined ? `\n${opts.aftermath}` : ""}`;
  return new Error(opts.safe !== true && debugEnabled() && text.trim() !== "" ? `${head}\n${text}` : head);
}

/**
 * `JSON.parse` for an answer the meta API gave, failing through
 * {@link notJsonError} — so no caller can put the route or the body in front of
 * a reader by writing its own catch.
 */
export function parseJsonAnswer(
  text: string,
  action: string,
  url?: string,
  opts: { safe?: boolean; aftermath?: string } = {},
): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw notJsonError(action, text, url, opts);
  }
}

/**
 * Read a meta-API response as JSON: a non-2xx through {@link httpFailure} (or
 * {@link safeHttpFailure} with `safe`, for a route that reaches a real
 * workspace), and a 2xx that is not JSON through {@link notJsonError}. The one
 * reader every meta JSON call shares. `url` names the host in the failure —
 * never its path; defaults to the response's own.
 */
export async function readJsonAnswer(
  res: Response,
  action: string,
  opts: { url?: string; safe?: boolean; aftermath?: string } = {},
): Promise<unknown> {
  const text = await readBodyText(res, action, { url: opts.url });
  if (!res.ok) throw new Error(opts.safe === true ? safeHttpFailure(action, res, text) : httpFailure(action, res, text));
  return parseJsonAnswer(text, action, opts.url ?? res.url, { safe: opts.safe, aftermath: opts.aftermath });
}

/**
 * A request that got no complete answer: refused, reset, timed out, or dropped
 * while its body was being read. Typed so a caller can tell a transport failure
 * (retry; nothing is known about the target) from a bad answer (the target
 * spoke, wrongly) without matching on wording. `timeout` is our own deadline
 * expiring rather than the network failing.
 */
export class TransportError extends Error {
  override readonly name = "TransportError";
  constructor(
    message: string,
    readonly timeout: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Whether a body read failed on the wire — a drop mid-body (`terminated`), a
 * reset, our deadline — rather than on a programming error such as a body read
 * twice, which must surface as itself.
 */
function isBodyTransportFailure(err: unknown): boolean {
  if (isTimeoutError(err)) return true;
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "AbortError") return true;
  if (typeof (err as { cause?: { code?: unknown } } | null)?.cause?.code === "string") return true;
  return err instanceof TypeError && /terminated|fetch failed|socket|network|ECONN/i.test(err.message);
}

/**
 * Phrase a body read that died on the wire, host only — the request was
 * answered, so this is never "could not reach". `aftermath` says what the lost
 * answer means for the target; a read defaults to "nothing was changed".
 */
export function explainBodyFailure(
  err: unknown,
  opts: { url: string; what: string; timeoutMs?: number; aftermath?: string; display?: string },
): TransportError {
  const where = opts.display ?? transportTarget(opts.url);
  const redirected = redirectFailure(err, opts.url);
  if (redirected !== undefined) {
    const head = `${opts.what}: ${where} ${redirected}`;
    return new TransportError(opts.aftermath === undefined ? head : `${head}\n${opts.aftermath}`, false, { cause: err });
  }
  const timeout = isTimeoutError(err);
  const head = timeout
    ? `${opts.what}: ${where} did not finish answering` +
      (opts.timeoutMs !== undefined ? ` within ${seconds(opts.timeoutMs)}` : "") +
      ` — the read timed out.`
    : `${opts.what}: the connection to ${where} dropped before the answer was fully read (${describeTransportFailure(err)}).`;
  return new TransportError(`${head}\n${opts.aftermath ?? READ_AFTERMATH}`, timeout, { cause: err });
}

/**
 * `res.text()`, with a failure on the wire reported through
 * {@link explainBodyFailure}. A response from {@link fetchOrExplain} or
 * {@link fetchReadOrExplain} already reads this way; this is for one that did not.
 */
export async function readBodyText(
  res: Response,
  what: string,
  opts: { url?: string; timeoutMs?: number; aftermath?: string } = {},
): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    if (err instanceof TransportError || !isBodyTransportFailure(err)) throw err;
    throw explainBodyFailure(err, { url: opts.url ?? res.url, what, timeoutMs: opts.timeoutMs, aftermath: opts.aftermath });
  }
}

/** {@link readBodyText} for bytes. */
export async function readBodyBytes(
  res: Response,
  what: string,
  opts: { url?: string; timeoutMs?: number; aftermath?: string } = {},
): Promise<Uint8Array> {
  try {
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    if (err instanceof TransportError || !isBodyTransportFailure(err)) throw err;
    throw explainBodyFailure(err, { url: opts.url ?? res.url, what, timeoutMs: opts.timeoutMs, aftermath: opts.aftermath });
  }
}

/**
 * The same response, its body readers reporting a failure on the wire through
 * {@link explainBodyFailure} — so no caller that fetched through the shared
 * helpers prints a bare `terminated` for a connection that dropped mid-body.
 * A `json()` that fails to PARSE is left as it is: that is a bad answer.
 */
function explainingBody(
  res: Response,
  opts: { url: string; what: string; timeoutMs?: number; aftermath?: string; display?: string },
): Response {
  for (const method of ["text", "arrayBuffer", "json", "blob", "bytes", "formData"] as const) {
    const original = (res as unknown as Record<string, unknown>)[method];
    if (typeof original !== "function") continue;
    Object.defineProperty(res, method, {
      configurable: true,
      value: async (...a: unknown[]): Promise<unknown> => {
        try {
          return await (original as (...x: unknown[]) => Promise<unknown>).apply(res, a);
        } catch (err) {
          if (err instanceof TransportError || !isBodyTransportFailure(err)) throw err;
          throw explainBodyFailure(err, opts);
        }
      },
    });
  }
  return res;
}

/** What a lost or unreadable answer means for a request that may have changed something. */
export const SENT_AFTERMATH = "The request was sent, so it may or may not have taken effect — check before retrying.";

/**
 * Whether a WRITE the server answered with `status` was refused as a whole:
 * a 4xx, or a 501 (the server does not implement the route, so ran nothing).
 * Anything else — a 5xx above all, and a gateway's 502/503/504 in
 * particular, which a proxy sends when the server behind it stopped answering,
 * finished or not — leaves the write's outcome unknown (E2E pass 22: a `release
 * delete` answered 502 had deleted the release).
 *
 * `atomic` is for a write the server applies whole or not at all (the import,
 * a static build): its OWN 5xx answer then means "not at all", and only a
 * gateway status — which stands in for an answer the server may never have
 * sent — leaves the outcome unknown.
 *
 * The one rule: every write transport phrases its status failure through
 * {@link writeStatusAftermath}, and the operation classifier reads a status
 * through this.
 */
export function writeRefusedBy(status: number, opts: { atomic?: boolean } = {}): boolean {
  if (opts.atomic === true) return !GATEWAY_STATUSES.has(status);
  return (status >= 400 && status < 500) || status === 501;
}

/** The statuses a gateway answers with in place of the server behind it: bad gateway, unavailable, timed out. */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * The line a WRITE's status failure carries under its head: `aftermath`
 * ({@link SENT_AFTERMATH} unless the caller has a truer one) when the status
 * leaves the outcome unknown, nothing for a refusal.
 */
export function writeStatusAftermath(
  status: number,
  aftermath: string = SENT_AFTERMATH,
  opts: { atomic?: boolean } = {},
): string | undefined {
  return writeRefusedBy(status, opts) ? undefined : aftermath;
}

/**
 * Codes a connection fails with only once the request was on an OPEN socket:
 * the server closed it while the answer was awaited (`UND_ERR_SOCKET` — "other
 * side closed"). The instance was reached; what was lost is the answer. Not
 * `ECONNRESET`: a reset can come during the handshake, before anything was sent.
 */
const OPENED_THEN_LOST: ReadonlySet<string> = new Set(["UND_ERR_SOCKET"]);

/** Whether `err`'s cause chain says the connection had opened before it failed — see {@link OPENED_THEN_LOST}. */
export function answerWasLost(err: unknown): boolean {
  let next: unknown = err;
  for (let depth = 0; depth < 8 && next !== null && typeof next === "object"; depth++) {
    const code = (next as { code?: unknown }).code;
    if (typeof code === "string" && OPENED_THEN_LOST.has(code)) return true;
    next = (next as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A write's transport head said as what happened when {@link answerWasLost}:
 * `X could not reach <host>: …` becomes `X: the answer from <host> was lost — …`.
 * "Could not reach" beside "the request was sent" contradicted itself, and the
 * instance WAS reached (E2E pass 22). Anything else is returned unchanged.
 */
export function lostAnswerHead(head: string, err: unknown): string {
  if (!answerWasLost(err)) return head;
  const m = /^(.*?) could not reach (.+?): (.*)$/s.exec(head);
  return m === null ? head : `${m[1]}: the answer from ${m[2]} was lost — ${m[3]}`;
}

/** `head`, with the write's {@link writeStatusAftermath} on a line of its own when it has one. */
export function withWriteStatusAftermath(
  head: string,
  status: number,
  aftermath?: string,
  opts: { atomic?: boolean } = {},
): string {
  const line = writeStatusAftermath(status, aftermath, opts);
  return line === undefined ? head : `${head}\n${line}`;
}

/** Whether a request's method changes nothing, so a lost answer changed nothing either. */
function isReadMethod(init: RequestInit): boolean {
  const method = (init.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD";
}

/**
 * The server's sentence, and ONLY when the server actually labelled it one.
 *
 * {@link serverMessage} falls back to the whole body when the payload is not
 * JSON, or is JSON carrying no `message`. That is right for the routes it was
 * written for, which speak to a throwaway environment. It is wrong for a route
 * that speaks to a real workspace or a customer's tenant, where an unlabelled
 * error body can carry rows, identifiers, or a storage path naming the
 * workspace — straight into a terminal or a captured CI log.
 *
 * So this one returns undefined rather than falling through, and the caller
 * prints a bare status line. A missing detail is a worse error message; a
 * leaked body is a worse day.
 */
function labelledMessage(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const message = (parsed as { message?: unknown }).message;
  if (typeof message !== "string" || message === "") return undefined;
  const flat = message.replace(/\s+/g, " ").trim();
  if (flat === "") return undefined;
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS)}…` : flat;
}

/**
 * `502 Bad Gateway`, or `502` alone when the answer carried no reason phrase
 * (HTTP/2, some gateways) — never `502 ` with a dangling space.
 */
export function statusLabel(res: { status: number; statusText: string }): string {
  return res.statusText === "" ? String(res.status) : `${res.status} ${res.statusText}`;
}

/**
 * {@link httpFailure} for routes that reach something real.
 *
 * Same shape, two differences: the detail comes only from a labelled `message`,
 * and the raw body is never appended — not even under `XANOSDK_DEBUG`, since a
 * debug flag set once in CI would defeat the point.
 */
export function safeHttpFailure(
  action: string,
  res: { status: number; statusText: string },
  body: string,
  binding?: BindingContext,
): string {
  const detail = labelledMessage(body);
  const head = `${action} failed (${statusLabel(res)})${detail !== undefined ? `: ${detail}` : "."}`;
  if (res.status !== 403 || binding === undefined) return head;
  const why = explainBindingRefusal(binding);
  return why === undefined ? head : `${head}\n${why}`;
}

/**
 * What the CLI knows about a call, for deciding whether a 403 is the OAuth
 * workspace binding biting rather than an ordinary permissions refusal.
 */
import { isIP } from "node:net";
import { readEnvVar } from "./env.js";
import { UsageError } from "../emit/errors.js";
import { noteMetaAnswer } from "./last-credential.js";
import { profileSourceLabel, type ProfileSelection } from "../auth/profile-select.js";
import type { ResolvedAuth } from "../auth/token.js";

export interface BindingContext {
  /** Workspace the credential is bound to; undefined when that is what failed. */
  boundWorkspaceId: number | undefined;
  /** Workspace the request addressed. */
  addressedWorkspaceId: number;
  /** Instance the credential addresses, so the message names both halves of the target. */
  instance?: string;
  /** Which credential arm minted the token. */
  credentialType: "oauth" | "oauth-refresh" | "token";
  /** Whether the call went to a TENANT's own host rather than the instance. */
  tenantHost: boolean;
  /**
   * The stored profile this credential came from, and the rung that chose it.
   * Absent on the environment-credential paths, which have no profile.
   *
   * The predictable new failure is "right credentials, wrong profile", and the
   * old remedy — run `whoami`, or `login` again — is the wrong advice for
   * someone who HAS the right profile and picked another one.
   */
  profile?: ProfileSelection;
}

/**
 * The {@link BindingContext} for a call made with `auth` to `workspaceId`.
 * `tenantHost` is the caller's to say: only the call site knows whether it
 * addressed a host of its own (a tenant's or an ephemeral's) rather than the
 * instance the credential was minted for.
 */
export function bindingFor(
  auth: Pick<ResolvedAuth, "workspaceId" | "instance" | "profile" | "credentialType">,
  workspaceId: number,
  tenantHost: boolean,
): BindingContext {
  return {
    boundWorkspaceId: auth.workspaceId,
    instance: auth.instance,
    profile: auth.profile,
    addressedWorkspaceId: workspaceId,
    credentialType: auth.credentialType,
    tenantHost,
  };
}

/**
 * The sentence explaining a workspace-binding refusal, or undefined when this
 * 403 is not one.
 *
 * An OAuth-minted token is pinned to the workspace it was issued for across the
 * whole meta API, and the refusal that produces says only
 * `{"code":"ERROR_CODE_ACCESS_DENIED","message":"Access Denied."}` — labelled,
 * so it survives {@link safeHttpFailure}, and useless, because it names neither
 * workspace. The explanation is therefore COMPOSED here from what the CLI
 * already holds. Do not try to extract a better one from the body; there isn't
 * one, and relaxing the body suppression to look would defeat its purpose.
 *
 * Three cases deliberately return undefined, because labelling them a binding
 * problem sends the reader to the wrong fix:
 *
 * - **A tenant's own host.** Every such call addresses workspace 1 on a host the
 *   credential was not minted for, so the ids ALWAYS differ there and mere
 *   difference proves nothing. Measured: the binding permits this shape, so a
 *   403 here is something else entirely.
 * - **A legacy static token.** It carries no workspace binding at all, so the
 *   gate never fires for it. Measured: such a token reads every workspace.
 * - **Same workspace.** The credential is where it should be; this is an
 *   ordinary permissions refusal.
 */
export function explainBindingRefusal(
  ctx: BindingContext,
  flag: string = ctx.profile?.flag ?? "--profile",
): string | undefined {
  if (ctx.tenantHost) return undefined;
  if (ctx.credentialType === "token") return undefined;
  if (ctx.boundWorkspaceId !== undefined && ctx.boundWorkspaceId === ctx.addressedWorkspaceId) {
    return undefined;
  }

  const arm =
    ctx.credentialType === "oauth-refresh"
      ? `This credential came from \`XANO_REFRESH_TOKEN\`, which resolves its workspace at run time — ` +
        `check that the refresh token was minted for workspace ${ctx.addressedWorkspaceId}.`
      : profileRemedy(ctx.profile, flag);

  const whose =
    ctx.profile === undefined ? "This credential" : `Profile "${ctx.profile.name}"`;

  return (
    `${whose} is bound to ` +
    `${ctx.boundWorkspaceId === undefined ? "a different workspace" : `workspace ${ctx.boundWorkspaceId}`}` +
    ` on ${ctx.instance ?? "this instance"}` +
    `, and this call addressed workspace ${ctx.addressedWorkspaceId}. ` +
    `A token can only act on the workspace it was issued for.\n` +
    arm
  );
}

/**
 * What to do about it, keyed on whether the profile was CHOSEN.
 *
 * An explicit `--profile` means the user picked this one deliberately: the
 * thing to check is which profile addresses the workspace they wanted, not
 * their sign-in. An implicit selection means the machine picked, and the fix is
 * to pick a different one — which is what `--profile` and `profile use` do.
 *
 * `flag` is the flag that selected the profile being refused. It is `--profile`
 * for the credential a command acts as, and only then is the wording the
 * long-standing one. A SECOND credential named by another flag — a transfer's
 * destination — gets a remedy that names that flag, because `--profile` there
 * would retarget the source, not the destination the reader is trying to fix.
 * `whoami` is left out of that one for the same reason: it reports the active
 * credential, which is not the one that was refused.
 */
function profileRemedy(profile: ProfileSelection | undefined, flag: string): string {
  if (profile !== undefined && profile.source === "flag" && flag !== "--profile") {
    return (
      `Run \`xanosdk profile list\` to see which profile addresses the workspace you meant, ` +
      `then name it with \`${flag} <name>\`.`
    );
  }
  if (profile === undefined || profile.source === "flag" || profile.source === "env") {
    return (
      `Run \`xanosdk profile list\` to see which profile addresses the workspace you meant, or ` +
      `\`xanosdk whoami\` for this one's binding.`
    );
  }
  return (
    `Nothing on the command line selected this profile — it came from ` +
    `${profileSourceLabel(profile.source, profile.defaultIn)}. ` +
    `Run \`xanosdk profile list\` to see the others, then \`--profile <name>\` for one run or ` +
    `\`xanosdk profile use <name>\` to pin this project to it.`
  );
}

/**
 * `<action> failed (<status> <statusText>): <the server's sentence>` — one line.
 *
 * The status pair is kept even though the sentence usually carries the meaning:
 * it is the part a bug report needs and the part callers special-case on (a 404
 * is "not there", not "broken"). Under `XANOSDK_DEBUG` the untouched body is
 * appended below.
 */
export function httpFailure(
  action: string,
  res: { status: number; statusText: string },
  body: string,
): string {
  const detail = serverMessage(body);
  const head = `${action} failed (${statusLabel(res)})${detail !== undefined ? `: ${detail}` : "."}`;
  return debugEnabled() && body.trim() !== "" ? `${head}\n${body}` : head;
}

/** `text` with its full stop: a clause ending on an unpunctuated detail (`…: Invalid token`) is closed. */
export function closeSentence(text: string): string {
  const t = text.trimEnd();
  return t === "" || /[.!?…]["')\]]*$/.test(t) ? t : `${t}.`;
}

/**
 * `message` with `sentence` after its first line, that line closed first — so
 * a server's unpunctuated detail (`…failed (401): Invalid token`, `…not an API
 * response`) and the next sentence never run together. Lines below the first
 * (a `XANOSDK_DEBUG` body) stay below.
 */
export function appendSentence(message: string, sentence: string): string {
  const [first = "", ...rest] = message.split("\n");
  return [`${closeSentence(first)} ${sentence}`.trimStart(), ...rest].join("\n");
}

/** {@link httpFailure} as a throwable, with the body kept on the error for callers that want it. */
export function httpFailureError(
  action: string,
  res: { status: number; statusText: string },
  body: string,
): Error {
  return new Error(httpFailure(action, res, body));
}

/**
 * Unwrap what actually went wrong on the wire.
 *
 * `fetch` reports every transport failure as the same opaque `TypeError: fetch
 * failed`, and puts the reason a connection died — `ECONNRESET`, `ETIMEDOUT`,
 * a TLS or DNS failure — one level down in `cause`. Reporting only the outer
 * message tells the reader nothing they can act on.
 */
export function describeTransportFailure(err: unknown): string {
  const cause = (err as { cause?: unknown })?.cause;
  // fetch's own text for a refused header quotes the header's value — for
  // `Authorization`, the bearer token — so it is never passed on.
  if (isInvalidRequestHeader(err)) return INVALID_HEADER;
  const certificate = certificateFailureCode(err);
  if (certificate !== undefined) return describeCertificateFailure(certificate);
  if (isBlockedPort(err)) {
    return `its port is one fetch refuses to connect to (a blocked port, e.g. 1 or 25) — nothing was sent. Check the port in the URL.`;
  }
  const code = (cause as { code?: unknown })?.code;
  const outer = err instanceof Error ? err.message : String(err);
  if (typeof code === "string") return `${outer} (${code})`;
  // A cause without a code still carries the sentence — `String(err)` on an
  // Error prefixes it with "Error:", which reads as a second failure rather
  // than the reason for the first one.
  if (cause instanceof Error && cause.message !== "") return `${outer} (${cause.message})`;
  if (cause !== undefined && cause !== null) return `${outer} (${String(cause)})`;
  return outer;
}

const INVALID_HEADER =
  "a request header holds a character no request can carry (a line break, a control or a non-ASCII character), " +
  "so nothing was sent. Check the credential's token for stray characters.";

/**
 * fetch refused a request header's VALUE before sending anything — a token with
 * a line break, a control or a non-Latin-1 character. A fault in what the run
 * was given, not in the network: retrying sends the same header.
 */
export function isInvalidRequestHeader(err: unknown): boolean {
  const message = err instanceof Error ? err.message : "";
  if (/is an invalid header value|Cannot convert argument to a ByteString/.test(message)) return true;
  const cause = (err as { cause?: { code?: unknown; message?: unknown } })?.cause;
  return cause?.code === "UND_ERR_INVALID_ARG" && /header/i.test(String(cause.message ?? ""));
}

/**
 * The codes a TLS handshake fails with when the client cannot verify the
 * server's certificate. The connection is closed before any request is
 * written, so nothing was sent — and the same certificate is refused on every
 * attempt.
 */
export const TLS_CERTIFICATE_CODES: ReadonlySet<string> = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "CERT_CHAIN_TOO_LONG",
  "INVALID_CA",
  "INVALID_PURPOSE",
  "HOSTNAME_MISMATCH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
]);

/** The codes a TLS-intercepting proxy signing with a CA this machine does not trust typically produces. */
const PROXY_CERTIFICATE_CODES: ReadonlySet<string> = new Set(["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"]);

/** The TLS verification code on `err`'s cause chain, or `undefined` when the failure was not a certificate's. */
export function certificateFailureCode(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 8; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && TLS_CERTIFICATE_CODES.has(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The host a certificate failure was at, as its transport message names it
 * (origin only — never a path or query), or "the server" when it names none.
 */
export function certificateFailureHost(err: unknown): string {
  for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 8; depth++) {
    const m = e instanceof Error ? /could not reach (https?:\/\/[^\s/]+?)(?=: |\/| |$)/.exec(e.message) : null;
    if (m !== null) {
      try {
        return new URL(m[1]!).host;
      } catch {
        break;
      }
    }
    e = (e as { cause?: unknown }).cause;
  }
  return "the server";
}

/** The phrase every certificate failure is said with; a caller reading a message for one matches it. */
export const UNTRUSTED_CERTIFICATE = "the server's TLS certificate is not trusted";

/**
 * A certificate the handshake refused, as the rest of a "could not reach X:"
 * sentence. Never advice to switch verification off: the run carries a
 * credential, and an unverifiable certificate can be an interception.
 */
export function describeCertificateFailure(code: string): string {
  const proxy = PROXY_CERTIFICATE_CODES.has(code)
    ? " If a corporate proxy re-signs HTTPS traffic, point NODE_EXTRA_CA_CERTS at its CA certificate file."
    : "";
  return (
    `${UNTRUSTED_CERTIFICATE} (${code}), so nothing was sent — a certificate or proxy configuration problem, ` +
    `not a network blip, and retrying will not help until it is fixed.${proxy}`
  );
}

/** fetch refused the URL's port outright (the fetch standard's blocked-port list) — permanent, nothing sent. */
function isBlockedPort(err: unknown): boolean {
  const cause = (err as { cause?: unknown })?.cause;
  return cause instanceof Error && cause.message === "bad port";
}

/**
 * Whether the request was abandoned by our own deadline rather than refused by
 * the network. `AbortSignal.timeout` rejects with a `TimeoutError` DOMException,
 * which is not an `Error` subclass everywhere, so this matches on `name`.
 */
export function isTimeoutError(err: unknown): boolean {
  return typeof (err as { name?: unknown })?.name === "string" && (err as { name: string }).name === "TimeoutError";
}

/** Seconds, without a trailing `.0` — `30s`, `2.5s`. */
function seconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))}s`;
}

/**
 * Where a dead request was going, as a user-facing line may say it: the
 * instance (its origin, plus a `/tenant/<name>` prefix when the backend is
 * addressed through one) — never the route path or its query.
 *
 * A route path is the SDK's wire protocol, not something the reader can act
 * on, and some of it is not the SDK's to publish; a query carries the flags a
 * write was sent with. "could not reach" is about the HOST, so the host is the
 * whole answer. Everything from the first `/api:` segment on is dropped; a URL
 * with no API segment keeps its path (a download, a registry) without its query.
 */
export function transportTarget(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "the instance";
  }
  const cut = parsed.pathname.search(/\/api:/);
  const path = (cut === -1 ? parsed.pathname : parsed.pathname.slice(0, cut)).replace(/\/$/, "");
  return `${parsed.origin}${path}`;
}

/**
 * Phrase a dead request. Split from {@link fetchOrExplain} so a caller with its
 * own aftermath text (the import transport has to say whether anything landed)
 * can reuse the wording without the wrapper.
 *
 * A timeout and a refused connection get different sentences on purpose: one
 * means the instance is there and slow — worth waiting out — and the other means
 * nothing answered at all, which is a network or an address to check.
 */
export function explainFetchFailure(
  err: unknown,
  opts: { url: string; what: string; timeoutMs?: number; display?: string; aftermath?: string },
): TransportError {
  // `display` stands in for a URL that must not be printed. A pre-signed
  // storage link carries its own credential in the query string, so a dropped
  // download would otherwise put one in a terminal scrollback or a CI log.
  const where = opts.display ?? transportTarget(opts.url);
  const redirected = redirectFailure(err, opts.url);
  if (redirected !== undefined) {
    const head = `${opts.what}: ${where} ${redirected}`;
    return new TransportError(opts.aftermath === undefined ? head : `${head}\n${opts.aftermath}`, false, { cause: err });
  }
  const timeout = isTimeoutError(err);
  const within = opts.timeoutMs !== undefined ? ` within ${seconds(opts.timeoutMs)}` : "";
  // With an `aftermath` (a read's "Nothing was changed — retry."), the retry is
  // said there, once, on its own line — as a drop mid-body says it.
  // A blocked port and an untrusted certificate fail the same way every time,
  // before anything is sent: no retry advice, and no aftermath that says a
  // write may have landed.
  if (opts.aftermath !== undefined && !isBlockedPort(err) && certificateFailureCode(err) === undefined) {
    const head = timeout
      ? `${opts.what}: ${where} did not answer${within}. The instance may still be starting up or under load.`
      : closeSentence(`${opts.what} could not reach ${where}: ${describeTransportFailure(err)}`);
    return new TransportError(`${head}\n${opts.aftermath}`, timeout, { cause: err });
  }
  const message = timeout
    ? `${opts.what}: ${where} did not answer${within}. The instance may still be starting up or under load — retry, or raise the wait.`
    : `${opts.what} could not reach ${where}: ${describeTransportFailure(err)}`;
  return new TransportError(message, timeout, { cause: err });
}

/**
 * The host a request failed to resolve when it is NOT `url`'s own — the target
 * of a redirect the instance answered with — or undefined. A DNS failure names
 * the host it looked up on the error's cause chain.
 */
export function redirectedUnresolvedHost(err: unknown, url: string): string | undefined {
  let own: string;
  try {
    own = new URL(url).hostname;
  } catch {
    return undefined;
  }
  for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 5; depth++) {
    const { code, hostname } = e as { code?: unknown; hostname?: unknown };
    if (code === "ENOTFOUND" && typeof hostname === "string" && hostname !== "") {
      return hostname.replace(/^\[|\]$/g, "") === own.replace(/^\[|\]$/g, "") ? undefined : hostname;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The fetch standard's blocked ports: fetch refuses a URL on one of these before connecting. */
const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111,
  113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548,
  554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665,
  6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/**
 * How a request failed when the failure is at the target of a redirect the
 * instance answered with, not at `url` itself — the rest of a sentence that
 * starts with `url`'s host — or undefined. Read off the error's cause chain: a
 * DNS miss names the host it looked up, a refused or unreachable connection
 * the address and port it dialled, and a blocked port (which fetch refuses
 * before dialling) is a redirect's whenever `url`'s own port is not one.
 */
export function redirectFailure(err: unknown, url: string): string | undefined {
  let own: URL;
  try {
    own = new URL(url);
  } catch {
    return undefined;
  }
  const unresolved = redirectedUnresolvedHost(err, url);
  if (unresolved !== undefined) return `redirected to ${unresolved}, which does not resolve (ENOTFOUND). Check where that host points.`;
  const ownHost = own.hostname.replace(/^\[|\]$/g, "");
  const ownPort = own.port === "" ? (own.protocol === "https:" ? "443" : "80") : own.port;
  if (isBlockedPort(err)) {
    return BLOCKED_PORTS.has(Number(ownPort))
      ? undefined
      : `redirected to a port fetch refuses to connect to (a blocked port, e.g. 1 or 25), so nothing was sent there. Check where that redirect points.`;
  }
  for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 5; depth++) {
    const { code, address, port } = e as { code?: unknown; address?: unknown; port?: unknown };
    if (typeof code === "string" && typeof address === "string" && (typeof port === "number" || typeof port === "string")) {
      const otherPort = String(port) !== ownPort;
      const otherAddress = isIP(ownHost) !== 0 && address !== ownHost;
      if (!otherPort && !otherAddress) return undefined;
      const target = `${address.includes(":") ? `[${address}]` : address}:${port}`;
      const what = code === "ECONNREFUSED" ? "which refused the connection" : "which could not be reached";
      return `redirected to ${target}, ${what} (${code}). Check where that redirect points.`;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** What a lost answer means for a READ: it changed nothing, so it is safe to retry. */
export const READ_AFTERMATH = "Nothing was changed — retry.";

/**
 * `message` less the {@link READ_AFTERMATH} line — right for a read the reader
 * retries, wrong for one a run proceeds past (a status read after a deploy that
 * landed: "retry" there reads as "retry the deploy").
 */
export function withoutReadAftermath(message: string): string {
  return message
    .split("\n")
    .filter((line) => line !== READ_AFTERMATH)
    .join("\n");
}

/**
 * `fetch`, with a dropped connection reported as a sentence naming what could
 * not be reached instead of a bare `TypeError: fetch failed`.
 *
 * `what` is the action in the caller's own words (`"workspace list"`,
 * `"resolve sandbox"`) so the line reads as a step of the run that failed.
 * `timeoutMs` is only used for wording — the caller still owns the signal, since
 * it is the caller that knows what an upload's budget should be.
 */
export async function fetchOrExplain(
  url: string,
  init: RequestInit,
  what: string,
  timeoutMs?: number,
  display?: string,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchPastRateLimit(url, init, isReadMethod(init));
    await noteMetaAnswer(url, res);
  } catch (err) {
    // Fixed by correcting the credential, not by waiting: a usage failure.
    if (isInvalidRequestHeader(err)) throw new UsageError(`${what}: ${INVALID_HEADER}`);
    // A read that never got an answer changed nothing — said as a read that
    // lost its answer mid-body says it. A write's is left to its caller
    // (`writeTransportFailure`), which alone tells "never sent" from "may or
    // may not have taken effect".
    throw explainFetchFailure(err, {
      url,
      what,
      timeoutMs,
      display,
      ...(isReadMethod(init) ? { aftermath: READ_AFTERMATH } : {}),
    });
  }
  return explainingBody(res, {
    url,
    what,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(display !== undefined ? { display } : {}),
    ...(isReadMethod(init) ? {} : { aftermath: SENT_AFTERMATH }),
  });
}

/**
 * How many times a READ is attempted before its failure is reported.
 *
 * Three, with a short backoff: a connection refused mid-operation is ordinary on
 * a multi-minute release, and recovering from one took three manual attempts in
 * the field. Small enough that a genuinely dead instance still
 * fails in seconds rather than making someone wait out a doomed sequence.
 */
const READ_ATTEMPTS = 3;

/** Backoff between read attempts. Doubles each time: 400ms, then 800ms. */
const READ_BACKOFF_MS = 400;

/**
 * How long a rate-limited READ waits for its `Retry-After` before trying again.
 * A longer wait is not sat out: the run ends unanswered (exit 8) and names it,
 * rather than hanging a terminal or a CI step on the server's clock.
 */
export const RATE_LIMIT_MAX_WAIT_S = 5;

/** Retries a rate-limited read gets within {@link RATE_LIMIT_MAX_WAIT_S}. */
const RATE_LIMIT_RETRIES = 2;

/** The `Retry-After` of this process's most recent 429, in seconds. */
let lastRetryAfterS: number | undefined;

/**
 * The seconds a `Retry-After` header asks for — delta-seconds or an HTTP date —
 * or undefined when it is absent or unreadable.
 */
export function retryAfterSeconds(header: string | null, now: number = Date.now()): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const t = header.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const at = Date.parse(t);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/** Keep a 429's `Retry-After` for {@link lastRateLimitRetryAfter} — for a transport that calls `fetch` itself. */
export function noteRateLimit(res: Response): void {
  if (res.status === 429) lastRetryAfterS = retryAfterSeconds(res.headers?.get?.("retry-after") ?? null);
}

/** The `Retry-After` the last rate-limited answer carried, for the message that reports it. */
export function lastRateLimitRetryAfter(): number | undefined {
  return lastRetryAfterS;
}

/**
 * `fetch`, with a READ (`read`: a GET/HEAD, or a call its caller vouches changes nothing) the server answered 429 asked again after its
 * `Retry-After` when that is short ({@link RATE_LIMIT_MAX_WAIT_S}). A write is
 * never repeated. The last answer is returned as it came, for the caller to
 * report; the wait it asked for is kept for {@link lastRateLimitRetryAfter}.
 */
async function fetchPastRateLimit(url: string, init: RequestInit, read: boolean): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429) return res;
    noteRateLimit(res);
    const after = lastRetryAfterS;
    if (!read || attempt >= RATE_LIMIT_RETRIES) return res;
    const wait = after ?? 2 ** attempt;
    if (wait > RATE_LIMIT_MAX_WAIT_S) return res;
    await res.body?.cancel().catch(() => undefined);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

/** Whether a failure is the kind a retry could plausibly fix. */
function isRetryableTransportFailure(err: unknown): boolean {
  // A timeout is OUR deadline expiring, not the network refusing. Retrying it
  // spends the same budget again on something already known to be slow.
  if (isTimeoutError(err)) return false;
  const code = (err as { cause?: { code?: unknown } })?.cause?.code;
  return (
    typeof code === "string" &&
    ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ETIMEDOUT", "ENETUNREACH"].includes(code)
  );
}

/**
 * `fetchOrExplain` for a request that changes nothing, with retries.
 *
 * Only ever for READS. A release is not atomic from the client's side — the
 * import can fail after the point of no return — so retrying a write risks
 * applying it twice, while retrying a plan or an export risks nothing at all.
 * The distinction is the caller's to make, which is why this is a separate
 * function rather than an option on the shared one: a write cannot reach it by
 * passing the wrong flag.
 *
 * A retried failure reports the LAST attempt, phrased exactly as a single
 * attempt would be — the reader does not need to know it was tried three times
 * to act on "nothing answered".
 */
export async function fetchReadOrExplain(
  url: string,
  init: RequestInit,
  what: string,
  timeoutMs?: number,
): Promise<Response> {
  let res: Response;
  try {
    res = await retryingFetch(url, init);
  } catch (err) {
    throw explainFetchFailure(err, { url, what, timeoutMs, aftermath: READ_AFTERMATH });
  }
  // A read by contract, so a lost answer changed nothing.
  return explainingBody(res, { url, what, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
}

/**
 * The retry loop on its own, rethrowing the ORIGINAL failure.
 *
 * For a caller that already phrases its own transport error and only wants the
 * attempts — the import transport has to say whether anything landed, which is
 * wording no shared helper can supply. Wrapping there would nest one explained
 * error inside another and print the reason twice.
 *
 * READS ONLY, on the same reasoning as {@link fetchReadOrExplain}.
 */
export async function retryingFetch(url: string, init: RequestInit): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    try {
      const res = await fetchPastRateLimit(url, init, true);
      await noteMetaAnswer(url, res);
      return res;
    } catch (err) {
      last = err;
      if (!isRetryableTransportFailure(err) || attempt === READ_ATTEMPTS - 1) break;
      await new Promise((r) => setTimeout(r, READ_BACKOFF_MS * 2 ** attempt));
    }
  }
  throw last;
}
