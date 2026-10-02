/**
 * `fl.url_addarg` filter (group: text).
 * Parses a URL and returns an updated version with an encoded version of the supplied argument
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterUrlAddarg = defineFunction({
  name: "ex_filter_url_addarg",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["url_addarg"](c.text("field"), c.text("x"))))],
  response: ref("out"),
});
