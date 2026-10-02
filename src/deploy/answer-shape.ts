/**
 * What a 2xx has to CARRY before it counts as the answer, one validator per
 * endpoint shape — shared by every meta call in `src/deploy/` so a list, a
 * delete, a text export and a write each refuse a non-answer the same way.
 *
 * A 200 is not success on its own. A proxy, a captive portal or a stub answers
 * 200 with a page, `{}`, `[]`, `null` or nothing, and a caller that read
 * "no rows" off that reported an empty workspace, and one that read "no error"
 * off it reported a delete that never happened. Each shape below says what the
 * real answer looks like and refuses everything else through the shared
 * not-an-API-response wording ({@link unexpectedAnswerError} /
 * {@link notJsonError}): the host, never the route, never the body.
 *
 * A READ that is refused changed nothing. A WRITE that is refused was sent,
 * so its refusal carries {@link SENT_AFTERMATH} — it may or may not have taken
 * effect — and the caller keeps whatever local record it would have cleared.
 */
import {
  certificateFailureCode,
  closeSentence,
  lostAnswerHead,
  markupSummary,
  notJsonError,
  parseJsonAnswer,
  SENT_AFTERMATH,
  TransportError,
  unexpectedAnswerError,
} from "../util/http.js";

/** A JSON object — not an array, not null. */
export type Row = Record<string, unknown>;

export function isRecord(v: unknown): v is Row {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A non-empty string field. */
export function hasString(row: Row, key: string): boolean {
  return typeof row[key] === "string" && row[key] !== "";
}

/** How a refusal is worded: `safe` for a route that reaches a real deployment, `write` for one that changed something. */
export interface AnswerOpts {
  safe?: boolean;
  write?: boolean;
}

function refusalOpts(opts: AnswerOpts): { safe?: boolean; aftermath?: string } {
  return {
    ...(opts.safe === true ? { safe: true } : {}),
    ...(opts.write === true ? { aftermath: SENT_AFTERMATH } : {}),
  };
}

/** The shared refusal for a 2xx that parsed, or did not, and is not this request's answer. */
export function notTheAnswer(action: string, text: string, url: string, opts: AnswerOpts = {}): Error {
  // An HTML page or text that is not JSON is named as such; JSON of the wrong
  // shape (and an empty body) as "not the answer this request expects".
  let parsed = true;
  try {
    JSON.parse(text);
  } catch {
    parsed = false;
  }
  return parsed || text.trim() === ""
    ? unexpectedAnswerError(action, text, url, refusalOpts(opts))
    : notJsonError(action, text, url, refusalOpts(opts));
}

/** `JSON.parse` for a 2xx answer, refusing a page or text the shared way. */
export function parseAnswer(text: string, action: string, url: string, opts: AnswerOpts = {}): unknown {
  if (text.trim() === "") throw notTheAnswer(action, text, url, opts);
  return parseJsonAnswer(text, action, url, refusalOpts(opts));
}

/**
 * A single record: a JSON object passing `isAnswer`. `null`, an array, `{}`, and
 * a stranger's object are all refused — every caller acts on a field the real
 * record carries.
 */
export function recordAnswer(
  text: string,
  action: string,
  url: string,
  isAnswer: (row: Row) => boolean,
  opts: AnswerOpts = {},
): Row {
  const data = parseAnswer(text, action, url, opts);
  if (!isRecord(data) || !isAnswer(data)) throw notTheAnswer(action, text, url, opts);
  return data;
}

/** One page of a list: its rows, and the envelope they came in (for `nextPage`), when there was one. */
export interface ListPage {
  rows: Row[];
  envelope: Row | undefined;
}

/**
 * A list answer: a bare array, or an `{ items: [...] }` envelope, and EVERY
 * element passing `isRow`.
 *
 * All or nothing. Dropping the elements that do not look like rows turned a
 * page of junk into an empty list — "no tables", "no tests" — which is a wrong
 * answer, not a cautious one. An empty list is only an answer when it came as
 * one (`[]` or `{ items: [] }`).
 */
export function listAnswer(
  text: string,
  action: string,
  url: string,
  isRow: (row: Row) => boolean,
  opts: AnswerOpts = {},
): ListPage {
  const data = parseAnswer(text, action, url, opts);
  const envelope = isRecord(data) ? data : undefined;
  const rows = Array.isArray(data) ? data : Array.isArray(envelope?.items) ? (envelope.items as unknown[]) : undefined;
  if (rows === undefined || !rows.every((r) => isRecord(r) && isRow(r))) throw notTheAnswer(action, text, url, opts);
  return { rows: rows as Row[], envelope };
}

/**
 * A tenant DELETE's success answer: the route answers `null` (measured). Any
 * other 2xx — a page, `{}`, `[]`, an empty body — deleted nothing we can know
 * of, so it is refused as a write whose outcome is unknown, and a caller must
 * not clear the local record of what it asked to delete.
 */
export function deleteAnswer(text: string, action: string, url: string, opts: { safe?: boolean } = {}): void {
  if (text.trim() === "null") return;
  throw notTheAnswer(action, text, url, { ...opts, write: true });
}

/**
 * The engine's XanoScript multidoc: text whose first statement opens a
 * XanoScript document (`workspace "name" {`, `table users {`, …).
 *
 * Refused: an HTML page, a JSON value (an error envelope or a stranger's
 * object answering 200), an empty body, and text that does not open with a
 * XanoScript statement. Written verbatim, a non-answer became a `.xs` file the
 * next reader took for the export.
 */
export function multidocAnswer(text: string, action: string, url: string): string {
  const refuse = (): Error => notTheAnswer(action, text, url);
  if (text.trim() === "" || markupSummary(text) !== undefined) throw refuse();
  let isJson = true;
  try {
    JSON.parse(text);
  } catch {
    isJson = false;
  }
  if (isJson) throw unexpectedAnswerError(action, text, url);
  const first = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("//"));
  // A statement keyword, then whatever it takes (`query "a/{id}" verb=GET`), then its open brace.
  if (first === undefined || !/^[a-z][a-z_]*\s[^{]*\{/.test(first)) throw refuse();
  return text;
}

/** Codes a connection fails with BEFORE a request is sent: nothing reached the instance. */
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

/**
 * A WRITE's transport failure, with what it means for the write: a connection
 * refused or a name that did not resolve never sent anything, and says so;
 * any other drop — reset, closed mid-answer, timed out — may have been
 * received, so it may or may not have taken effect.
 *
 * Idempotent on an error that already carries an aftermath.
 */
export function writeTransportFailure(err: unknown): unknown {
  if (!(err instanceof TransportError)) return err;
  // A certificate the handshake refused: nothing was sent, and the message
  // already says so — with no retry, since the same certificate is refused again.
  if (certificateFailureCode(err) !== undefined) return err;
  if (/may or may not have taken effect|Nothing was (sent|changed)/.test(err.message)) {
    // A body read dropped mid-answer already says "may or may not" for a write
    // (fetchOrExplain passes the aftermath); a read's "Nothing was changed" is
    // wrong for a write and is replaced.
    if (!/Nothing was changed/.test(err.message)) return err;
  }
  // Closed first: `…could not reach X: fetch failed (ECONNRESET)` ran straight
  // into the aftermath on the next line with no full stop.
  const first = err.message.split("\n")[0]!;
  const inner = (err.cause as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause;
  const code = inner?.code;
  // The HTTP client refuses a blocked port ("bad port") before it connects.
  const notSent = (typeof code === "string" && NOT_SENT.has(code)) || inner?.message === "bad port";
  // A connection that opened and then dropped reached the instance: its answer
  // was lost, which "could not reach" beside "the request was sent" denied.
  const head = closeSentence(notSent ? first : lostAnswerHead(first, err.cause));
  const aftermath = notSent ? "Nothing was sent — retry." : SENT_AFTERMATH;
  return new TransportError(`${head}\n${aftermath}`, err.timeout, { cause: err.cause });
}
