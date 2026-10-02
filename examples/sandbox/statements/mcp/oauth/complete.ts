/**
 * `s.mcp.oauth.complete` — the hosted-mode MCP sign-in hand-off. The endpoint
 * your `oauth.loginUrl` page calls once the user has signed in: it signs in the
 * caller and binds the URL the page sends the browser to. `decision`
 * (`"approve"` or `"deny"`) is required: what the user chose on your page.
 */
import { defineFunction, inp, input, ref, s } from "@xano/sdk";

export const mcpOauthComplete = defineFunction({
  name: "ex_mcp_oauth_complete",
  input: { mcp_request: input.text({ required: true }) },
  stack: [s.mcp.oauth.complete({ request: inp("mcp_request"), decision: "approve", as: "continue_url" })],
  response: ref("continue_url"),
});
