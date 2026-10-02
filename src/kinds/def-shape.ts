/**
 * The def-level shape check `register*` runs before a def is encoded.
 *
 * The typed surface already rules these out; this is for the untyped caller
 * (plain JavaScript, or a value that crossed an `any`). Without it a wrong shape
 * either crashed inside an encoder with a TypeError naming nothing the author
 * wrote — `(def.schedule ?? []).map is not a function`, `(defs ?? []) is not
 * iterable` — or was stored as-is: `apiGroup({ name: 5 })` kept `5`, and
 * `table({ schema: { a: 5 } })` a column with no type.
 *
 * Only a field that is PRESENT is checked (`undefined` and `null` are the
 * absent field), so every kind can share the common roster below.
 */
import { PROTO_KEY, describeEntry, protoKeyed } from "../statements/args.js";

type Shape =
  /** A string. */
  | "string"
  /** A boolean. */
  | "boolean"
  /** A list of strings. */
  | "string[]"
  /** A list of plain objects. */
  | "object[]"
  /** A list, entries checked by the kind's own encoder. */
  | "list"
  /** A plain object. */
  | "object"
  /** A `{ name: descriptor }` record whose values are objects. */
  | "record"
  /** A table schema: a `{ column: f.*() }` record, or a list of column objects. */
  | "schema"
  /** A middleware attachment: `{ pre?: [...], post?: [...] }`. */
  | "attach";

/** Fields most kinds carry, and what each must be when present. */
const COMMON: Readonly<Record<string, Shape>> = {
  name: "string",
  guid: "string",
  description: "string",
  docs: "string",
  tags: "string[]",
  active: "boolean",
  tests: "object[]",
  input: "record",
  middleware: "attach",
};

/** Kind-specific list and object fields, keyed by registry kind name. */
const BY_KIND: Readonly<Record<string, Readonly<Record<string, Shape>>>> = {
  task: { schedule: "object[]", datasource: "string" },
  query: { cache: "object" },
  function: { cache: "object" },
  table: { schema: "schema", index: "object[]", views: "object[]", autocomplete: "string[]" },
  api_group: { canonical: "string", swagger: "boolean", cors: "object", documentation: "object" },
  agent: { tools: "list", llm: "object" },
  trigger: { datasources: "string[]", actions: "object" },
  mcp_server: { tools: "list", canonical: "string" },
  microservice: { configs: "object[]", volumes: "object[]", ingresses: "object[]", deployment: "object" },
  workspace: {
    env: "object", history: "object", realtime: "object", documentation: "object", defaults: "object",
    preferences: "object", settings: "object",
  },
};

/** The factory an author writes for a registry kind whose stored name differs. */
export const AUTHOR_KIND_NAME: Readonly<Record<string, string>> = {
  api_group: "apiGroup",
  mcp_server: "mcpServer",
  realtime_server: "realtimeServer",
  channel: "realtimeChannel",
  message: "realtimeMessage",
  workflow_test: "workflowTest",
  workspace: "workspaceConfig",
};

const EXPECTED: Readonly<Record<Shape, string>> = {
  string: "a string",
  boolean: "true or false",
  "string[]": "a list of strings",
  "object[]": "a list of objects",
  list: "a list",
  object: "a { … } object",
  record: "a { name: descriptor } record",
  schema: "a { column: f.*() } record (or a list of columns)",
  attach: "a { pre?: [...], post?: [...] } object",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Refuse a present field of the wrong shape, naming the def and the field:
 * `task "nightly": \`schedule\` must be a list of objects — got number 5.`
 */
export function assertDefShape(kindName: string, def: Record<string, unknown>): void {
  const label = AUTHOR_KIND_NAME[kindName] ?? kindName;
  const owner = typeof def.name === "string" ? `${label} "${def.name}"` : label;
  assertNoProtoKeys(owner, def);
  // A table's columns are what it IS: with no `schema` the encoder reached
  // `Object.entries(undefined)` and reported "Cannot convert undefined or null
  // to object" — the crash `registerTables([someOtherDef])` produced.
  if (kindName === "table" && (def.schema === undefined || def.schema === null)) {
    throw new Error(`${owner}: \`schema\` is required — a { column: f.*() } record (or a list of columns).`);
  }
  const fields = { ...COMMON, ...BY_KIND[kindName] };
  for (const [field, shape] of Object.entries(fields)) {
    const v = def[field];
    if (v === undefined || v === null) continue;
    const bad = shapeProblem(shape, v, field);
    if (bad !== undefined) {
      throw new Error(`${owner}: \`${bad.at}\` must be ${bad.expected} — got ${describeEntry(bad.got)}.`);
    }
  }
  // A view's `name` and `id` are stored verbatim; without them the export
  // carried `undefined` and a pulled tree read `id: undefined`, which no
  // `ViewDef` accepts.
  if (kindName === "table" && Array.isArray(def.views)) {
    def.views.forEach((view: Record<string, unknown>, i) => {
      for (const key of ["name", "id"] as const) {
        if (typeof view[key] === "string") continue;
        throw new Error(
          `${owner}: \`views[${i}].${key}\` is required — ` +
            (key === "id" ? "the view's stable uuid (`crypto.randomUUID()` once, then keep it)" : "the view's label") +
            ` — got ${describeEntry(view[key])}.`,
        );
      }
    });
  }
}

function shapeProblem(shape: Shape, v: unknown, field: string): { at: string; expected: string; got: unknown } | undefined {
  const whole = { at: field, expected: EXPECTED[shape], got: v };
  switch (shape) {
    case "string":
      return typeof v === "string" ? undefined : whole;
    case "boolean":
      return typeof v === "boolean" ? undefined : whole;
    case "object":
      return isPlainObject(v) ? undefined : whole;
    case "list":
      return Array.isArray(v) ? undefined : whole;
    case "string[]":
    case "object[]": {
      if (!Array.isArray(v)) return whole;
      const want = shape === "string[]" ? "a string" : "an object";
      const i = v.findIndex((e) => (shape === "string[]" ? typeof e !== "string" : !isPlainObject(e)));
      return i === -1 ? undefined : { at: `${field}[${i}]`, expected: want, got: v[i] };
    }
    case "record": {
      if (!isPlainObject(v)) return whole;
      const bad = Object.entries(v).find(([, d]) => !isPlainObject(d) && typeof d !== "function");
      return bad === undefined ? undefined : { at: `${field}.${bad[0]}`, expected: "a descriptor object", got: bad[1] };
    }
    case "attach": {
      if (!isPlainObject(v)) return whole;
      for (const side of ["pre", "post"]) {
        const list = v[side];
        if (list !== undefined && list !== null && !Array.isArray(list)) {
          return { at: `${field}.${side}`, expected: "a list of middleware", got: list };
        }
      }
      return undefined;
    }
    case "schema": {
      if (Array.isArray(v)) {
        const i = v.findIndex((e) => !isPlainObject(e) || typeof e.name !== "string" || typeof e.type !== "string");
        return i === -1 ? undefined : { at: `${field}[${i}]`, expected: "a column ({ name, type })", got: v[i] };
      }
      if (!isPlainObject(v)) return whole;
      const bad = Object.entries(v).find(([, d]) => !isPlainObject(d) || typeof d.type !== "string");
      return bad === undefined ? undefined : { at: `${field}.${bad[0]}`, expected: "a field (f.text(), f.int(), …)", got: bad[1] };
    }
  }
}

/**
 * The first record under `root` whose prototype a literal `__proto__:` key set,
 * as its path (`schema`, `response.user`, `env[0]`) — `""` for `root` itself.
 *
 * Walks what the author wrote, BEFORE it is encoded: every encoder reads own
 * keys, so by the time a bundle exists the member is simply gone — a table
 * column, a function input, a response key, a config entry — and a record
 * whose prototype is a tagged value was read as that value. Descends only into
 * arrays and plain records; a class instance's internals are not the author's
 * keys.
 */
export function findProtoKeyed(root: unknown): string | undefined {
  const stack: Array<[unknown, string]> = [[root, ""]];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const [node, path] = stack.pop()!;
    if (node === null || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (protoKeyed(node)) return path;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push([node[i], `${path}[${i}]`]);
      continue;
    }
    const proto = Object.getPrototypeOf(node) as unknown;
    if (proto !== Object.prototype && proto !== null) continue;
    const keys = Object.keys(node);
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!;
      stack.push([(node as Record<string, unknown>)[key], path === "" ? key : `${path}.${key}`]);
    }
  }
  return undefined;
}

/**
 * Refuse a def carrying a literal `__proto__:` key anywhere an author wrote a
 * record. TypeScript types the key as a member, so nothing flagged it — and
 * JavaScript never stored it as one.
 */
export function assertNoProtoKeys(owner: string, def: unknown): void {
  const at = findProtoKeyed(def);
  if (at === undefined) return;
  throw new Error(
    `${owner}: ${at === "" ? "the def" : `\`${at}\``} has a \`__proto__\` key that is not a member — ${PROTO_KEY}.`,
  );
}
