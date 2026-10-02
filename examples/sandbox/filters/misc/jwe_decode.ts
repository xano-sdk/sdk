/**
 * `fl.jwe_decode` filter.
 * Decodes the JWE token and return the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterJweDecode = defineFunction({
  name: "ex_filter_jwe_decode",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["jwe_decode"](c.text("x"))))],
  response: ref("out"),
});
