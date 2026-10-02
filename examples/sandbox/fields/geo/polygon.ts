/**
 * `f.geo.polygon` field type. Values are `{ type: "poly", data }`, not GeoJSON.
 */
import { table, f } from "@xano/sdk";

export const fieldGeoPolygon = table({
  name: "ex_field_geo_polygon",
  schema: {
    location: f.geo.polygon(),
  },
});
