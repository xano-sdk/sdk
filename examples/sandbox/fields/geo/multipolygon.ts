/**
 * `f.geo.multipolygon` field type. Values are `{ type: "polys", data }`, not GeoJSON.
 */
import { table, f } from "@xano/sdk";

export const fieldGeoMultipolygon = table({
  name: "ex_field_geo_multipolygon",
  schema: {
    location: f.geo.multipolygon(),
  },
});
