/**
 * `fl.crypto_jws_decode` filter (group: security).
 * Decodes the JWS token and return the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterCryptoJwsDecode = defineFunction({
  name: "ex_filter_crypto_jws_decode",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["crypto_jws_decode"](c.obj({}), c.obj({}), c.text("x"))))],
  response: ref("out"),
});
