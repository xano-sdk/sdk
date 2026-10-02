/**
 * `fl.hmac_md5` filter (group: security).
 * Returns a MD5 signature representation of the value using a shared secret via the HMAC method
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterHmacMd5 = defineFunction({
  name: "ex_filter_hmac_md5",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["hmac_md5"](c.text("field"))))],
  response: ref("out"),
});
