/**
 * `tool({...})` — a function-like operation a toolset (MCP server / AI agent)
 * exposes (payload key `tool`).
 */
import { tool, s, ref, input } from "@xano/sdk";
import { posts } from "../_shared.js";

export const searchTool = tool({
  name: "ex_kind_search_tool",
  description: "Search posts by title",
  input: { query: input.text({ required: true }) },
  stack: [s.db.query({ table: posts, as: "rows" })],
  response: ref("rows"),
});
