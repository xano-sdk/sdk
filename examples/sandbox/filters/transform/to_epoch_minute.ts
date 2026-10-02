/**
 * `fl.to_epoch_minute` filter (group: transform).
 * Converts a text expression (now, next friday, Jan 1 2000) to the
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterToEpochMinute = defineFunction({
  name: "ex_filter_to_epoch_minute",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["to_epoch_minute"]()))],
  response: ref("out"),
});
