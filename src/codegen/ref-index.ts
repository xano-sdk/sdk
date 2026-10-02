/**
 * Reference index — every guid in a bundle, mapped back to the object it names.
 *
 * A pulled bundle refers to its own objects by guid: a `function.run` names its
 * callee's guid, a `db.get` names a table's, a trigger names its bound toolset's.
 * Turning those into readable cross-file symbol references needs one pass over
 * the payload up front.
 *
 * The guid itself is **preserved, never re-derived**. Xano SDK derives
 * `md5(type:name)` for objects it authors, but a pulled object's guid is the
 * engine's own random value; re-deriving would silently rewrite identity and
 * break every reference that points at it.
 */
import { REFERENCEABLE_KIND_PAYLOAD_KEYS } from "../refs/guid.js";
import type { DecodeContext } from "./context.js";
import { id, lit, obj, type Expr } from "./print.js";

/** One object located in the bundle payload. */
export interface IndexedObject {
  /** The engine's stored guid, verbatim. */
  readonly guid: string;
  /** The payload array it came from, e.g. `function`, `dbo`, `toolset`. */
  readonly payloadKey: string;
  /** The Xano SDK kind name, e.g. `function`, `table`, `mcp_server`. */
  readonly kind: string;
  readonly name: string;
  /** Position within its payload array — a stable tiebreak for symbol naming. */
  readonly position: number;
  /** A table's stored columns, for a decoder that re-expands a row against them. */
  readonly schema?: unknown;
  /** A microservice's declared `servicePort`s, for re-linking a request's `host`. */
  readonly ports?: readonly string[];
}

/**
 * Payload key → the kinds that persist under it. Derived by inverting the
 * authoritative map rather than restated, so a new kind cannot drift out of sync.
 * Only `toolset` is ambiguous (mcp-server and agent share it); tools persist
 * under their own `tool` key.
 */
const KINDS_BY_PAYLOAD_KEY: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const [kind, payloadKey] of Object.entries(REFERENCEABLE_KIND_PAYLOAD_KEYS)) {
    const kinds = out.get(payloadKey) ?? [];
    kinds.push(kind);
    out.set(payloadKey, kinds);
  }
  return out;
})();

/**
 * Which kind an object under an ambiguous payload key actually is.
 * `toolset` holds both mcp-servers and agents, discriminated by the stored
 * `type` the engine persists (`"mcp"` vs `"agent"`).
 */
function discriminate(payloadKey: string, object: Record<string, unknown>): string | null {
  const candidates = KINDS_BY_PAYLOAD_KEY.get(payloadKey);
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  const type = object.type;
  if (type === "mcp") return "mcp_server";
  if (type === "agent") return "agent";
  return null;
}

/** Guid → object, built once per bundle. */
export class RefIndex {
  readonly #byGuid = new Map<string, IndexedObject>();


  /**
   * Walk every payload array once, keying each object by its stored guid.
   *
   * An object with no usable guid is reported rather than assigned a derived one:
   * a derived guid would look correct and quietly point somewhere else.
   */
  static fromPayload(payload: Record<string, unknown>, ctx: DecodeContext): RefIndex {
    const index = new RefIndex();
    for (const payloadKey of KINDS_BY_PAYLOAD_KEY.keys()) {
      const section = payload[payloadKey];
      if (!Array.isArray(section)) continue;
      section.forEach((entry, position) => {
        if (entry === null || typeof entry !== "object") return;
        const object = entry as Record<string, unknown>;
        const name = typeof object.name === "string" ? object.name : "";
        const kind = discriminate(payloadKey, object);
        const guid = object.guid;
        if (typeof guid !== "string" || guid === "") {
          ctx.problem(
            "unresolved-ref",
            `${payloadKey}[${position}]${name ? ` "${name}"` : ""} has no stored guid; references to it cannot resolve`,
          );
          return;
        }
        if (kind === null) {
          ctx.problem(
            "unresolved-ref",
            `${payloadKey} "${name}" (guid ${guid}) has no recognizable kind; its stored \`type\` is ${JSON.stringify(object.type)}`,
          );
          return;
        }
        index.#byGuid.set(guid, {
          guid,
          payloadKey,
          kind,
          name,
          position,
          ...(payloadKey === "dbo" && Array.isArray(object.schema) ? { schema: object.schema } : {}),
          ...(payloadKey === "microservice" ? { ports: servicePorts(object) } : {}),
        });
      });
    }
    return index;
  }

  /** The object a guid names, or undefined when the bundle does not contain it. */
  lookup(guid: string): IndexedObject | undefined {
    return this.#byGuid.get(guid);
  }

  /** Every indexed object, in payload-walk order. */
  all(): IndexedObject[] {
    return [...this.#byGuid.values()];
  }

  /**
   * The ONE object of `kind` named `name` — for the references the engine
   * resolves by name (a microservice request's `host`). Undefined when none or
   * several match: a guess would repoint the reference.
   */
  byName(kind: string, name: string): IndexedObject | undefined {
    const found = this.all().filter((o) => o.kind === kind && o.name === name);
    return found.length === 1 ? found[0] : undefined;
  }
}

/** A stored microservice's declared `servicePort`s, de-duplicated. */
function servicePorts(object: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const containers = (object.deployment as { containers?: unknown } | undefined)?.containers;
  for (const container of Array.isArray(containers) ? containers : []) {
    const ports = (container as { ports?: unknown } | null)?.ports;
    for (const port of Array.isArray(ports) ? ports : []) {
      const servicePort = (port as { servicePort?: unknown } | null)?.servicePort;
      if (typeof servicePort === "string" && servicePort !== "") seen.add(servicePort);
    }
  }
  return [...seen];
}

/**
 * The microservice a `mvp:microservice_request` names in its `host` — a plain
 * `"name"` or `"name:port"` text the engine splits on the first `:` — with the
 * port, when the def's own resolution reproduces that text: a named port must
 * be one the def declares, and a bare name only resolves bare when the def
 * declares none.
 */
export function microserviceHost(
  refs: RefIndex,
  stored: unknown,
): { target: IndexedObject; port: string | undefined } | undefined {
  const input = (stored as { input?: unknown } | null)?.input;
  const entry = (Array.isArray(input) ? input : []).find((e) => (e as { name?: unknown })?.name === "host") as
    | { value?: unknown; tag?: unknown; filters?: unknown; ignore?: unknown }
    | undefined;
  if (entry?.tag !== "const" || typeof entry.value !== "string" || entry.ignore === true) return undefined;
  if (Array.isArray(entry.filters) && entry.filters.length > 0) return undefined;
  const colon = entry.value.indexOf(":");
  const name = colon === -1 ? entry.value : entry.value.slice(0, colon);
  const port = colon === -1 ? undefined : entry.value.slice(colon + 1);
  const target = name === "" ? undefined : refs.byName("microservice", name);
  if (!target) return undefined;
  const ports = target.ports ?? [];
  if (port === undefined ? ports.length !== 0 : port === "" || (ports.length > 0 && !ports.includes(port))) return undefined;
  return { target, port };
}

/** How a reference site should render a target the index resolved. */
export interface ResolveOptions {
  /**
   * The TypeScript symbol to reference, or `null` to emit a `{name, guid}`
   * literal instead. Project assembly returns `null` on a cycle back edge,
   * so two mutually-calling objects never produce circular imports.
   */
  symbolFor?: (target: IndexedObject) => string | null;
  /**
   * What an *unresolvable* guid degrades to.
   *
   * `"guid-string"` (the default) suits a stored slot that holds a bare guid,
   * like a statement's `context.function_id`. `"object-ref"` is required wherever
   * the authoring surface takes an {@link ObjectRef}, because a bare string there
   * is read as a **name** and re-derived into a completely different guid — which
   * silently repoints the reference instead of preserving it.
   */
  unresolved?: "guid-string" | "object-ref";
}

/**
 * A stored reference id, in either spelling the engine uses.
 *
 * A target is identified by a guid **or** by a numeric id depending on how and
 * when the referring object was saved, so a decoder that insists on a string
 * cannot even classify half of them. Read the type, then decide by value.
 */
export function isReferenceId(v: unknown): v is string | number {
  return typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
}

/**
 * True when a stored reference id names nothing — the UNBOUND state.
 *
 * Both spellings have an empty form and they mean the same thing: a blank guid
 * (`""`) and a zero numeric id (`0`) are each "no target", never "target zero".
 * That equivalence is what lets one authored `null` stand for either, and it is
 * safe to rely on because an id is not byte-compared at all (see
 * {@link isBoundNumericId}).
 */
export function isUnboundId(v: string | number): boolean {
  return v === "" || v === 0;
}

/**
 * True for a reference to a real target recorded as a NUMBER rather than a guid.
 *
 * These are not decodable today, and the reason is subtle enough to be worth
 * stating where it is enforced. `normalize` lists `id` among the server columns it
 * strips, so a reference id is never byte-compared — which means the proof-carrying
 * contract, the thing that makes an aggressive decoder safe everywhere else,
 * cannot catch a wrong one here. A recovered reference re-encodes the guid as a
 * STRING (`"3"` for a stored `3`), and that type change would sail through the
 * comparison unexamined.
 *
 * So this stays a decline until a reference can carry its stored spelling
 * (widening an `ObjectRef`'s guid to `string | number`), rather than emitting a
 * reference nothing can verify. The unbound forms above are unaffected: `null`
 * means "no target" in either spelling, so nothing is being guessed.
 */
export function isBoundNumericId(v: string | number): boolean {
  return typeof v === "number" && !isUnboundId(v);
}

/**
 * Render a reference to `guid` at the current decode site.
 *
 * Resolution order: a symbol when one is available, a `{name, guid}` literal when
 * the target is known but a symbol would not work, and the bare guid — reported —
 * when the bundle does not contain the target at all.
 */
export function resolveReference(
  ctx: DecodeContext,
  index: RefIndex,
  guid: string,
  options: ResolveOptions = {},
): Expr {
  const target = index.lookup(guid);
  if (!target) {
    // `0` is not a guid that happens to be missing — it is an internal row id
    // standing where portable identity belongs, which no bundle could ever
    // contain. Splitting it out is what lets the genuinely-unresolvable case
    // keep error severity: 219 of the 220 misses in the survey corpus are this
    // one, and folding them together made a category that never meant what it
    // said. See `unportable-id` in the report module.
    ctx.problem(
      guid === "0" ? "unportable-id" : "unresolved-ref",
      guid === "0"
        ? "a reference stored as `guid 0` — an internal row id rather than portable identity, so it " +
            "cannot resolve to an object in any bundle and is carried verbatim"
        : `guid ${guid} is not present in this bundle`,
    );
    return options.unresolved === "object-ref"
      ? obj([
          ["name", lit("")],
          ["guid", lit(guid)],
        ])
      : lit(guid);
  }
  const symbol = options.symbolFor?.(target) ?? null;
  if (symbol !== null) return id(symbol);
  return obj([
    ["name", lit(target.name)],
    ["guid", lit(target.guid)],
  ]);
}
