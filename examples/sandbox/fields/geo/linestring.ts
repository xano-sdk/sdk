/**
 * `f.geo.linestring` field type. Values are `{ type: "path", data }`, not GeoJSON.
 */
import { table, f } from "@xano/sdk";

export const fieldGeoLinestring = table({
  name: "ex_field_geo_linestring",
  schema: {
    location: f.geo.linestring(),
  },
});
