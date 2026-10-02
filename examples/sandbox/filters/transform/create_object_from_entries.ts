/**
 * `fl.create_object_from_entries` filter (group: transform).
 * Creates an object based on an array of key/value pairs. (i.e. same result as the entries filter)
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterCreateObjectFromEntries = defineFunction({
  name: "ex_filter_create_object_from_entries",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["create_object_from_entries"]()))],
  response: ref("out"),
});
