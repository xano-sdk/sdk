/**
 * `fl.url_delarg` filter (group: text).
 * Parses a URL and returns an updated version with the supplied argument removed
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterUrlDelarg = defineFunction({
  name: "ex_filter_url_delarg",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["url_delarg"](c.text("field"))))],
  response: ref("out"),
});
