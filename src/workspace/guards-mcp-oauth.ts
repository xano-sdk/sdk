/**
 * Export-time checks for an MCP server's `oauth` block and the
 * `s.mcp.oauth.revoke` statement: the rules the platform applies when it saves
 * or runs them, raised as ERRORs that name the object instead of a refused push.
 */
import { MCP_OAUTH_PRESETS_WITHOUT_AUD, MCP_OAUTH_STABLE_CLAIMS } from "../kinds/mcp-oauth.js";
import { sdkKindName } from "../util/sdk-kind.js";
import type { DiagnosticBag } from "./diagnostics.js";
import { walkNodes } from "./guards.js";

/**
 * An MCP server's `oauth` block, against the rules the platform applies when it
 * saves one — each an ERROR, because the push is refused anyway; this names the
 * server and the fix instead.
 *
 * - `mcp.oauth-hosted-incomplete` — hosted mode with no `loginUrl`.
 * - `mcp.oauth-external-incomplete` — external mode without an `issuer` or a
 *   `column` (the platform cannot verify a token, or cannot find its row).
 * - `mcp.oauth-preset-client-ids` — a preset whose tokens carry no audience
 *   (Clerk) without `allowedClientIds`: any client's token would pass.
 * - `mcp.oauth-claim-unacked` — a mapping claim other than `sub`/`oid`/`email`
 *   without `claimAck`: users can edit most other claims at their provider, and
 *   with them which row they sign in as.
 *
 * Reads the stored shape, so a pulled workspace is checked the same way.
 */
export function checkMcpOauth(sections: Readonly<Record<string, unknown[] | undefined>>, bag: DiagnosticBag): void {
  for (const set of sections.toolset ?? []) {
    if (!set || typeof set !== "object") continue;
    const { name, oauth } = set as { name?: unknown; oauth?: unknown };
    if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) continue;
    const o = oauth as Record<string, unknown>;
    const server = `mcpServer "${String(name ?? "?")}"`;
    const text = (k: string): string => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
    if (o.mode === "hosted" && text("login_url") === "") {
      bag.error(
        "mcp.oauth-hosted-incomplete",
        `${server}: \`oauth\` is hosted mode with no \`loginUrl\`. A client signing in is sent to that page, so ` +
          `the platform refuses the push without one. Set \`loginUrl\` to your login page (https), or \`env("NAME")\`.`,
        set,
      );
    }
    if (o.mode !== "external") continue;
    const missing = ["issuer", "column"].filter((k) => text(k) === "");
    if (missing.length > 0) {
      bag.error(
        "mcp.oauth-external-incomplete",
        `${server}: \`oauth\` is external mode with no ${missing.map((k) => `\`${k}\``).join(" or ")}. The ` +
          `\`issuer\` is what a token is verified against and the \`column\` is the auth-table column its claim ` +
          `names a row by; the platform refuses the push without both.`,
        set,
      );
    }
    const preset = text("preset");
    const clientIds = Array.isArray(o.allowed_client_ids) ? o.allowed_client_ids : [];
    if (MCP_OAUTH_PRESETS_WITHOUT_AUD.includes(preset) && clientIds.length === 0) {
      bag.error(
        "mcp.oauth-preset-client-ids",
        `${server}: \`oauth.preset\` "${preset}" issues access tokens without an audience, so nothing ties a token ` +
          `to this server. Set \`allowedClientIds\` to the client ids allowed to call it; the platform refuses the ` +
          `push without them.`,
        set,
      );
    }
    const claim = typeof o.claim === "string" && o.claim !== "" ? o.claim : "sub";
    if (!MCP_OAUTH_STABLE_CLAIMS.includes(claim) && o.claim_ack !== true) {
      bag.error(
        "mcp.oauth-claim-unacked",
        `${server}: \`oauth.claim\` "${claim}" can be edited by users at many identity providers, which would let ` +
          `a user choose the row they sign in as. Use "sub", "oid" or "email", or set \`claimAck: true\` to accept ` +
          `it; the platform refuses the push otherwise.`,
        set,
      );
    }
  }
}

/**
 * A revoke selector whose literal value the platform reads as unset: it counts
 * a target by value, so `user_id: ""`, `grant_id: 0` and `all: false` select
 * nothing. A reference is never judged here — its value is only known at run time.
 */
function isEmptyRevokeTarget(input: { name?: unknown; tag?: unknown; value?: unknown }): boolean {
  if (typeof input?.tag !== "string" || !input.tag.startsWith("const")) return false;
  const value = String(input.value ?? "");
  if (input.name === "user_id") return value === "";
  if (input.name === "grant_id") return value === "" || Number(value) <= 0;
  if (input.name === "all") return value === "" || value === "false" || value === "0";
  return false;
}

/**
 * `s.mcp.oauth.revoke` takes EXACTLY ONE of `user_id`, `grant_id` or `all`; the
 * platform refuses any other combination every time the statement runs. An
 * ERROR, naming the object, instead of a failure at the first call.
 */
export function checkMcpOauthRevoke(sections: Readonly<Record<string, unknown[] | undefined>>, bag: DiagnosticBag): void {
  for (const [payloadKey, arr] of Object.entries(sections)) {
    for (const obj of arr ?? []) {
      if (!obj || typeof obj !== "object") continue;
      walkNodes(obj, (node) => {
        if (node.name !== "mvp:mcp_oauth_revoke" || !Array.isArray(node.input)) return;
        const targets = (node.input as Array<{ name?: unknown; tag?: unknown; value?: unknown }>)
          .filter((i) => !isEmptyRevokeTarget(i))
          .map((i) => i?.name)
          .filter((n): n is string => n === "user_id" || n === "grant_id" || n === "all");
        if (targets.length === 1) return;
        const name = (obj as { name?: unknown }).name;
        const owner = `${sdkKindName(payloadKey, obj as { type?: unknown })} "${typeof name === "string" ? name : "?"}"`;
        bag.error(
          "mcp.oauth-revoke-target",
          `${owner}: \`s.mcp.oauth.revoke\` needs exactly one of \`user_id\`, \`grant_id\` or \`all\`, but it names ` +
            `${targets.length === 0 ? "no target" : targets.map((t) => `\`${t}\``).join(" and ")} — the platform refuses ` +
            `any other combination every time the statement runs.`,
          obj,
        );
      });
    }
  }
}
