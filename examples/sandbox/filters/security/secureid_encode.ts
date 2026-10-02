/**
 * `fl.secureid_encode` filter (group: security).
 * Returns an encrypted version of the id
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSecureidEncode = defineFunction({
  name: "ex_filter_secureid_encode",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["secureid_encode"](c.text("x"))))],
  response: ref("out"),
});
