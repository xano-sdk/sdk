/**
 * `s.ai.text.generate` — a Xano AI text model.
 *
 * REQUIRED: `prompt` OR `messages`. Neither is required on its own, but a call
 * with a blank prompt and no messages fails the request; `messages` is a list
 * of `{ role: "user" | "assistant", content }` turns, and `prompt` (if also set)
 * is added as the last user turn.
 *
 * Optional: `model` takes any string and autocompletes the known models; leave
 * it out to run the default. `npx @xano/sdk ai models --json` lists the current
 * models, what each allows (files, `temperature_max`) and where it can run.
 * `response_format: "json"` parses the reply into `.json`, constrained by
 * `json_schema` when one is given (the call throws if the reply does not parse).
 *
 * `location` blank inherits the workspace's Xano AI location; a set one must be
 * among the model's `locations`, or the call is refused before it is sent.
 */
import { c, defineFunction, inp, input, ref, s } from "@xano/sdk";

/** Gate 1 — the smallest call: a prompt, the default model, the inherited location. */
export const aiTextGenerate = defineFunction({
  name: "ex_ai_text_generate",
  input: { question: input.text({ required: true }) },
  stack: [
    s.ai.text.generate({
      as: "reply",
      prompt: inp("question"),
      response_format: "text",
      location: "",
    }),
  ],
  // `.text` is the reply; `.model`, `.finish_reason` and `.usage` sit beside it.
  response: ref("reply.text"),
});

/** Gate 2 — a conversation in `messages`, a named model, and a JSON reply shaped by a schema. */
export const aiTextGenerateJson = defineFunction({
  name: "ex_ai_text_generate_json",
  stack: [
    s.ai.text.generate({
      as: "triage",
      model: "gemini-3.8-flash",
      system: c.text("Classify support tickets."),
      messages: c.array([
        { role: "user", content: "My invoice shows the wrong amount." },
      ]),
      response_format: "json",
      json_schema: c.obj({
        type: "object",
        properties: { category: { type: "string" }, urgent: { type: "boolean" } },
        required: ["category", "urgent"],
      }),
      temperature: c.decimal(0.2),
      max_tokens: c.int(256),
    }),
  ],
  // `.json` is the parsed reply (null unless response_format is "json").
  response: ref("triage.json"),
});
