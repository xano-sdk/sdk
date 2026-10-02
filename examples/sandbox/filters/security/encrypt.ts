/**
 * `fl.encrypt` filter (group: security).
 * Encrypts the value and returns the result in raw binary form.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterEncrypt = defineFunction({
  name: "ex_filter_encrypt",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["encrypt"](c.text("x"), c.text("field"), c.text("x"))))],
  response: ref("out"),
});
