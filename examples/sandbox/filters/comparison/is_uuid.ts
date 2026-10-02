/**
 * `fl.is_uuid` filter (group: comparison).
 * Returns whether or not the value is a valid UUID.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterIsUuid = defineFunction({
  name: "ex_filter_is_uuid",
  stack: [s.set_var("out", withFilters(c.int(5), fl["is_uuid"]()))],
  response: ref("out"),
});
