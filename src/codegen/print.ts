/**
 * Deterministic source printer — structured nodes in, formatted TypeScript out.
 *
 * There is no formatter dependency and no width heuristic. A node renders
 * multiline because of **what it is** — a non-empty object or array, or a call
 * carrying one — never because of how wide it measured. Formatting is therefore
 * a property of construction: the same node tree always prints the same bytes,
 * which is what lets the generated-tree tests compare output directly.
 *
 * Inline collapsing under a width threshold is deliberately not implemented; it
 * is a deferred follow-up, gated on real generated output reading badly.
 */

/** A source expression node. */
export type Expr =
  /** An identifier or already-formed source expression, emitted verbatim. */
  | { readonly kind: "id"; readonly text: string }
  /** Plain JSON-like data, rendered as a TypeScript literal. */
  | { readonly kind: "literal"; readonly value: unknown }
  /** `callee(arg, …)`. */
  | { readonly kind: "call"; readonly callee: string; readonly args: readonly Expr[] }
  /** An object literal; entry order is insertion order, so decoders control it. */
  | { readonly kind: "object"; readonly entries: ReadonlyArray<readonly [string, Expr]> }
  /** An array literal. */
  | { readonly kind: "array"; readonly items: readonly Expr[] }
  /** `{ ...base, key: value, … }` — an object literal spreading another expression. */
  | {
      readonly kind: "spread";
      readonly base: Expr;
      readonly entries: ReadonlyArray<readonly [string, Expr]>;
    }
  /** `(params) => body` — an arrow with an expression body, never a block. */
  | { readonly kind: "arrow"; readonly params: readonly string[]; readonly body: Expr };

/** An `import { … } from "…"` statement. */
export interface ImportStmt {
  readonly kind: "import";
  readonly module: string;
  readonly symbols: readonly string[];
  readonly typeOnly?: boolean;
}

/** A module-level statement. */
export type Stmt =
  | { readonly kind: "comment"; readonly text: string }
  | ImportStmt
  | {
      readonly kind: "const";
      readonly name: string;
      readonly value: Expr;
      readonly exported?: boolean;
    }
  | { readonly kind: "exportDefault"; readonly value: Expr }
  /**
   * `export { a, b };` over symbols already in scope. The barrel imports every
   * object to register it, so re-exporting the local bindings costs one
   * statement — where `export … from` would restate every module specifier and
   * double the file's import graph.
   */
  | { readonly kind: "exportNamed"; readonly symbols: readonly string[] }
  | { readonly kind: "blank" };

/** An identifier or verbatim source expression (e.g. a symbol reference). */
export function id(text: string): Expr {
  return { kind: "id", text };
}

/** Plain data rendered as a TypeScript literal. */
export function lit(value: unknown): Expr {
  return { kind: "literal", value };
}

/** `callee(...args)`. */
export function call(callee: string, ...args: Expr[]): Expr {
  return { kind: "call", callee, args };
}

/** An object literal preserving the given entry order. */
export function obj(entries: ReadonlyArray<readonly [string, Expr]>): Expr {
  return { kind: "object", entries };
}

/** An array literal. */
export function arr(items: readonly Expr[]): Expr {
  return { kind: "array", items };
}

/**
 * `{ ...base, key: value }` — override a few keys on an expression's result.
 *
 * The escape hatch for envelope keys a factory has no parameter for. A statement
 * carries `description` (and the engine persists it), but no hand-written
 * statement factory takes one, so an authored description would otherwise force
 * the whole statement to `raw()`.
 */
export function spread(base: Expr, entries: ReadonlyArray<readonly [string, Expr]>): Expr {
  return { kind: "spread", base, entries };
}

/**
 * `(params) => body`.
 *
 * The form a factory taking a callback needs — a trigger's `stack: (t) => […]`,
 * where `t` is the typed input handle. Expression-bodied only: every callback the
 * decoders produce returns one expression, and a block body would need statements
 * this printer has no node for.
 */
export function arrow(params: readonly string[], body: Expr): Expr {
  return { kind: "arrow", params, body };
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Marks an object key printed as `["name" as never]` — see {@link untypedKey}. */
const UNTYPED_KEY = "\u0000untyped:";

/**
 * An object key printed as the computed `["name" as never]`: the same property
 * at runtime, but one the literal's declared type does not check. For a stored
 * key the typed surface no longer declares (a call input its target dropped),
 * so the tree compiles and re-encodes to the same bytes.
 */
export function untypedKey(name: string): string {
  return UNTYPED_KEY + name;
}
const INDENT = "  ";

/**
 * Object keys stay bare when they are valid identifiers, quoted otherwise.
 *
 * `__proto__` is COMPUTED: in an object literal both `__proto__: x` and
 * `"__proto__": x` set the prototype and store nothing, so a column, input or
 * cell of that name vanished from the regenerated tree. `["__proto__"]: x` is an
 * ordinary own property.
 */
function key(name: string): string {
  if (name.startsWith(UNTYPED_KEY)) return `[${JSON.stringify(name.slice(UNTYPED_KEY.length))} as never]`;
  if (name === "__proto__") return `[${JSON.stringify(name)}]`;
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** Convert plain data to the equivalent node tree so one renderer handles both. */
function fromData(value: unknown): Expr {
  if (Array.isArray(value)) return arr(value.map(fromData));
  if (value !== null && typeof value === "object") {
    return obj(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fromData(v)]));
  }
  return { kind: "id", text: JSON.stringify(value) ?? "undefined" };
}

/**
 * Render an expression. `depth` is the indentation level of the line the
 * expression *starts* on — continuation lines indent relative to it.
 */
export function printExpr(node: Expr, depth = 0): string {
  const pad = INDENT.repeat(depth);
  const inner = INDENT.repeat(depth + 1);

  switch (node.kind) {
    case "id":
      return node.text;

    case "literal":
      return printExpr(fromData(node.value), depth);

    case "array": {
      if (node.items.length === 0) return "[]";
      const items = node.items.map((item) => `${inner}${printExpr(item, depth + 1)},`);
      return `[\n${items.join("\n")}\n${pad}]`;
    }

    case "object": {
      if (node.entries.length === 0) return "{}";
      const entries = node.entries.map(
        ([k, v]) => `${inner}${key(k)}: ${printExpr(v, depth + 1)},`,
      );
      return `{\n${entries.join("\n")}\n${pad}}`;
    }

    case "spread": {
      const lines = [`${inner}...${printExpr(node.base, depth + 1)},`];
      for (const [k, v] of node.entries) lines.push(`${inner}${key(k)}: ${printExpr(v, depth + 1)},`);
      return `{\n${lines.join("\n")}\n${pad}}`;
    }

    case "arrow": {
      // The body continues on the arrow's own line, so it renders at the arrow's
      // depth — a multiline body closes under the line the arrow started on,
      // exactly like a call's argument.
      const body = printExpr(node.body, depth);
      // Trailing parameters the body never names are left off, so a callback that
      // ignores its handle compiles under `noUnusedParameters` (`() => […]`). A
      // name that merely appears inside a string keeps its parameter — harmless.
      const params = [...node.params];
      while (params.length > 0 && !new RegExp(`(^|[^\\w$.])${params[params.length - 1]!.replace(/\$/g, "\\$")}\\b`).test(body)) {
        params.pop();
      }
      // An object-literal body is parenthesised: `(t) => { tools: … }` parses as
      // a block holding a label, not an object. Checked on the rendered text, so
      // every node that prints as `{` — object, spread, object data, a verbatim
      // id — is covered, not only the node kinds known today.
      return `(${params.join(", ")}) => ${body.startsWith("{") ? `(${body})` : body}`;
    }

    case "call": {
      if (node.args.length === 0) return `${node.callee}()`;
      // Arguments always continue on the call's own line, so they render at the
      // call's depth — a multiline argument's closing brace lands under the call.
      return `${node.callee}(${node.args.map((a) => printExpr(a, depth)).join(", ")})`;
    }
  }
}

/** Render a module: statements joined by newlines, with a trailing newline. */
export function printModule(stmts: readonly Stmt[]): string {
  const lines: string[] = [];
  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "blank":
        lines.push("");
        break;
      case "comment":
        for (const line of stmt.text.split("\n")) lines.push(line === "" ? "//" : `// ${line}`);
        break;
      case "import": {
        const kw = stmt.typeOnly ? "import type" : "import";
        // Sorted here too, not only in the collector: determinism is the
        // printer's contract, so it must not depend on how the caller built the list.
        const symbols = [...stmt.symbols].sort().join(", ");
        lines.push(`${kw} { ${symbols} } from ${JSON.stringify(stmt.module)};`);
        break;
      }
      case "const":
        lines.push(
          `${stmt.exported ? "export " : ""}const ${stmt.name} = ${printExpr(stmt.value)};`,
        );
        break;
      case "exportDefault":
        lines.push(`export default ${printExpr(stmt.value)};`);
        break;
      case "exportNamed": {
        if (stmt.symbols.length === 0) break;
        // Sorted for the same reason imports are: determinism is the printer's
        // contract, independent of how the caller built the list.
        const symbols = [...stmt.symbols].sort();
        const single = `export { ${symbols.join(", ")} };`;
        // One symbol per line past a screen width. A whole workspace's objects
        // on one line is a 30 KB row no editor wraps usefully, and it makes
        // every diff of the barrel a single changed line.
        if (single.length <= 100) lines.push(single);
        else lines.push("export {", ...symbols.map((s) => `  ${s},`), "};");
        break;
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
