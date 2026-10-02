/**
 * `s.util.geo_distance` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const utilGeoDistance = defineFunction({
  name: "ex_util_geo_distance",
  stack: [
    s.util.geo_distance({
      as: "result",
      latitude_1: c.decimal(37.7749),
      longitude_1: c.decimal(-122.4194),
      latitude_2: c.decimal(34.0522),
      longitude_2: c.decimal(-118.2437),
    }),
  ],
  response: ref("result"),
});
