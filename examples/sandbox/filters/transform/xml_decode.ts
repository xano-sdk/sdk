/**
 * `fl.xml_decode` filter (group: transform).
 * Decodes XML and returns the result
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterXmlDecode = defineFunction({
  name: "ex_filter_xml_decode",
  stack: [s.set_var("out", withFilters(c.text("value"), fl["xml_decode"]()))],
  response: ref("out"),
});
