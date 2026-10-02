/**
 * `s.ai.agent.run({ agent, args?, allowToolExecution?, as? })` — run an AI agent
 * (an `agent({...})` toolset) inline.
 *
 * The `as` var (`reply`) is the rich result envelope; the model's completion is
 * at **`.result`**. Return `ref("reply.result")` to yield the text (a bare
 * `ref("reply")` returns the whole `{ result, finishReason, steps, … }` object).
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const aiAgentRun = defineFunction({
  name: "ex_ai_agent_run",
  stack: [
    s.ai.agent.run({
      agent: "ex_assistant",
      args: c.obj({ prompt: "summarize the latest posts" }),
      allowToolExecution: c.bool(true),
      as: "reply",
    }),
  ],
  response: ref("reply.result", { safe: true }),
});
