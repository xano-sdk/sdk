/**
 * `fl.transform` filter (group: manipulation).
 * Evaluates a Xano Expression Engine expression over the piped value.
 *
 * NOT a JavaScript body. There is no `return`, and the piped value binds
 * POSITIONALLY as `$0` (or `$$`) — NOT as `$this`, which resolves to null here
 * and would hand back a wrong answer with HTTP 200. Filters can be
 * piped inside the expression, and an object/array literal builds one.
 *
 * For real JavaScript, reach for `fl.lambda`, whose body DOES bind `$this`.
 *
 * Note the PARENTHESES around each piped key below. Inside an object literal a
 * filter argument's comma is read as the key separator, so an unparenthesized
 * `sorted: $0|sort|join:","` returns null AND drops every key after it — with no
 * error. Parenthesize any pipe inside a literal.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterTransform = defineFunction({
  name: "ex_filter_transform",
  stack: [
    s.set_var("qty", c.int(3)),
    s.set_var(
      "out",
      // {"sorted":"1,2,3","count":3,"qty_doubled":6} — the operand through a
      // piped filter chain, an aggregate over it, and an ambient stack variable.
      withFilters(
        c.array([3, 1, 2]),
        fl.transform('{ sorted: ($0|sort|join:","), count: ($0|count), qty_doubled: $var.qty * 2 }'),
      ),
    ),
  ],
  response: ref("out"),
});
