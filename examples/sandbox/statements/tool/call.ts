/**
 * `s.tool.call({ tool, input?, as? })` — invoke a tool as a workspace run.
 *
 * Pass the DEF, not a bare name. A bare name is resolved to a guid with no
 * registry visibility, so a typo exports cleanly and then fails the import with
 * `Invalid <kind> reference. Try importing: <guid>`.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";
import { searchTool } from "../../kinds/tool.js";

export const toolCall = defineFunction({
  name: "ex_tool_call",
  stack: [s.tool.call({ tool: searchTool, input: { query: c.text("xano") }, as: "hits" })],
  response: ref("hits"),
});
