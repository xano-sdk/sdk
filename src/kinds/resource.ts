/**
 * MCP resource (`resource`) — contents an MCP client can list and read by URI.
 * Its stack produces the contents `resources/read` returns.
 *
 * A resource is either STATIC (a literal `uri`, `docs://readme`) or a TEMPLATE
 * (`orders://{region}/{order_id}`), in which case each `{variable}` is one of
 * its `input` fields and a client reads a concrete URI (`orders://eu/42`).
 *
 * A resource is its own workspace object, like a `tool`. An `mcpServer()`
 * exposes it by listing it in `resources` — resources are an MCP server
 * feature, not an agent one.
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
import { assertResourceInput, encodeIcons, encodeResourceAnnotations, encodeTitle } from "./mcp-metadata.js";
import type { McpIcon, McpIconXdo, ResourceAnnotations, ResourceAnnotationsXdo } from "./mcp-metadata.js";

/** Same carriers as `ToolDef`, so `InferInput`/`InferResponse` work identically here. */
export interface ResourceDef<
  I extends Record<string, InputDescriptor> = Record<string, InputDescriptor>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  S extends readonly Statement[] = readonly Statement[],
> {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "resource";
  /** The resource's identity in the workspace. Clients address it by `uri`, not by name. */
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  /**
   * The address clients read. A literal (`docs://readme`) or an RFC 6570
   * level-1 template (`orders://{region}/{order_id}`): letters, digits and `_`
   * in each `{variable}`, one variable per brace pair, no two adjacent. It must
   * start with a scheme. Unique per MCP server.
   */
  uri: string;
  /** What the resource holds — shown to MCP clients in `resources/list`. */
  description?: string;
  docs?: string;
  /**
   * The contents' MIME type (`text/markdown`, `application/json`). Omit to let
   * the platform derive it from what the stack returns.
   */
  mimeType?: string;
  /** Human-readable display name MCP clients show instead of `name`. */
  title?: string;
  /** Icons MCP clients may show for this resource. See {@link McpIcon} for what `src` accepts. */
  icons?: McpIcon[];
  /** Audience, priority and last-modified hints for MCP clients. */
  annotations?: ResourceAnnotations;
  /** Accepted export warnings for this def ({@link DiagnosticsFor}). Never emitted. */
  diagnostics?: DiagnosticsFor<"resource">;
  tags?: string[];
  /**
   * Request-history capture. Omit to inherit (MCP server → workspace). A scalar:
   * `false` off, `true` on at default depth, a number = capture depth, `"all"`
   * unlimited. See {@link HistoryInput}.
   */
  history?: HistoryInput;
  /**
   * A template's variables — EXACTLY the `{variables}` in `uri`, each a single
   * `text`, `int`, `decimal`, `bool`, `enum`, `email` or `uuid`. A value that
   * does not convert is refused before the stack runs. An enum's values also
   * answer completion requests. A static resource takes no input.
   */
  input?: I;
  /** The statements that produce the contents. */
  stack?: S;
  /**
   * The contents. A string is returned as text. Anything that is not valid
   * UTF-8 text (a file, binary data) is returned base64-encoded as a blob.
   */
  response?: Resp;
  /**
   * Type-only: declare the response shape so `InferResponse<typeof resource>`
   * recovers it exactly. The runtime value is ignored.
   */
  responseShape?: Res;
  /**
   * Pre/post middleware for this resource. Providing a phase sets its
   * `_customize` flag. There is no workspace-wide resource middleware.
   */
  middleware?: MiddlewareAttach;
}

export interface ResourceXdo {
  name: string;
  uri: string;
  description: string;
  docs: string;
  mime_type: string;
  title?: string;
  icons?: McpIconXdo[];
  annotations?: ResourceAnnotationsXdo;
  input: InputXdo[];
  run: StackItemXdo[];
  result: ResultItemXdo[];
  middleware: MiddlewareBlock;
  tag: Array<{ tag: string }>;
  history: { inherit: boolean; enabled: boolean; limit: number };
}

/** Any resource def, whatever its inputs/stack/response. */
export type AnyResourceDef = ResourceDef<Record<string, InputDescriptor>, unknown>;

/** A MIME type: `type/subtype`, optionally with parameters (`text/plain; charset=utf-8`). */
const MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(\s*;.*)?$/;

export function encodeResource(def: AnyResourceDef): ResourceXdo {
  if (!def.name) throw new Error("resource: `name` is required.");
  const owner = `resource "${def.name}"`;
  assertStoredName(owner, def.name, "route");
  if (def.mimeType !== undefined && def.mimeType !== "" && !MIME_TYPE.test(def.mimeType)) {
    throw new Error(`${owner} \`mimeType\`: must be a MIME type such as text/markdown — got ${JSON.stringify(def.mimeType)}.`);
  }
  const input = Object.entries(def.input ?? {}).map(([name, d]) => encodeInput(name, d));
  assertResourceInput(owner, def.uri, input);
  const title = encodeTitle(owner, def.title);
  const icons = encodeIcons(owner, def.icons);
  const annotations = encodeResourceAnnotations(owner, def.annotations);
  return {
    name: def.name,
    uri: def.uri,
    description: def.description ?? "",
    docs: def.docs ?? "",
    mime_type: def.mimeType ?? "",
    // Omitted at their defaults, like a tool's.
    ...(title !== undefined ? { title } : {}),
    ...(icons !== undefined ? { icons } : {}),
    ...(annotations !== undefined ? { annotations } : {}),
    input,
    run: encodeStack("resource", def.name, def.stack),
    result: encodeResponse(def.response),
    middleware: buildMiddlewareBlock(def.middleware),
    tag: encodeTags(def.tags),
    history: encodeHistory("resource", def.history),
  };
}

export const resourceKind: ObjectKind<AnyResourceDef, ResourceXdo> = {
  name: "resource",
  payloadKey: "resource",
  encode: encodeResource,
};
registerKind(resourceKind);

/**
 * Author an MCP resource. List it in an `mcpServer({ resources: [...] })` to
 * expose it. The exact input map, stack tuple and response are preserved on the
 * return type.
 *
 * @example
 * const order = resource({
 *   name: "order",
 *   uri: "orders://{order_id}",
 *   mimeType: "application/json",
 *   input: { order_id: input.int({ required: true }) },
 *   stack: [s.db.get({ table: orders, field_name: "id", field_value: inp("order_id"), as: "order" })],
 *   response: ref("order"),
 * });
 */
export function resource<
  const I extends Record<string, InputDescriptor>,
  Res = never,
  Resp extends ResponseDef = ResponseDef,
  const S extends readonly Statement[] = readonly [],
>(def: ResourceDef<I, Res, Resp, S>): ResourceDef<I, Res, Resp, S> {
  return brandDef(def, "resource");
}
