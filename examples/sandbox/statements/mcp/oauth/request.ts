/**
 * `s.mcp.oauth.request` — the verified details of a pending MCP sign-in, for
 * your `oauth.loginUrl` page, which is the consent screen: `client_name`,
 * `client_logo`, `callback_host`, `client_verified` and `server_name`. Show at
 * least the client name and callback host before asking the user to approve.
 */
import { defineFunction, inp, input, ref, s } from "@xano/sdk";

export const mcpOauthRequest = defineFunction({
  name: "ex_mcp_oauth_request",
  input: { mcp_request: input.text({ required: true }) },
  stack: [s.mcp.oauth.request({ request: inp("mcp_request"), as: "sign_in" })],
  response: ref("sign_in"),
});
