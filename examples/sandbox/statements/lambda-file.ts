/**
 * `lam.file` — a lambda body in its own type-checked module.
 *
 * The body lives in `examples/sandbox/lambdas/order-total.ts` and is read as
 * TEXT at build time, so the engine runs exactly what that file contains, with
 * no bundler or transpiler in between. The path resolves against THIS module,
 * the way an `import` would.
 *
 * `lam.file` is node-only (it reads the filesystem), so it comes from
 * `@xano/sdk/node` rather than the isomorphic entry.
 */
import { defineFunction, ref, s, c, withFilters, fl } from "@xano/sdk";
import { lam } from "@xano/sdk/node";

export const lambdaFromFile = defineFunction({
  name: "ex_lambda_file",
  stack: [
    s.set_var("lines", c.array([{ qty: 2, price: 10 }, { qty: 12, price: 5 }])),
    // 74 — 2×10 at full price, plus 12×5 less the 10% bulk discount the module applies.
    s.set_var(
      "out",
      withFilters(ref("lines"), fl.reduce({ initial_value: 0, code: lam.file("../lambdas/order-total.ts") })),
    ),
  ],
  response: ref("out"),
});
