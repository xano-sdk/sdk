/**
 * Hand-authored typed wrapper for `util.ip_lookup` — the geolocation
 * statement whose bound variable is a NESTED object that nothing in the
 * signature hints at.
 *
 * The generated factory types `value` and nothing else, so an author guessing a
 * flat `{ city, region, latitude, longitude }` gets `null` for every field, and
 * those nulls fail two steps later with errors that name a column rather than
 * the lookup. This wrapper delegates encoding to the generated factory (bytes
 * unchanged) and adds the shape brand, so `ref("geo.location.latitude")` traces
 * to `number | null` while `ref("geo.latitude")` bottoms out at `unknown`.
 */
import type { Statement, AsShapeBrand } from "../statement.js";
import type { FilterXdo } from "../../types/xdo.js";
import type { ApplyFilters } from "../../values/filter-result.js";
import type { Value } from "../../values/value.js";
import type { StatementOptions } from "../statement.js";
import { generated } from "../generated/factories.generated.js";
import { argsOrEmpty } from "../args.js";
import { assertKnownKeys, type AllKeys } from "../../util/known-keys.js";

/**
 * What `util.ip_lookup` binds to its `as` variable: a nested geolocation record,
 * **not** flat fields. Every leaf is nullable, and `region.*`/`city.name`/
 * `postal.code` are commonly null even for a well-known routable public address
 * — a populated `country`/`location` with an empty city is the normal result,
 * not a failed lookup.
 *
 * Read coordinates at `location.latitude`/`location.longitude` and place names
 * at `city.name`/`region.name`/`country.name`. Note that `city` itself is an
 * OBJECT: a `ref("geo.city")` written into a text column fails on the object,
 * and `{ safe: true }` does not help because the object is not null — drill to
 * `city.name` and supply a fallback.
 *
 * The whole variable is `null` when the address cannot be resolved at all
 * (a private/reserved range, an unroutable or malformed address), so guard the
 * top level before drilling.
 */
export interface IpLookupResult {
  /** Continent code (`"NA"`) and name (`"North America"`). */
  continent: { code: string | null; name: string | null };
  /** ISO-3166 alpha-2 country code (`"US"`) and name (`"United States"`). */
  country: { code: string | null; name: string | null };
  /** Most specific subdivision — state/province. Commonly null. */
  region: { code: string | null; name: string | null };
  /** City name only; there is no city code. Commonly null. */
  city: { name: string | null };
  /** Postal/ZIP code. Commonly null. */
  postal: { code: string | null };
  /** Coordinates, IANA timezone (`"America/Chicago"`), and accuracy radius in KILOMETRES. */
  location: {
    latitude: number | null;
    longitude: number | null;
    tz: string | null;
    radius: number | null;
  };
}

export interface IpLookupArgs<As extends string = string> extends StatementOptions {
  /** The IP address to geolocate. */
  value: Value;
  /** Bind the nested {@link IpLookupResult} (or `null`) to this stack variable. */
  as?: As;
}

const IP_LOOKUP_KEYS = /* @__PURE__ */ Object.keys({ value: 1, as: 1, asFilters: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<IpLookupArgs>, 1>);

/**
 * `s.util.ip_lookup({ value, as })` — geolocate an IP address
 * (`mvp:ipaddress_lookup`).
 *
 * Branded `AsShapeBrand<As, IpLookupResult | null>` so `InferResponse` resolves
 * a dotted `ref` into the real, nested shape instead of `unknown`. The brand is
 * phantom — the emitted statement is byte-identical to the generated factory's.
 */
export function ipLookup<const As extends string = string,
  const Fs extends readonly FilterXdo[] = readonly [],
>(
  a: IpLookupArgs<As> & { asFilters?: Fs },
): Statement & AsShapeBrand<As, ApplyFilters<IpLookupResult | null, Fs>> {
  a = argsOrEmpty(a);
  assertKnownKeys(`Statement "s.util.ip_lookup"`, a, IP_LOOKUP_KEYS);
  return generated.util.ip_lookup({
    as: a.as,
    value: a.value,
    disabled: a.disabled,
    description: a.description,
    asFilters: a.asFilters as FilterXdo[] | undefined,
    // Read off the authored object at runtime; the generated arg type omits it.
    ...({ mock: a.mock } as object),
  }) as Statement & AsShapeBrand<As, ApplyFilters<IpLookupResult | null, Fs>>;
}
