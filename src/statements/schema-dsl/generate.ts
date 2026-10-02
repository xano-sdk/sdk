/**
 * Schema → StatementSpec generator. Interprets a parsed declarative
 * statement schema's `transform.args` / `transform.blocks` rules into a flat
 * `StatementSpec` the interpreter can execute. Schemas that use directives or
 * targets outside the cleanly-interpretable set are returned as a
 * skip-with-reason — never guessed — so they surface in the codegen pending log
 * and the coverage report.
 *
 * Cleanly interpretable today:
 *  - plain string args/blocks → `as` or `context.<path>`
 *  - `!assign context`        → spread a Value into `context`
 *  - `!assign context.<path>` → nest a Value under `context.<path>`
 *  - `?=<default>` defaults and trailing `?` optionality
 *
 * Deferred (skip-with-reason): `!compare`, `!inline:array`, `!map:dbo`, `!var`,
 * `!db:*`, any `input.*` target, inline-list targets (`[]`), `!class` /
 * `!function` transforms, and nested-object field decls.
 */
import type { YamlMap, YamlNode } from "./parse.js";
import type { FieldRule, FieldType, Route, StatementSpec } from "./interpret.js";

import { SUPERSEDED_STATEMENTS } from "../superseded.js";

/** A successful generation, or a skip with the reason it was deferred. */
export type GenResult = { spec: StatementSpec } | { skip: string };

interface FieldDecl {
  type: FieldType | "complex";
  optional: boolean;
}

/** Read declared fields from an `args:` / `blocks:` map → name → {type, optional}. */
function collectDecls(node: YamlNode | undefined): Record<string, FieldDecl> {
  const decls: Record<string, FieldDecl> = {};
  if (typeof node !== "object" || Array.isArray(node)) return decls;
  for (const [rawKey, value] of Object.entries(node)) {
    const optional = rawKey.includes("?");
    const name = stripFieldName(rawKey);
    let type: FieldDecl["type"];
    if (typeof value === "object") {
      type = "complex"; // nested object/list decl (e.g. db.query `return:`)
    } else if (value.includes("assign")) {
      type = "value"; // `!kinds assign`, `assign:object`, `!kinds [assign,...]`
    } else {
      type = "string"; // `static:text`, `static:bool`, …
    }
    decls[name] = { type, optional };
  }
  return decls;
}

/** Strip `?`, `=default`, and `[]` adornments from a declared/transform key → bare field name. */
function stripFieldName(key: string): string {
  return key.replace(/\?.*$/, "").replace(/\[\]$/, "").trim();
}

/** Parse a transform key like `name?=''` → field, optional, default. */
function parseTransformKey(key: string): { field: string; optional: boolean; default?: string } {
  const field = stripFieldName(key);
  const optional = key.includes("?");
  const eq = key.indexOf("=");
  let def: string | undefined;
  if (eq !== -1) {
    def = key.slice(eq + 1).trim();
    if (
      (def.startsWith("'") && def.endsWith("'")) ||
      (def.startsWith('"') && def.endsWith('"'))
    ) {
      def = def.slice(1, -1);
    }
  }
  return { field, optional, default: def };
}

/** Interpret a transform target value (right of the colon) into a Route, or null if unsupported. */
function routeFor(target: string): Route | null {
  if (target === "as") return { kind: "as" };
  if (target === "!assign context") return { kind: "context-spread" };
  const assignNest = target.match(/^!assign context\.(.+)$/);
  if (assignNest) return { kind: "context-nest", path: assignNest[1]! };
  // `!inline:array context.X` stores the authored array Value's fields at context.X
  // (same nested {value,tag,filters} shape as an assign-nest).
  const inlineArray = target.match(/^!inline:array context\.(.+)$/);
  if (inlineArray) return { kind: "context-nest", path: inlineArray[1]! };
  // `!compare context.X` stores a binary comparison's `{expression:[…]}` at context.X.
  const compare = target.match(/^!compare context\.(.+)$/);
  if (compare) return { kind: "context-compare", path: compare[1]! };
  // `!assign input.X` becomes an `input[]` argument binding named X.
  const inputAssign = target.match(/^!assign input\.(.+)$/);
  if (inputAssign) return { kind: "input", name: inputAssign[1]! };
  if (/^context\.(.+)$/.test(target)) {
    return { kind: "context-plain", path: target.slice("context.".length) };
  }
  return null; // !map:dbo, !var, !db:*, [], … (need the richer field/envelope system — deferred)
}

function buildRules(
  transformMap: YamlNode,
  decls: Record<string, FieldDecl>,
): { rules: FieldRule[] } | { skip: string } {
  if (typeof transformMap !== "object" || Array.isArray(transformMap)) {
    return { rules: [] }; // `blocks: []` and empty blocks have no rules
  }
  const rules: FieldRule[] = [];
  for (const [rawKey, rawTarget] of Object.entries(transformMap)) {
    if (typeof rawTarget !== "string") {
      return { skip: `nested transform target for "${stripFieldName(rawKey)}"` };
    }
    const { field, optional, default: def } = parseTransformKey(rawKey);
    const route = routeFor(rawTarget);
    if (!route) return { skip: `unsupported transform target "${rawTarget}"` };

    const decl = decls[field];
    if (decl?.type === "complex") return { skip: `complex field decl "${field}"` };
    // Field type follows the route: compare → Comparison; spread/nest → Value;
    // as / context-plain → string.
    let type: FieldType;
    if (route.kind === "context-compare") type = "comparison";
    else if (route.kind === "context-spread" || route.kind === "context-nest" || route.kind === "input")
      type = "value";
    else type = "string";
    rules.push({ field, type, optional: optional || (decl?.optional ?? false), default: def, route });
  }
  return { rules };
}

/** Generate a StatementSpec from a parsed schema tree, or skip with a reason. */
export function schemaToSpec(doc: YamlMap): GenResult {
  const alias = typeof doc.alias === "string" ? doc.alias : undefined;
  const transform = doc.transform;

  if (transform === undefined) return { skip: "no transform block" };
  if (typeof transform === "string") {
    if (transform.startsWith("!class")) return { skip: "transform: !class (hand-authored special — U10)" };
    if (transform.startsWith("!function")) return { skip: "transform: !function (structural control-flow — U10)" };
    return { skip: `scalar transform "${transform}"` };
  }
  if (!alias) return { skip: "no alias" };
  // A RETIRED version of a versioned family. The engine still declares a schema
  // for it — existing stacks run it — but each version was a breaking change to
  // the one before, so only the latest is worth an authoring surface. Skipping
  // here is what keeps it out of the spec catalog, the `s.` factory tree, and
  // therefore the agent-grounding manifest; codegen decodes it through `raw()`
  // instead. See `SUPERSEDED_STATEMENTS`.
  if (SUPERSEDED_STATEMENTS.has(alias)) {
    const successor = SUPERSEDED_STATEMENTS.get(alias);
    return {
      skip: successor
        ? `superseded by ${successor} — only the latest of a versioned family is authorable`
        : "retired statement with no replacement",
    };
  }

  const tmap = transform as YamlMap;
  const argDecls = collectDecls(doc.args);
  const blockDecls = collectDecls(doc.blocks);

  const rules: FieldRule[] = [];
  if (tmap.args !== undefined) {
    const r = buildRules(tmap.args, argDecls);
    if ("skip" in r) return r;
    rules.push(...r.rules);
  }
  if (tmap.blocks !== undefined) {
    const r = buildRules(tmap.blocks, blockDecls);
    if ("skip" in r) return r;
    rules.push(...r.rules);
  }
  if (rules.length === 0) return { skip: "no interpretable transform rules" };

  const argNameIsVar = doc.argNameIsVar === "true";
  const spec: StatementSpec = { name: alias, rules };
  if (argNameIsVar) spec.argNameIsVar = true;
  return { spec };
}
