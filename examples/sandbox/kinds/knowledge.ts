/**
 * `knowledge({...})` — the markdown Xano's own AI (the builder agent, and agents
 * reading the workspace over the Meta API or MCP) reads before it acts. It never
 * reaches an `agent()` run by `s.ai.agent.run` — that agent's standing
 * instructions go in its `llm.systemPrompt`.
 *
 * Two items, showing the two shapes worth knowing:
 *
 * - `ex_kind_agents_md` is `type: "agents.md"` — standing instructions injected
 *   in FULL on every turn, whatever `mode` says. At most one per workspace, so
 *   keep it short: its whole length is on every request.
 * - `ex_kind_deploy_runbook` is a `skill` at the default `mode: "auto"`. The
 *   agent sees only its name and description until a request matches, then loads
 *   the body — which is why a long skill is cheap and why the description is
 *   written to be MATCHED against a request rather than read as a title.
 *
 * Both bodies are real `.md` files beside this module, not template literals:
 * prose belongs in a file your editor, your linter, and a diff can all read.
 * `refs` ships a whole folder the agent searches on demand.
 */
import { knowledge, knowledgeFile, knowledgeDir } from "@xano/sdk";

export const houseRules = knowledge({
  name: "ex_kind_agents_md",
  description: "Standing instructions for every agent in this workspace.",
  type: "agents.md",
  body: knowledgeFile("./knowledge/agents.md", import.meta.url),
});

export const deployRunbook = knowledge({
  name: "ex_kind_deploy_runbook",
  description:
    "How this workspace ships: environments, deploy gates, and how to roll back a bad release.",
  type: "skill",
  mode: "auto",
  body: knowledgeFile("./knowledge/skills/deploy_runbook/SKILL.md", import.meta.url),
  refs: knowledgeDir("./knowledge/skills/deploy_runbook/refs", import.meta.url),
});
