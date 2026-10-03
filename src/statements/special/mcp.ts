/**
 * `s.mcp.elicit` — ask the MCP client's user for structured input in the
 * middle of a tool, prompt or resource call.
 *
 * `s.mcp.progress` (report progress to the client) and `s.mcp.oauth.*` (the
 * MCP sign-in hand-off) are declarative statements from the generated catalog.
 * This module holds the elicit wrapper, whose stored shape carries an
 * input-field schema no spec describes.
 */
import type { Statement, AsShapeBrand, StatementOptions } from "../statement.js";
import { annotate, registerStatement } from "../statement.js";
import type { FilterXdo, InputXdo } from "../../types/xdo.js";
import type { ApplyFilters } from "../../values/filter-result.js";
import { c } from "../../values/value.js";
import type { Value } from "../../values/value.js";
import { encodeInput } from "../../inputs/input.js";
import type { InputDescriptor } from "../../inputs/input.js";
import { argsOrEmpty, assertValueArg, describeArg } from "../args.js";
import { assertKnownKeys, type AllKeys } from "../../util/known-keys.js";

function vf(v: Value): { value: string; tag: string; filters: unknown[] } {
  return { value: v.value, tag: v.tag, filters: v.filters };
}

/** What an elicit binds: the user's action, plus their answers when they accepted. */
export interface ElicitResult<C = Record<string, unknown>> {
  action: "accept" | "decline" | "cancel";
  /** Present only when `action` is `"accept"`: the answers, keyed by the `input` field names. */
  content?: C;
}

export interface McpElicitArgs<As extends string = string> extends StatementOptions {
  /**
   * The answer's identity across retries — a short, stable name, unique within
   * the stack (`"confirm_delete"`). The whole stack re-runs from the top when
   * the client answers, and this key is how the re-run finds the answer.
   */
  key: string | Value;
  /** What the client shows the user (`"Delete 3 orders?"`). */
  message: string | Value;
  /**
   * The form's fields — the same grammar as a tool's `input`, restricted to
   * what an MCP form can carry: a FLAT set of `text`, `email`, `date`, `int`,
   * `decimal`, `bool` and `enum` fields (an enum may be a list, for
   * multi-select). `min`/`max` methods become the field's bounds. No nested
   * objects, files, JSON or timestamps, and no `password` or `sensitive`
   * field — the MCP spec forbids collecting secrets through a form. Omit for a
   * plain accept/decline confirmation.
   */
  input?: Record<string, InputDescriptor>;
  /** The variable the result binds to — an {@link ElicitResult}. */
  as?: As;
}

/** Field types an MCP form can carry. */
const FORM_TYPES: readonly string[] = ["text", "email", "date", "int", "decimal", "bool", "enum"];

/** Refuse, at export, a field the platform refuses on EVERY call at run time. */
function assertFormField(field: InputXdo): void {
  const at = `Statement "s.mcp.elicit": \`input.${field.name}\``;
  const list = (field as { style?: { type?: string } }).style?.type === "list";
  if (field.type === "password" || (field as { sensitive?: unknown }).sensitive === true) {
    throw new Error(`${at}: a form must not collect secrets (the MCP spec forbids it), so a password or sensitive field is refused.`);
  }
  if (Array.isArray(field.children) && field.children.length > 0) {
    throw new Error(`${at}: nested objects are not supported — an MCP form is a flat set of fields.`);
  }
  if (!FORM_TYPES.includes(field.type)) {
    throw new Error(`${at}: "${field.type}" cannot be asked in an MCP form. Use one of ${FORM_TYPES.join(", ")}.`);
  }
  if (list && field.type !== "enum") {
    throw new Error(`${at}: only an enum may be a list (a multi-select) in an MCP form.`);
  }
}

const MCP_ELICIT_KEYS = /* @__PURE__ */ Object.keys({ key: 1, message: 1, input: 1, as: 1, asFilters: 1, uncheckedAs: 1, disabled: 1, description: 1, mock: 1 } satisfies Record<AllKeys<McpElicitArgs>, 1>);

/**
 * Ask the MCP client's user for input mid-call, and bind their answer.
 *
 * Binds `{ action, content? }`: `"accept"` with `content` holding the answers,
 * `"decline"`, or `"cancel"`. Branch on `action` before using `content`.
 *
 * **The whole stack re-runs when the user answers.** The call pauses here, the
 * client collects the answer, then calls again — and the stack starts over from
 * the top, with this statement returning the answer. So everything BEFORE an
 * elicit runs once per round trip: ask first, then act. `export()` warns
 * (`mcp.write-before-elicit`) when a write precedes an elicit.
 *
 * Input is collected only from clients on MCP `2026-07-28` or later that declare
 * form elicitation. Everywhere else — an older client, a debug run, an agent,
 * a workflow test — it resolves to `{ action: "cancel" }` and the stack carries
 * on, so always handle `cancel`. It is a runtime error inside an async
 * function run.
 *
 * @example
 * s.mcp.elicit({
 *   key: "confirm_delete",
 *   message: "Delete these orders?",
 *   input: { confirm: input.bool({ required: true }), reason: input.text() },
 *   as: "answer",
 * }),
 * s.conditional({ when: expr(ref("answer.action"), "==", c.text("accept")), then: [...] }),
 */
export function mcpElicit<const As extends string = string, const Fs extends readonly FilterXdo[] = readonly []>(
  a: McpElicitArgs<As> & { asFilters?: Fs },
): Statement & AsShapeBrand<As, ApplyFilters<ElicitResult, Fs>> {
  a = argsOrEmpty(a);
  assertKnownKeys(`Statement "s.mcp.elicit"`, a, MCP_ELICIT_KEYS);
  const key = typeof a.key === "string" ? c.text(a.key) : a.key;
  const message = typeof a.message === "string" ? c.text(a.message) : a.message;
  assertValueArg("s.mcp.elicit", "key", key);
  if (key.tag === "const" && key.value === "") {
    throw new Error(`Statement "s.mcp.elicit": \`key\` is empty. Give each elicit a short stable name, unique in the stack.`);
  }
  assertValueArg("s.mcp.elicit", "message", message);
  const fields = a.input ?? {};
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new Error(
      `Statement "s.mcp.elicit": argument "input" must be a { field: input.*() } record — got ${describeArg(fields)}.`,
    );
  }
  const schema = Object.entries(fields).map(([name, d]) => {
    if (typeof d !== "object" || d === null || typeof (d as { type?: unknown }).type !== "string") {
      throw new Error(`Statement "s.mcp.elicit": \`input.${name}\` must be an input descriptor (\`input.text()\`, …) — got ${describeArg(d)}.`);
    }
    // Without `market_item`: a statement's context is validated when the stack
    // runs, and there a present `market_item` needs a non-empty `guid` — the blank
    // one a stored input field carries makes every call of this elicit fail with
    // "Missing param: guid". The platform writes form fields without it.
    const { market_item: _marketItem, ...field } = encodeInput(name, d) as InputXdo & { market_item?: unknown };
    return field as InputXdo;
  });
  for (const field of schema) assertFormField(field);
  return annotate(
    {
      name: "mvp:mcp_elicit",
      as: a.as ?? "",
      context: { schema },
      // Entry order is the engine's own: `key`, then `message`.
      input: [
        { name: "key", ...vf(key) },
        { name: "message", ...vf(message) },
      ],
    } as unknown as Statement & AsShapeBrand<As, ApplyFilters<ElicitResult, Fs>>,
    a,
  );
}

registerStatement("mvp:mcp_elicit", mcpElicit);

