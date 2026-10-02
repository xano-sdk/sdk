/**
 * `fl.hmac_sha1` filter (group: security).
 * Returns a SHA1 signature representation of the value using a shared secret via the HMAC method
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterHmacSha1 = defineFunction({
  name: "ex_filter_hmac_sha1",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["hmac_sha1"](c.text("field"))))],
  response: ref("out"),
});
