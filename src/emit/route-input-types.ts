/**
 * The route manifest's request input types: {@link RouteInputs} (the planner's
 * validator-neutral description) → the `RouteInputs`, `ChannelInputs`,
 * `MessageInputs` and `MessageName` types `routes.gen.ts` exports.
 *
 * WHY THIS MIRRORS `InferInput` RULE FOR RULE. A backend authored with the SDK
 * types its request payloads with `InferInput<typeof def>`, read off the def's
 * brands (`src/fields/value-types.ts`). A frontend reads these types instead,
 * read off the STORED payload, because the decode paths (`pull`, `generate`,
 * `init --from`) write the manifest with no def to ask. Two mappings of one
 * input that disagree is the exact drift the manifest exists to remove, so each
 * rule here is the stored-row twin of one there:
 *
 * - `required` decides the key's `?` (`FromFieldMap`). A required input with a
 *   default stays required: the default is the server's, not a promise the
 *   client may omit it.
 * - `nullable` adds `| null` AFTER a list's `[]` (`ApplyArray`, then
 *   `ApplyNullable`), so a nullable list is `T[] | null`, never `(T | null)[]`.
 *   The description already resolved each type's nullable default for the
 *   surface it was stored on, so nothing is defaulted again here.
 * - An OPTIONAL key named after an `Object.prototype` member also admits that
 *   member's type (`ProtoKeySafe`), or an object literal that omits it fails
 *   against the inherited member.
 * - The SDK value types this file cannot import (`XanoFileRef`,
 *   `XanoFileUpload`, `XanoGeoValue`) are written out structurally, member for
 *   member, so each is the same type as the SDK's, not merely a compatible one.
 *
 * The deliberate divergences from `InferInput`, each pinned by the parity test
 * (`test/emit/route-input-types.test.ts`) that owns the list:
 *
 * - A dbLink is the linked table's expanded columns, spread into the parent
 *   object — what the engine binds and a client sends — not `InferInput`'s
 *   opaque marker under the link's own name.
 * - A dbLink whose table is not in the payload opens the object with
 *   `[column: string]: unknown`: its columns cannot be known, and leaving them
 *   out would reject a body the server accepts.
 * - A key declared twice in one object (a dbLink column and a sibling input)
 *   renders once, as the union of its declarations.
 * - A `json` list admits `null`: the engine binds every `json` input nullable,
 *   and `InferInput` only shows it on a scalar `json`, where `unknown` already
 *   absorbs `null`.
 *
 * Types only, and no import: these sections add nothing to a bundle, and the
 * manifest stays loadable without the SDK installed.
 */
import type { InputDescription, RouteInputSet, RouteInputs } from "../plugin.js";

/** An empty description — the input maps of a manifest with nothing in it. */
export const NO_ROUTE_INPUTS: RouteInputs = { routes: [], channels: [], messages: [] };

/**
 * `Object.prototype`'s members, as `keyof Object` lists them in the ES2022
 * lib. An optional key with one of these names is widened (`ProtoKeySafe`).
 */
const OBJECT_MEMBERS: ReadonlySet<string> = new Set([
  "constructor",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
]);

/** `XanoFileRef`, member for member (`src/fields/value-types.ts`). */
const FILE_REF = "{ path?: string; name?: string; type?: string; size?: number; access?: string; meta?: unknown; url?: string }";

/** `XanoFileUpload`, member for member. */
const FILE_UPLOAD = "{ readonly __fileUpload?: never }";

const POSITION = "{ lng: number; lat: number }";

/** `XanoGeoValue<K>` for each stored geo type: the `type` name and its `data` nesting. */
const GEO: Readonly<Record<string, string>> = {
  geo_point: `{ type: "point"; data: ${POSITION} }`,
  geo_multipoint: `{ type: "points"; data: ${POSITION}[] }`,
  geo_linestring: `{ type: "path"; data: ${POSITION}[] }`,
  geo_multilinestring: `{ type: "paths"; data: ${POSITION}[][] }`,
  geo_polygon: `{ type: "poly"; data: ${POSITION}[] }`,
  geo_multipolygon: `{ type: "polys"; data: ${POSITION}[][] }`,
};

/** The value type each scalar stored type carries, as `f.*`/`input.*` brand it. */
const SCALAR: Readonly<Record<string, string>> = {
  text: "string",
  email: "string",
  password: "string",
  uuid: "string",
  date: "string",
  int: "number",
  decimal: "number",
  epochms: "number",
  bool: "boolean",
  json: "unknown",
  file: FILE_UPLOAD,
  blob: FILE_REF,
  blob_img: FILE_REF,
  blob_video: FILE_REF,
  blob_audio: FILE_REF,
  ...GEO,
};

/** A property name: bare when it is an identifier, else a string literal. */
function propertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** The base value of one input, before its list and nullable flags. */
function baseType(d: Exclude<InputDescription, { type: "dbLink" }>, indent: string): string {
  switch (d.type) {
    case "enum":
      return d.values.length === 0 ? "never" : d.values.map((v) => (typeof v === "number" ? String(v) : JSON.stringify(v))).join(" | ");
    case "vector":
      return "number[]";
    case "tableRef":
      return d.keyType === "uuid" ? "string" : "number";
    case "obj":
      return objectType(d.children, indent);
    case "unknown":
      return "unknown";
    default:
      return SCALAR[d.type] ?? "unknown";
  }
}

/** One input's full value type: base, then `[]` for a list, then `| null`. */
function valueType(d: Exclude<InputDescription, { type: "dbLink" }>, indent: string): string {
  let type = baseType(d, indent);
  // An enum is the one base that is a union, or a negative literal; both need
  // parentheses before `[]`.
  if (d.list !== false) type = d.type === "enum" ? `(${type})[]` : `${type}[]`;
  // `unknown | null` is `unknown`; spelling it out only adds noise.
  if (d.nullable && type !== "unknown") type = `${type} | null`;
  return type;
}

/**
 * The object type of one input list, at `indent`.
 *
 * A dbLink contributes its columns as keys of THIS object, not a nested one,
 * because the engine expands the link at the level it is declared on. A key
 * reached twice (a link column beside a sibling of the same name) renders once,
 * as the union of its types, and is required only when every declaration is: a
 * repeated property is a compile error, and the union never rejects a body
 * either declaration accepts.
 */
function objectType(inputs: readonly InputDescription[], indent: string): string {
  const keys = new Map<string, { types: string[]; required: boolean }>();
  let open = false;
  const inner = `${indent}  `;
  const visit = (list: readonly InputDescription[]): void => {
    for (const d of list) {
      if (d.type === "dbLink") {
        if (d.columns === undefined) open = true;
        else visit(d.columns);
        continue;
      }
      const type = valueType(d, inner);
      const seen = keys.get(d.name);
      if (seen === undefined) {
        keys.set(d.name, { types: [type], required: d.required });
      } else {
        if (!seen.types.includes(type)) seen.types.push(type);
        seen.required &&= d.required;
      }
    }
  };
  visit(inputs);

  const rows = [...keys].map(([name, { types, required }]) => {
    const widened = !required && OBJECT_MEMBERS.has(name) ? [...types, `Object[${JSON.stringify(name)}]`] : types;
    return `${inner}${propertyName(name)}${required ? "" : "?"}: ${widened.join(" | ")};`;
  });
  if (open) rows.push(`${inner}[column: string]: unknown;`);
  return rows.length === 0 ? "{}" : `{\n${rows.join("\n")}\n${indent}}`;
}

/** One exported map: each set's key to its object type, in the description's order. */
function inputMap(name: string, doc: string, sets: readonly RouteInputSet[]): string {
  const rows = sets.map((set) => `  ${JSON.stringify(set.key)}: ${objectType(set.inputs, "  ")};`);
  return `${doc}\nexport type ${name} = ${rows.length === 0 ? "{}" : `{\n${rows.join("\n")}\n}`};\n`;
}

/**
 * The manifest's input-type section: one contiguous block, emitted after every
 * runtime section so it never lands between an overload set and its body.
 *
 * All four types are emitted whatever the workspace holds — an empty map is
 * `{}` — so a frontend's `RouteInputs[...]` import compiles before its first
 * channel exists, and a module rendering beside these always has the three maps
 * to check against.
 */
export function renderRouteInputTypes(inputs: RouteInputs): string {
  return `
${inputMap(
  "RouteInputs",
  `/**
 * The request body/query inputs of every endpoint, keyed exactly like ROUTES.
 * Path params are inputs too, so they appear here as well as in routePath().
 * Matches InferInput<typeof def>, except that a database-link input appears as
 * the linked table's columns, which is what the server accepts.
 */`,
  inputs.routes,
)}
${inputMap(
  "ChannelInputs",
  "/** The path params of every realtime channel, keyed exactly like CHANNELS. */",
  inputs.channels,
)}
${inputMap(
  "MessageInputs",
  `/**
 * The payload of every realtime message, keyed "<channel key> <message name>"
 * (e.g. "rooms/{room_id} send").
 */`,
  inputs.messages,
)}
/** Every realtime message in this workspace, keyed "<channel key> <message name>". */
export type MessageName = keyof MessageInputs;
`;
}
