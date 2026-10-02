/**
 * MCP prompt (`prompt`) — a reusable prompt an MCP client lists and fills in.
 * Its `input` is the prompt's arguments, and its stack builds the messages the
 * client receives from `prompts/get`.
 *
 * A prompt is its own workspace object, like a `tool`. An `mcpServer()` exposes
 * it by listing it in `prompts` — prompts are an MCP server feature, not an
 * agent one.
 */
import type { DiagnosticsFor } from "../workspace/diagnostics.js";
import type { InputXdo, ResultItemXdo, StackItemXdo } from "../types/xdo.js";
import { encodeStack } from "../statements/statement.js";
import type { Statement } from "../statements/statement.js";
import { encodeResponse } from "../responses/response.js";
import type { ResponseDef } from "../responses/response.js";
import { encodeInput } from "../inputs/input.js";
import type { InputDescriptor } from "../inputs/input.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";
import type { MiddlewareBlock } from "./common.js";
import { encodeHistory } from "./history.js";
import type { HistoryInput } from "./history.js";
import { buildMiddlewareBlock } from "./middleware-attach.js";
import type { MiddlewareAttach } from "./middleware-attach.js";
import { assertStoredName } from "./stored-name.js";
import { brandDef } from "./def-brand.js";
import { encodeIcons, encodeTitle } from "./mcp-metadata.js";
import type { McpIcon, McpIconXdo } from "./mcp-metadata.js";

/**
 * Generic over its input map `I`, branded stack tuple `S`, literal response
 * `Resp`, and declared `Res` — the same carriers `ToolDef` holds, so
 * `InferInput`/`InferResponse` work identically here.
 */
export interface PromptDef<
  I extends Record<string, InputDescriptor> = Record<string, InputDescriptor>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  S extends readonly Statement[] = readonly Statement[],
> {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "prompt";
  /** The name MCP clients request the prompt by. Unique per workspace. */
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  /** What the prompt is for — shown to MCP clients in `prompts/list`. */
  description?: string;
  docs?: string;
  /** Human-readable display name MCP clients show instead of `name`. */
  title?: string;
  /** Icons MCP clients may show for this prompt. See {@link McpIcon} for what `src` accepts. */
  icons?: McpIcon[];
  /** Accepted export warnings for this def ({@link DiagnosticsFor}). Never emitted. */
  diagnostics?: DiagnosticsFor<"prompt">;
  tags?: string[];
  /**
   * Request-history capture. Omit to inherit (MCP server → workspace). A scalar:
   * `false` off, `true` on at default depth, a number = capture depth, `"all"`
   * unlimited. See {@link HistoryInput}.
   */
  history?: HistoryInput;
  /**
   * The prompt's arguments. Each field's `description`, `required` and enum
   * `values` are what MCP clients show; an enum's values also answer argument
   * completion requests.
   */
  input?: I;
  /** The statements that build the prompt's messages. */
  stack?: S;
  /**
   * The prompt's messages. A string becomes one `user` text message. A list of
   * `{ role: "user" | "assistant", content }` is sent in order, where `content`
   * is a string or an MCP content block. A prompt with no response fails every
   * `prompts/get`.
   */
  response?: Resp;
  /**
   * Type-only: declare the response shape so `InferResponse<typeof prompt>`
   * recovers it exactly. The runtime value is ignored.
   */
  responseShape?: Res;
  /**
   * Pre/post middleware for this prompt. Providing a phase sets its
   * `_customize` flag. There is no workspace-wide prompt middleware.
   */
  middleware?: MiddlewareAttach;
}

export interface PromptXdo {
  name: string;
  description: string;
  docs: string;
  title?: string;
  icons?: McpIconXdo[];
  input: InputXdo[];
  run: StackItemXdo[];
  result: ResultItemXdo[];
  middleware: MiddlewareBlock;
  tag: Array<{ tag: string }>;
  history: { inherit: boolean; enabled: boolean; limit: number };
}

/** Any prompt def, whatever its inputs/stack/response — see {@link AnyToolDef} for why `Res` is `unknown`. */
export type AnyPromptDef = PromptDef<Record<string, InputDescriptor>, unknown>;

export function encodePrompt(def: AnyPromptDef): PromptXdo {
  if (!def.name) throw new Error("prompt: `name` is required.");
  const owner = `prompt "${def.name}"`;
  assertStoredName(owner, def.name, "route");
  const title = encodeTitle(owner, def.title);
  const icons = encodeIcons(owner, def.icons);
  return {
    name: def.name,
    description: def.description ?? "",
    docs: def.docs ?? "",
    // Omitted at their defaults, like a tool's.
    ...(title !== undefined ? { title } : {}),
    ...(icons !== undefined ? { icons } : {}),
    input: Object.entries(def.input ?? {}).map(([name, d]) => encodeInput(name, d)),
    run: encodeStack("prompt", def.name, def.stack),
    result: encodeResponse(def.response),
    middleware: buildMiddlewareBlock(def.middleware),
    tag: encodeTags(def.tags),
    history: encodeHistory("prompt", def.history),
  };
}

export const promptKind: ObjectKind<AnyPromptDef, PromptXdo> = {
  name: "prompt",
  payloadKey: "prompt",
  encode: encodePrompt,
};
registerKind(promptKind);

/**
 * Author an MCP prompt. List it in an `mcpServer({ prompts: [...] })` to expose
 * it. The exact input map, stack tuple and response are preserved on the
 * return type.
 *
 * @example
 * const review = prompt({
 *   name: "code_review",
 *   title: "Code review",
 *   input: { code: input.text({ required: true }) },
 *   stack: [s.set_var("ask", withFilters(c.text("Review this code: "), fl.concat(inp("code"))))],
 *   response: ref("ask"), // a string: one user message
 * });
 */
export function prompt<
  const I extends Record<string, InputDescriptor>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  const S extends readonly Statement[] = readonly [],
>(def: PromptDef<I, Res, Resp, S>): PromptDef<I, Res, Resp, S> {
  return brandDef(def, "prompt");
}
