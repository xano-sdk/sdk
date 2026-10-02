/**
 * `f.geo.point` field type. Values are `{ type: "point", data }`, not GeoJSON.
 */
import { table, f } from "@xano/sdk";

export const fieldGeoPoint = table({
  name: "ex_field_geo_point",
  schema: {
    location: f.geo.point(),
  },
});
