/**
 * The statement catalog, keyed the way a bundle reader needs it.
 *
 * A compiled statement identifies itself by its STORED name (`mvp:dbo_view`);
 * everything a person reads — a docs link, a lint message, a graph node label —
 * wants the authoring path (`s.db.query`). The mapping is SDK metadata, so a
 * third-party tool must not have to keep its own copy: a new statement kind
 * would then need a release in every tool before it stopped rendering as an
 * unknown node.
 */

import { STATEMENT_SURFACES, sPathOf } from "../statements/surfaces.js";

/** One stored statement name and the authoring surface(s) that compile to it. */
export interface StatementCatalogEntry {
  /** The stored `mvp:` name, as it appears on a compiled statement's `name`. */
  readonly storedName: string;
  /** The primary surface key — the engine's own schema name, e.g. `db.query`. */
  readonly surface: string;
  /** The dotted accessor under `s.`, e.g. `db.query` is reachable as `s.db.query`. */
  readonly sPath: string;
  /**
   * Every surface key stored under this name, in catalog order. Almost always
   * one; the mapping is NOT injective (`util.get_raw_input` and `util.get_input`
   * both store `mvp:get_input`), so a reader that must not lose a surface reads
   * this rather than {@link StatementCatalogEntry.surface}.
   */
  readonly surfaces: readonly string[];
}

let cached: ReadonlyMap<string, StatementCatalogEntry> | undefined;

/**
 * Every stored statement name the SDK knows, mapped to its authoring surface.
 *
 * Built once and shared — the returned map is frozen in the sense that it is the
 * same instance on every call, so a caller must not mutate it.
 *
 * `raw()` is deliberately absent: it is the passthrough for stored statements
 * the catalog cannot model, so a `name` that misses here is exactly the set a
 * tool should render as opaque.
 */
export function statementCatalog(): ReadonlyMap<string, StatementCatalogEntry> {
  if (cached) return cached;
  const map = new Map<string, StatementCatalogEntry>();
  for (const [surface, storedName] of STATEMENT_SURFACES) {
    const existing = map.get(storedName);
    if (existing) {
      map.set(storedName, { ...existing, surfaces: [...existing.surfaces, surface] });
      continue;
    }
    map.set(storedName, {
      storedName,
      surface,
      sPath: sPathOf(surface),
      surfaces: [surface],
    });
  }
  cached = map;
  return map;
}
