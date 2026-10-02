/**
 * `s.lambda` — run a JavaScript body in the stack.
 *
 * It lives at `s.lambda`, not `s.api.lambda`: a lambda runs wherever a stack
 * runs — functions, tasks, middleware, triggers — not only in an API.
 *
 * The statement surface binds AMBIENT state only: `$var`, `$input`, `$env`,
 * `$auth` (plus the `console` and `crypto` globals). There is no `$this` here —
 * that is a filter binding, and writing it is a build error rather than an
 * undefined at runtime.
 */
import { defineFunction, ref, s, c, lam } from "@xano/sdk";

export const apiLambda = defineFunction({
  name: "ex_api_lambda",
  stack: [
    s.set_var("subtotal", c.decimal(120.5)),
    // 144.6 — a stack variable is reached through `$var`, never as a bare `$subtotal`.
    s.lambda({
      as: "result",
      code: ({ $var }) => Math.round($var.subtotal * 1.2 * 100) / 100,
    }),
  ],
  response: ref("result"),
});

/**
 * Reaching a DEPENDENCY from a body: through the preloaded globals.
 *
 * `_`, `axios`, `jose`, `math`, `moment`, `DateTime`, `uuid`, `crypto`, `fetch`,
 * `Buffer` and friends are already in scope — see `LAMBDA_MODULE_GLOBALS`. They
 * need no specifier, which is the whole point: an `await import("lodash")` or a
 * `require("lodash")` names a module that has to be RESOLVED, and on an instance
 * that bundles the body before running it that resolution happens ahead of time
 * against a filesystem the module is not on. The body then returns the text
 * `Could not resolve "lodash"` with HTTP 200 — a failure that arrives as data.
 *
 * `lam.raw` rather than `lam.fn` because a global is not one of the typed
 * bindings: `lam.fn`'s parameter carries `$var`/`$this`/…, and `_` would not
 * type-check inside it.
 */
export const lambdaGlobals = defineFunction({
  name: "ex_lambda_globals",
  stack: [
    s.set_var("lines", c.array([{ qty: 2 }, { qty: 12 }])),
    // 14 — summed by a library the engine preloads, with nothing imported.
    s.lambda({ as: "total", code: lam.raw("return _.sumBy($var.lines, 'qty')") }),
  ],
  response: ref("total"),
});
