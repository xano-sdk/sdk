/**
 * The kind-agnostic object model. Each top-level Xano object kind
 * (function, table, query, trigger, toolset, …) declares its authoring def
 * type, its envelope encoder, and the `packageExport` payload key it lands
 * under. A per-kind registry — mirroring the statement registry — is the
 * extensibility seam every kind plugs into.
 */
import { assertMockKeysResolved, assertTestIds } from "./test-mocks.js";

/** A registered object kind: authoring def → stored `xdo` envelope. */
export interface ObjectKind<Def = any, Xdo = any> {
  /** Stable kind name (e.g. "function", "table", "query"). */
  name: string;
  /** The `packageExport` payload key this kind lands under (e.g. "function", "dbo"). */
  payloadKey: string;
  /** Encode an authoring def into its flattened importable `xdo` envelope. */
  encode(def: Def): Xdo;
  /**
   * Derive this object's guid from its **def**, for kinds whose identity is not
   * `md5("<payloadKey>:<name>")`. Only the realtime family needs it: a channel
   * path is unique per server and a message name per channel, so their guids
   * are composed from more than the name (see `refs/guid.ts`). Omit it and the
   * registry falls back to the name derivation every other kind uses.
   */
  guidOf?(def: Def): string;
}

const kindRegistry = new Map<string, ObjectKind>();

/** Register an object kind under its `name`. */
export function registerKind(kind: ObjectKind): void {
  kindRegistry.set(kind.name, kind);
}

/** True when a kind name has a registered encoder. */
export function isRegisteredKind(name: string): boolean {
  return kindRegistry.has(name);
}

/** Look up a registered kind, throwing a clear error when absent. */
export function getKind(name: string): ObjectKind {
  const kind = kindRegistry.get(name);
  if (!kind) {
    throw new Error(
      `Unknown object kind "${name}". Registered: ${[...kindRegistry.keys()].join(", ") || "(none)"}`,
    );
  }
  return kind;
}

/** Encode an authoring def through its registered kind. */
export function encodeObject<Xdo = unknown>(name: string, def: unknown): Xdo {
  const xdo = getKind(name).encode(def) as Xdo;
  // Central, because `mock` is offered on every statement while only the three
  // kinds that store `test[]` resolve it. See {@link assertMockKeysResolved}.
  assertTestIds(xdo, name);
  assertMockKeysResolved(xdo, name);
  return xdo;
}

/** All registered kinds (for export assembly). */
export function registeredKinds(): ObjectKind[] {
  return [...kindRegistry.values()];
}
