/**
 * `fl.secureid_decode` filter (group: security).
 * Returns the id of the original encode
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSecureidDecode = defineFunction({
  name: "ex_filter_secureid_decode",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["secureid_decode"](c.text("x"))))],
  response: ref("out"),
});
