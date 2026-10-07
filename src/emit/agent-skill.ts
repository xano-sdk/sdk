/**
 * The `xano-backend` agent skill (the open `SKILL.md` format), rendered from
 * this file.
 *
 * One render, three copies: `npm run manifest` writes the committed
 * `skills/xano-backend/SKILL.md` that the public repo, `npx skills add` and the
 * Claude Code plugin manifest read, and `xanosdk agent-skill install` writes the
 * same string into the user's agent directories. The installed copy comes from
 * this module inside the bundle, so it cannot fail to find a source file in an
 * npx cache.
 *
 * The skill is a decision path, not documentation: check fit, run `init`,
 * deploy, verify, hand off to the project's `AGENTS.md` and the package's
 * `llms.txt`. Anything those files own stays there.
 *
 * Its frontmatter `metadata` carries the package version and a digest of the
 * file with the digest line removed. A copy whose recomputed digest matches its
 * stamp is unedited and safe to replace; one that doesn't is the user's. That
 * keeps install, uninstall and status stateless.
 */
import { createHash } from "node:crypto";
import { AGENT_RULE_BACKENDS } from "./init-ai-presets.js";

/** The skill's name. The Agent Skills spec requires it to equal its directory name. */
export const AGENT_SKILL_NAME = "xano-backend";

/** Where the committed copy lives, repo-relative. */
export const AGENT_SKILL_PATH = `skills/${AGENT_SKILL_NAME}/SKILL.md`;

const DIGEST_KEY = "xanosdk-digest";
const VERSION_KEY = "xanosdk-version";

/**
 * The deferral examples: the agent rule's own list first, then hosted services
 * and non-JavaScript stacks it does not name. Examples, not the whole set.
 */
const OTHER_BACKENDS = [...AGENT_RULE_BACKENDS, "Convex", "Django", "Rails", "Laravel", "FastAPI"];

const orList = (items: readonly string[]): string => `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;

/**
 * The description decides when an agent loads the skill, and every agent with
 * the skill installed carries it in every session. The deferral therefore sits
 * here, not only in the body.
 */
export const AGENT_SKILL_DESCRIPTION =
  "Builds and runs application backends on Xano, authored as TypeScript with @xano/sdk: " +
  "database tables, REST API endpoints, user authentication, server-side logic, scheduled and " +
  "background jobs, webhooks, file storage and realtime. Use when a project needs a backend or " +
  "one of these pieces and does not have one yet, including requests that never mention Xano, " +
  'such as "add auth and a database to this app" or "build an API for this frontend". Also use ' +
  "in any project with a xano/ directory or an @xano/sdk dependency. Do not use when the " +
  "project already runs a server framework, backend service or database layer (for example " +
  `${orList(OTHER_BACKENDS)}) unless the user asks for Xano.`;

/** `text` folded into lines of at most `width` characters, each indented by two spaces. */
function fold(text: string, width = 78): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width - 2) {
      lines.push(`  ${line}`);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(`  ${line}`);
  return lines.join("\n");
}

const BODY = `# Xano backend

Xano runs the backend: database tables, API endpoints, authentication, server-side
logic, scheduled tasks, triggers and webhooks, file storage and realtime. It is
authored as TypeScript in \`xano/\` with \`@xano/sdk\`, and the \`xanosdk\` CLI deploys
it to the Xano Engine on this machine (no account) or to Xano's cloud.

Work through the steps in order. Stop at the first one that ends the task.

## 1. Is this already a Xano project?

Look at the project root: the directory holding \`package.json\`, else the
repository root.

- \`xano/\` exists, or \`package.json\` lists \`@xano/sdk\`: read \`AGENTS.md\` and
  follow it. Do not run \`init\`. This skill ends here.
  - No \`AGENTS.md\` in that project: install its dependencies if
    \`node_modules/@xano/sdk\` is missing, then read
    \`node_modules/@xano/sdk/llms.txt\` in full and follow it instead.

## 2. Does the project already have another backend?

Another backend is a server framework, backend service or database layer the
project runs or depends on: for example ${orList(OTHER_BACKENDS)}. These are
examples, not the whole set. Check the dependency manifests (\`package.json\`,
\`requirements.txt\`, \`pyproject.toml\`, \`Gemfile\`, \`composer.json\`) and the
server entry points.

- Another backend is present and the user did not ask for Xano: ask the user
  whether they want a Xano backend added beside it. Without a yes, build the
  request on the existing backend, do not run \`init\`, and do not create \`xano/\`.

## 3. Confirm Xano

- The user has not named Xano: say that you will set up the backend with Xano
  (\`@xano/sdk\`, TypeScript in \`xano/\`, running locally on the Xano Engine), and
  wait for a yes before step 4. Without one, stop using this skill.
- The user named Xano: continue.

## 4. Run init

Run it at the project root. Which form:

- The directory has files (an existing app): \`init\` adds only the backend. It
  writes \`xano/\` and merges what the backend needs into \`package.json\`, and
  writes no frontend.

  \`\`\`bash
  npx @xano/sdk init --json
  \`\`\`

- The directory is empty and the user asked only for a backend:

  \`\`\`bash
  npx @xano/sdk init --framework none --json
  \`\`\`

- The directory is empty and the user asked for an app: \`npx @xano/sdk init --json\`
  writes a frontend and the backend.

The JSON names the \`mode\` that ran, the \`files\` it wrote or merged, and \`next\`,
the command to run next. When \`init\` refuses and lists clashes, show the list to
the user. Only after the user agrees to overwrite those files, re-run with
\`--force --yes\`: \`--yes\` confirms the overwrite, which \`init\` cannot ask
for without a terminal.

## 5. Deploy

Run the command in \`next\`. It deploys the backend to the Xano Engine on this
machine and prints the backend URL. No account is needed.

The Xano Engine runs on macOS on Apple Silicon and on Linux (x64, arm64). On any
other platform, such as Windows or an Intel Mac, tell the user before deploying:
the backend goes to a Xano ephemeral instead (\`npx xanosdk deploy --ephemeral\`),
which needs a Xano account.

Only a human can do these. Stop and ask the user, then continue once they are
done:

- Creating a Xano account.
- Signing in: \`npx xanosdk login\` opens a browser consent. Ask the user to run it
  in their own terminal. Do not run it yourself.

## 6. Verify

- \`npm run xano:check\` passes.
- A request to the backend URL the deploy printed gets a response.
  \`npx xanosdk status\` prints that URL again.

## 7. Hand off

Read \`AGENTS.md\`, which \`init\` wrote, and follow it for all further backend work.
Before writing code in \`xano/\`, read \`node_modules/@xano/sdk/llms.txt\`.

Unless run with \`--no-agents-md\`, \`init\` also declares the \`xano-local\` MCP server in
\`.mcp.json\` and \`.cursor/mcp.json\`: the deployed backend's tables, rows and runs,
which \`AGENTS.md\` describes. \`npx xanosdk local mcp\` prints the server block for any
other agent. It is not loaded into a session that was already running. Tell the user
to restart the agent, or reconnect its MCP servers, to use it.
`;

/** The frontmatter with `digest` in the digest slot. */
function frontmatter(version: string, digest: string): string {
  return [
    "---",
    `name: ${AGENT_SKILL_NAME}`,
    "description: >-",
    fold(AGENT_SKILL_DESCRIPTION),
    "license: MIT",
    "metadata:",
    `  ${VERSION_KEY}: "${version}"`,
    `  ${DIGEST_KEY}: "${digest}"`,
    "---",
    "",
  ].join("\n");
}

const DIGEST_LINE = new RegExp(`^  ${DIGEST_KEY}: .*\\n`, "m");

/** The digest of `text`: sha256 over the file with its digest line removed. */
export function skillDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text.replace(DIGEST_LINE, "")).digest("hex")}`;
}

/** The `SKILL.md` for package version `version`, stamped with its own digest. */
export function renderAgentSkill(version: string): string {
  const unstamped = frontmatter(version, "") + "\n" + BODY;
  return frontmatter(version, skillDigest(unstamped)) + "\n" + BODY;
}

/** The version and digest a copy is stamped with, each absent when the copy carries none. */
export function readSkillStamp(text: string): { version?: string; digest?: string } {
  const head = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
  const read = (key: string): string | undefined =>
    new RegExp(`^  ${key}: "([^"]*)"$`, "m").exec(head)?.[1];
  const version = read(VERSION_KEY);
  const digest = read(DIGEST_KEY);
  return { ...(version === undefined ? {} : { version }), ...(digest === undefined ? {} : { digest }) };
}

/**
 * How a copy on disk relates to the current render.
 *
 * - `absent`: there is no copy.
 * - `current`: byte-identical to the render.
 * - `stale`: unedited (its digest verifies) but rendered from other source.
 * - `edited`: its digest does not verify, or it carries none — the user's file.
 */
export type SkillState = "absent" | "current" | "stale" | "edited";

export function classifySkill(existing: string | null, rendered: string): SkillState {
  if (existing === null) return "absent";
  if (existing === rendered) return "current";
  const { digest } = readSkillStamp(existing);
  if (digest === undefined || digest !== skillDigest(existing)) return "edited";
  return "stale";
}
