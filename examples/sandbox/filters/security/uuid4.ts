/**
 * `fl.uuid4` filter (group: security).
 * Returns a universally unique identifier
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterUuid4 = defineFunction({
  name: "ex_filter_uuid4",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["uuid4"]()))],
  response: ref("out"),
});
