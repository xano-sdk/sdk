/**
 * An MCP server using every primitive the MCP spec gives it: tools with display
 * metadata, a prompt, a static resource, a resource template — plus the two
 * statements only an MCP stack uses, `s.mcp.elicit` and `s.mcp.progress`.
 *
 * Prompts and resources are their own workspace objects, registered like tools
 * (`registerPrompts` / `registerResources`) and exposed by listing them on the
 * server. They are an MCP server feature — an `agent()` takes tools only.
 */
import { mcpServer, mcpServerTrigger, prompt, resource, tool, hostedFile, s, c, ref, inp, expr, input, fl, env } from "@xano/sdk";
import { posts, users } from "../_shared.js";

/**
 * Gate 1 — a tool with the MCP metadata clients show: a `title`, behavior
 * `annotations` (hints — they never change what the tool does), `icons`, and an
 * `output` schema. The icon is a repo file: `hostedFile` ships it with every
 * deploy and each backend serves it at its own URL. With `output` set, the object the tool returns reaches the
 * client as `structuredContent` (plus a text copy), and a result that does not
 * match the schema is a tool error naming the failing field.
 */
export const countPostsTool = tool({
  name: "ex_kind_mcp_count_posts",
  title: "Count posts",
  description: "How many posts exist",
  annotations: { readOnlyHint: true, openWorldHint: false },
  icons: [{ src: hostedFile("./assets/count.png", import.meta.url), mimeType: "image/png", sizes: ["48x48"] }],
  stack: [s.db.query({ table: posts, as: "total", asFilters: [fl.count()] })],
  output: { total: input.int({ required: true }) },
  response: { total: ref("total") },
});

/**
 * Gate 2 — elicitation and progress. `s.mcp.elicit` asks the client's user
 * mid-call; the WHOLE stack re-runs from the top when they answer, so ASK
 * FIRST, then act — a write above the elicit would run once per round trip
 * (`export()` warns `mcp.write-before-elicit`). Clients older than MCP
 * `2026-07-28` get `{ action: "cancel" }`, so handle it. `s.mcp.progress`
 * reports progress to a client that asked for it and does nothing otherwise.
 */
export const archivePostTool = tool({
  name: "ex_kind_mcp_archive_post",
  title: "Archive a post",
  annotations: { destructiveHint: true, idempotentHint: true },
  input: { post_id: input.int({ required: true }) },
  stack: [
    s.mcp.elicit({
      key: "confirm_archive",
      message: "Archive this post?",
      input: { reason: input.text({ description: "Why it is being archived" }) },
      as: "answer",
    }),
    s.conditional({
      when: expr(ref("answer.action"), "==", c.text("accept")),
      then: [
        s.mcp.progress({ progress: c.int(50), total: c.int(100), message: c.text("Archiving") }),
        s.db.del({ table: posts, fieldValue: inp("post_id") }),
      ],
    }),
  ],
  response: ref("answer.action"),
});

/**
 * Gate 3 — a prompt. Its `input` is the prompt's arguments (an enum's values
 * also answer completion requests). A string response is one user message; a
 * list of `{ role, content }` is sent in order.
 */
export const summarizePrompt = prompt({
  name: "ex_kind_mcp_summarize",
  title: "Summarize a post",
  description: "Ask for a summary of one post",
  input: {
    post_id: input.int({ required: true, description: "The post to summarize" }),
    tone: input.enum(["neutral", "casual"], { description: "How the summary should read" }),
  },
  stack: [s.db.get({ table: posts, fieldValue: inp("post_id"), as: "post" })],
  response: ref("post.title"),
});

/** Gate 4 — a static resource: a literal `uri`, no input. */
export const readmeResource = resource({
  name: "ex_kind_mcp_readme",
  uri: "docs://readme",
  mimeType: "text/markdown",
  annotations: { audience: ["assistant"], priority: 0.8 },
  response: c.text("# Posts\n\nEvery post has a title."),
});

/**
 * Gate 5 — a resource template. Each `{variable}` in the `uri` is exactly one
 * `input` field (a single text/int/decimal/bool/enum/email/uuid); a client reads
 * a concrete URI (`posts://42`), and a value that does not convert is refused
 * before the stack runs.
 */
export const postResource = resource({
  name: "ex_kind_mcp_post",
  uri: "posts://{post_id}",
  title: "A post",
  mimeType: "application/json",
  input: { post_id: input.int({ required: true }) },
  stack: [s.db.get({ table: posts, fieldValue: inp("post_id"), as: "post" })],
  response: ref("post"),
});

/**
 * Gate 6 — the server. `tools`, `prompts` and `resources` each take handles, or
 * a `{ …, enabled?, auth? }` wrapper. `auth` names the auth table a client's
 * token must belong to — and is what gives the stack a caller.
 */
export const fullMcpServer = mcpServer({
  name: "ex_kind_mcp_full",
  canonical: "posts-mcp",
  instructions: "Read, summarize and archive posts.",
  tools: [countPostsTool, { tool: archivePostTool, auth: users }],
  prompts: [summarizePrompt],
  resources: [readmeResource, postResource],
});

/**
 * Gate 7 — the connection trigger. `t` carries the server's `tools`, `prompts`
 * and `resources`; the response decides what this connection lists. A key
 * returned filtered narrows that list (here: no resources), and a key left out
 * lists everything assigned. Omit `response` to pass all four through.
 */
export const fullMcpServerOnConnect = mcpServerTrigger({
  name: "ex_kind_mcp_full_on_connect",
  mcpServer: fullMcpServer,
  response: (t) => ({ toolset: t.toolset, tools: t.tools, prompts: t.prompts, resources: c.array([]) }),
});

/**
 * Gate 8 — per-server sign-in. With `oauth`, every MCP request needs an OAuth
 * access token and the signed-in `users` row is the caller on every tool,
 * prompt and resource (and `t.auth` in the connection trigger).
 *
 * Hosted mode: the platform is the authorization server and sends the client to
 * `loginUrl` — your page — with an `mcp_request` parameter. That page is also
 * the consent screen: it shows what `s.mcp.oauth.request` returns, signs the
 * user in, then calls an endpoint whose stack runs `s.mcp.oauth.complete` with
 * the user's `decision` and redirects to the URL it binds. `env("NAME")` keeps the URL per environment.
 * For tokens from your own identity provider, use
 * `{ mode: "external", authTable, issuer, column }` instead.
 */
export const signedInMcpServer = mcpServer({
  name: "ex_kind_mcp_signed_in",
  canonical: "posts-mcp-signed-in",
  tools: [countPostsTool],
  oauth: {
    mode: "hosted",
    authTable: users,
    loginUrl: env("MCP_LOGIN_URL"),
  },
});
