/**
 * `fl.decrypt` filter (group: security).
 * Decrypts the value and returns the result.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterDecrypt = defineFunction({
  name: "ex_filter_decrypt",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["decrypt"](c.text("x"), c.text("field"), c.text("x"))))],
  response: ref("out"),
});
