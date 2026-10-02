/**
 * `fl.crypto_jwe_encode` filter (group: security).
 * Encodes the value and return the result as a JWE token
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterCryptoJweEncode = defineFunction({
  name: "ex_filter_crypto_jwe_encode",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["crypto_jwe_encode"](c.obj({}), c.obj({}), c.text("field"), c.text("x"))))],
  response: ref("out"),
});
