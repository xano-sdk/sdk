/**
 * `capture` — carry a value from the enclosing TypeScript scope into a body.
 *
 * Nothing crosses implicitly. The body is extracted as TEXT and runs in a
 * different process, so a closed-over `const rate` is simply undefined there —
 * and a body that throws comes back as its diagnostic text with HTTP 200, so
 * that mistake arrives as a wrong VALUE rather than as an error. Anything the
 * body needs from outside goes in `capture` and arrives as the SECOND parameter,
 * emitted ahead of the body as a `const` prelude.
 *
 * Capture JSON data only — string, number, boolean, null, object, array. A
 * function, `undefined`, `symbol`, `bigint` or `Date` has no JSON form that
 * survives the round trip and is refused at build time.
 *
 * `capture` is an option of `lam.fn`, NOT a field of `s.lambda` or of a filter.
 * An inline `code:` arrow receives bindings only, so there is no slot beside it
 * to pass data through — writing `capture:` there is a compile error, and the
 * fix is to move the body into `lam.fn`, as below, not to drop the field.
 *
 * The capture KEY must not share its name with a module-scope binding — note
 * `RATE` below carries into the key `rate`. An inline body is recovered with
 * `toString()`, and a `.ts` loader renames one of two same-named bindings, so
 * the body would read `rate2` while the prelude declares `rate`. Build time
 * refuses that rather than letting it become a wrong value at HTTP 200.
 */
import { defineFunction, ref, s, c, lam, withFilters, fl } from "@xano/sdk";

const RATE = 0.2;

export const lambdaCaptureScalar = defineFunction({
  name: "ex_lambda_capture",
  stack: [
    s.set_var("subtotal", c.decimal(120.5)),
    // 24.1 — `rate` is the captured value, not a closed-over one.
    s.lambda({
      as: "vat",
      code: lam.fn(({ $var }, { rate }) => $var.subtotal * rate, { surface: "s.lambda", capture: { rate: RATE } }),
    }),
  ],
  response: ref("vat"),
});

/**
 * The captured shape may be declared either way — `interface` or `type` alias.
 *
 * They are the same shape and the SDK treats them as one. That is worth an
 * example because an index-signature constraint would not: TypeScript grants
 * implicit index signatures to type ALIASES only, so an `interface` would be
 * rejected.
 *
 * The captured type flows into the second parameter, so `band.rate` is a
 * `number` here and a typo in the property name is a build error.
 */
interface TaxBand {
  rate: number;
  name: string;
}

const BAND: TaxBand = { rate: 0.2, name: "standard" };

export const lambdaCaptureObject = defineFunction({
  name: "ex_lambda_capture_object",
  stack: [
    s.set_var("prices", c.array([100, 250])),
    // [120, 300] — the whole object crosses as JSON and destructures inside.
    s.set_var(
      "gross",
      withFilters(
        ref("prices"),
        fl.map({
          code: lam.fn(({ $this }, { band }) => $this * (1 + band.rate), { surface: "map", capture: { band: BAND } }),
        }),
      ),
    ),
  ],
  response: ref("gross"),
});
