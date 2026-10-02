/**
 * `s.mcp.oauth.revoke` — end a user's hosted-mode MCP sign-ins on one server.
 * Pass exactly one of `user_id`, `grant_id` or `all`.
 */
import { c, defineFunction, inp, input, ref, s } from "@xano/sdk";

export const mcpOauthRevoke = defineFunction({
  name: "ex_mcp_oauth_revoke",
  input: { user_id: input.text({ required: true }) },
  stack: [s.mcp.oauth.revoke({ mcp_server: c.text("ex_kind_mcp_server"), user_id: inp("user_id"), as: "revoked" })],
  response: ref("revoked"),
});
