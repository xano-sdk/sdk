/**
 * `fl.lambda` filter (group: transform).
 * Business logic using JavaScript.
 *
 * `fl.lambda` runs ONCE over the piped value, which it binds as `$this` —
 * not `$parent`, and not the `$this`-per-element of the array filters.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterLambda = defineFunction({
  name: "ex_filter_lambda",
  stack: [
    s.set_var(
      "out",
      // "VALUE!" — the piped text, uppercased.
      withFilters(
        c.text("value"),
        fl.lambda(({ $this }) => `${String($this).toUpperCase()}!`),
      ),
    ),
  ],
  response: ref("out"),
});
