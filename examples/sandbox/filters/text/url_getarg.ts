/**
 * `fl.url_getarg` filter (group: text).
 * Gets the argument's value from a URL
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterUrlGetarg = defineFunction({
  name: "ex_filter_url_getarg",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["url_getarg"](c.text("field"))))],
  response: ref("out"),
});
