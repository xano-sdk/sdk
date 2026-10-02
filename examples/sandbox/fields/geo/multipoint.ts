/**
 * `f.geo.multipoint` field type. Values are `{ type: "points", data }`, not GeoJSON.
 */
import { table, f } from "@xano/sdk";

export const fieldGeoMultipoint = table({
  name: "ex_field_geo_multipoint",
  schema: {
    location: f.geo.multipoint(),
  },
});
