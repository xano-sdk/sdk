/**
 * `s.ai.external.mcp.tool.list` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 *
 * `url` is REQUIRED — there is no default server to fall back to.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const aiExternalMcpToolList = defineFunction({
  name: "ex_ai_external_mcp_tool_list",
  stack: [
    s.ai.external.mcp.tool.list({
      as: "result",
      url: c.text("https://mcp.example.com/sse"),
      connection_type: "sse",
    }),
  ],
  response: ref("result"),
});
