/**
 * `f.geo.multilinestring` field type. Values are `{ type: "paths", data }`, not GeoJSON.
 */
import { table, f } from "@xano/sdk";

export const fieldGeoMultilinestring = table({
  name: "ex_field_geo_multilinestring",
  schema: {
    location: f.geo.multilinestring(),
  },
});
