/**
 * `fl.url_hasarg` filter (group: text).
 * Returns the existence of a argument in the URL
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterUrlHasarg = defineFunction({
  name: "ex_filter_url_hasarg",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["url_hasarg"](c.text("field"))))],
  response: ref("out"),
});
