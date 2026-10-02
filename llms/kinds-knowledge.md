# Knowledge def shape

> Read when the workspace defines a `knowledge()` item for its AI agents.

- `knowledge({ name, description?, type?, mode?, enabled?, body, refs?, guid?, tags? })` — markdown Xano's own AI reads before it acts — the workspace's builder agent, and outside agents reading the workspace through the Meta API or MCP. It does NOT reach an `agent()` run by `s.ai.agent.run`, whatever its `type` or `mode`: put what such an agent must know in its `llm.systemPrompt`. Takes `registerKnowledge`.
  - `body` (REQUIRED): `knowledgeFile("./runbook.md", import.meta.url)` — a path to a real markdown FILE. There is no inline-string form. The path resolves relative to the MODULE THAT DECLARES the item, not the process working directory and not the workspace entry; `import.meta.url` is required and is what makes that true.
  - `refs?`: `knowledgeDir("./runbook", import.meta.url)` — a directory whose WHOLE tree ships, recursively, paths preserved: UTF-8 text only (else refused; binary `.DS_Store` skipped), symlinks not followed. Keep the body OUT of it, or it ships as a reference file.
  - `type?`: `"skill"` (default) | `"doc"` | `"agents.md"`. `skill` and `doc` differ in how they are filed, not in what an agent receives.
  - `mode?`: `"auto"` (default) | `"always"` | `"referenced"`.
  - `enabled?` defaults `true`. A disabled item is stored and never reaches an agent.

### What reaches the agent

- `type: "agents.md"` — full body on EVERY turn, whatever `mode` says. At most ONE per workspace; a second is an export error. Setting `mode` on one warns, because nothing reads it.
- `mode: "always"` — full body on every turn.
- `mode: "referenced"` — full body only on turns whose message names the item (bare name or `@name`).
- `mode: "auto"` — name and `description` only; the agent loads the body when a request matches.
- Reference files are never injected wholesale — an agent searches them on demand. That is what makes a large `mode: "auto"` item cheap.
- ⚠ `mode: "always"` on a long body spends its whole length on every request, and nothing in the types says so. `"auto"` is the default for that reason. For an `auto` item `description` is ALL the agent sees until it decides to load the body, so write it to be matched against a request rather than as a title.
- `name` takes letters, digits, and `/ _ - { } . ` or a space; anything else is an export error.
