/**
 * Typed `precondition` / `throw` overrides.
 *
 * `s.throw` raises a generic error the runtime returns with **HTTP 200** and an
 * error body — a client checking `res.ok` (or any non-2xx guard) treats a
 * deliberately-thrown error as success. `s.precondition` instead maps its
 * `error_type` to a status-bearing exception (400/401/403/404/429/…), so a
 * boundary rejection is observable via standard HTTP semantics.
 *
 * Both delegate to the codegen'd factory — the encoded statement is identical —
 * and only narrow/annotate the authoring types. `error_type` in particular ships
 * from codegen as a bare `string`; here it becomes the engine's enum so the
 * valid values (and the status each yields) are discoverable at the call site.
 */
import type { Statement } from "../statement.js";
import type { StatementAnnotations } from "../statement.js";
import type { Value } from "../../values/value.js";
import type { Condition } from "../conditional.js";
import { generated } from "../generated/factories.generated.js";
import { assertOneOf } from "../args.js";

/**
 * The exception a failed {@link precondition} raises, and the HTTP status the
 * runtime returns for it. Mirrors the engine's `mvp:precondition` `error_type`
 * enum:
 *
 * - `standard` — generic error (the default).
 * - `badrequest` — **400** Bad Request.
 * - `inputerror` — **400** Bad Request, tagged as input validation (the
 *   `payload` is attached as the offending param).
 * - `unauthorized` — **401** Unauthorized.
 * - `accessdenied` — **403** Forbidden.
 * - `notfound` — **404** Not Found.
 * - `toomanyrequests` — **429** Too Many Requests.
 */
export const PRECONDITION_ERROR_TYPES = [
  "standard",
  "notfound",
  "toomanyrequests",
  "accessdenied",
  "unauthorized",
  "badrequest",
  "inputerror",
] as const;

export type PreconditionErrorType = (typeof PRECONDITION_ERROR_TYPES)[number];

/**
 * The HTTP status each {@link PreconditionErrorType} yields, verified against
 * the engine's own exception→status table.
 *
 * Published in `llms.txt` from HERE rather than restated there: `error_type` is
 * how a Xano SDK stack sets a response status, so the mapping is the answer to
 * "how do I return a 404" and must not be able to drift from the union beside
 * it. `standard` raises a generic exception, which lands in the catch-all 500.
 */
export const PRECONDITION_ERROR_STATUS: Record<PreconditionErrorType, number> = {
  standard: 500,
  badrequest: 400,
  inputerror: 400,
  unauthorized: 401,
  accessdenied: 403,
  notfound: 404,
  toomanyrequests: 429,
};

export interface PreconditionArgs extends StatementAnnotations {
  /** The condition that must hold. When it evaluates falsy, the error is raised. */
  expr?: Condition;
  /**
   * Which status-bearing exception to raise on failure (default `standard`). Use
   * e.g. `badrequest` / `inputerror` to reject invalid input with a **400** a
   * client can detect via `res.ok` — unlike `s.throw`, which returns 200.
   */
  error_type?: PreconditionErrorType;
  /**
   * The error message. ⚠ **Use `c.text("…")`, not a bare string.**
   *
   * The engine reads this field as a TAGGED value and falls back to the generic
   * `"Precondition failed."` whenever what it reads is empty or non-scalar — so
   * a bare string is dropped and the client never sees the message you wrote.
   * A `c.text(...)` (or any computed {@link Value}) is delivered intact. The
   * `error_type` → HTTP status mapping is correct either way; it is only the
   * message that is lost.
   *
   * The bare-string form stays accepted because a pulled workspace can carry
   * one and has to round-trip, not because it is a spelling to choose.
   */
  error?: Value | string;
  /** Extra payload attached to the error (for `inputerror`, the offending param). */
  payload?: Value;
}

/**
 * `precondition { … }` — assert a condition and raise a **status-bearing** error
 * if it fails (`mvp:precondition`). Prefer this over {@link throwError} (`s.throw`)
 * whenever the rejection must be observable via HTTP status — a client guarding
 * on `res.ok` sees a real 4xx instead of a 200 with an error body.
 *
 * @example
 * s.precondition({
 *   expr: fl.starts_with(input.url, "http"),
 *   error_type: "badrequest",
 *   error: c.text("url must start with http:// or https://"),
 * })
 */
export function precondition(a: PreconditionArgs = {}): Statement {
  // The generated signature is typed from the engine's declared schema, which
  // says `error` is a value. The bare-string spelling is equally real (the
  // editor writes it and the engine keeps it), and the interpreter handles both,
  // so only the declared type needs widening here. `error_type` is a closed set
  // the generated field stores as-is, so an out-of-set literal through `any`
  // is refused here rather than read by the engine as the generic 500.
  assertOneOf("s.precondition", "error_type", (a as PreconditionArgs | undefined)?.error_type, PRECONDITION_ERROR_TYPES);
  return generated.precondition(a as Parameters<typeof generated.precondition>[0]);
}

export interface ThrowArgs extends StatementAnnotations {
  /** Optional error name/code. */
  name?: string;
  /** The error value/message. */
  value: Value;
}

/**
 * `throw <value>` — raise an error from the stack (`mvp:throw_error`).
 *
 * ⚠️ The runtime returns a thrown error with **HTTP 200** and an error body, so
 * a client checking `res.ok` treats it as success. For a rejection that surfaces
 * as a real 4xx status, use {@link precondition} (`s.precondition`) with an
 * `error_type`.
 */
export function throwError(a: ThrowArgs): Statement {
  return generated.throw(a);
}
