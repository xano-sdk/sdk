/**
 * `s.util.ip_lookup` — geolocate an IP address.
 *
 * SHAPE GATE: the bound var is a NESTED record, not flat fields:
 * `{ continent: {code,name}, country: {code,name}, region: {code,name},
 *    city: {name}, postal: {code}, location: {latitude,longitude,tz,radius} }`.
 * `ref("geo.latitude")` and `ref("geo.city")` both look right and are both
 * wrong — the first reads null, the second reads the `{ name }` OBJECT, which a
 * text column rejects and `{ safe: true }` cannot rescue (it is not null).
 *
 * Every leaf is nullable, and `region`/`city`/`postal` commonly ARE null even
 * for a well-known routable public address — that is a normal hit, not a failed
 * lookup. So drill with `{ safe: true }` and give the place names a fallback.
 */
import { c, defineFunction, filter, ref, s, withFilters } from "@xano/sdk";

export const utilIpLookup = defineFunction({
  name: "ex_util_ip_lookup",
  stack: [
    s.util.ip_lookup({ as: "geo", value: c.text("151.101.1.69") }),
  ],
  response: {
    latitude: ref("geo.location.latitude", { safe: true }),
    longitude: ref("geo.location.longitude", { safe: true }),
    country: ref("geo.country.name", { safe: true }),
    // Commonly null — fall back rather than persisting a null place name.
    city: withFilters(ref("geo.city.name", { safe: true }), filter("first_notempty", c.text("unknown"))),
  },
});
