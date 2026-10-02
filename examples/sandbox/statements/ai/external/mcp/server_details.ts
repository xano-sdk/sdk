/**
 * `s.ai.external.mcp.server_details` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const aiExternalMcpServerDetails = defineFunction({
  name: "ex_ai_external_mcp_server_details",
  stack: [
    s.ai.external.mcp.server_details({
      as: "result",
      url: c.text("https://mcp.example.com/sse"),
      connection_type: "sse",
    }),
  ],
  response: ref("result"),
});
