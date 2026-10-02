/**
 * `s.ai.external.mcp.tool.run` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 *
 * `url` and `tool` are REQUIRED — there is no default server to fall back to,
 * and `tool` names the tool to invoke. It is authored as `tool` and stored as
 * `tool_name`; both are forwarded whole to the MCP service, so an absent one
 * asks a remote server for a tool called nothing rather than failing locally.
 *
 * `bearer_token` is genuinely optional — a server that needs no credential is a
 * normal case, and every stored instance in the survey corpus leaves it empty.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const aiExternalMcpToolRun = defineFunction({
  name: "ex_ai_external_mcp_tool_run",
  stack: [
    s.ai.external.mcp.tool.run({
      as: "result",
      url: c.text("https://mcp.example.com/sse"),
      connection_type: "sse",
      tool: c.text("search_docs"),
    }),
  ],
  response: ref("result"),
});
