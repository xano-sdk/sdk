/**
 * `fl.range` filter (group: array).
 * Returns array of values between the specified start/stop.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterRange = defineFunction({
  name: "ex_filter_range",
  stack: [s.set_var("out", withFilters(c.array([3, 1, 2]), fl["range"](c.int(2), c.int(2))))],
  response: ref("out"),
});
