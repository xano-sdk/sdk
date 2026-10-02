/**
 * `fl.crypto_jwe_decode` filter (group: security).
 * Decodes the JWE token and return the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterCryptoJweDecode = defineFunction({
  name: "ex_filter_crypto_jwe_decode",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["crypto_jwe_decode"](c.obj({}), c.obj({}), c.text("field"), c.text("x"))))],
  response: ref("out"),
});
