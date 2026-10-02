/**
 * `fl.jwe_encode` filter.
 * Encodes the value and return the result as a JWE token
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterJweEncode = defineFunction({
  name: "ex_filter_jwe_encode",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["jwe_encode"](c.text("x"))))],
  response: ref("out"),
});
