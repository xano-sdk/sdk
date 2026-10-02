/**
 * `fl.crypto_jws_encode` filter (group: security).
 * Encodes the value and return the result as a JWS token
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterCryptoJwsEncode = defineFunction({
  name: "ex_filter_crypto_jws_encode",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["crypto_jws_encode"](c.obj({}), c.obj({}), c.text("x"))))],
  response: ref("out"),
});
