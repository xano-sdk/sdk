/**
 * AI agent (`agent`) — a first-class root primitive: an LLM orchestrator that
 * runs a provider model over a set of tools. Persists as `obj_type=toolset` with
 * `type:"agent"` (shares the `toolset` payload section + `md5("toolset:"+name)`
 * guid with MCP servers).
 *
 * The value here over a verbatim `agent_settings` passthrough is a **typed,
 * ergonomic authoring surface that maps onto the engine's real stored shape**.
 * That shape was verified field-by-field against the Xano engine's stored agent
 * format, and it is decidedly *not* flat snake_case:
 *
 *   agent_settings = {
 *     type, system_prompt, max_steps, prompt_type, prompt, prompt_messages,  // top-level snake_case
 *     structuredOutputs, structuredOutputsSchema,                            // top-level CAMELCASE
 *     configs: { <provider>: { …camelCase keys… } },                        // provider config, CAMELCASE
 *   }
 *
 * So `encodeAgent` maps ergonomic authoring fields onto that exact shape:
 * top-level snake_case, the two structured-output keys camelCase, and the
 * provider config nested under `configs.<provider>` with the engine's camelCase
 * keys (`apiKey`, `sendReasoning`, `thinking.budgetTokens`, `useSearchGrounding`,
 * `reasoningEffort`, …). `xano-free` is a Google-GenAI wrapper minus
 * `apiKey`/`model`. Agents have **no** `instructions` field (the transform has
 * none) and no toolset-level middleware.
 *
 * The `agent_settings` wire shape is golden-verified: the openai provider config
 * (configs.openai camelCase keys, snake_case envelope) deep-equals the
 * engine-authored `test/fixtures/toolset/agent.json` golden (see agent.test.ts).
 * The surrounding object envelope (canonical/docs/middleware/history) carries
 * server-derived fields and stays field-asserted rather than deep-equaled.
 *
 * ## Templating: how run inputs reach the agent
 *
 * At run time Xano renders the agent's **string** settings through Twig
 * by the Xano engine *before* the LLM call, so config values
 * are dynamic per invocation. Two variable namespaces are exposed:
 *   - `$args` — the `args` object passed to `s.ai.agent.run({ args })` (the
 *     `mvp:call_agent` input). This is where an endpoint's inputs enter the agent.
 *   - `$env` — workspace environment variables.
 *
 * Write placeholders as `{{ $args.propertyName }}` / `{{ $env.NAME }}` (full
 * Twig: nesting `{{ $args.user.email }}`, indexing `{{ $args.items[0] }}`,
 * filters `{{ $args.q|upper }}`). Templated fields: `systemPrompt`, `prompt` /
 * `messages`, `model`, `maxSteps`, and every **string** provider-config field
 * (`apiKey`, `baseURL`, `headers`, `model`, `organization`, `project`,
 * `reasoningEffort`, …). Numeric/boolean fields (notably `temperature`) are
 * NOT templated — they're stored as typed literals. So an author references a
 * run input like:
 *
 * ```ts
 * agent({ name: "greeter", llm: {
 *   type: "xano-free",
 *   systemPrompt: "You greet {{ $args.name }} in {{ $args.locale }}.",
 * }});
 * // invoked via: s.ai.agent.run({ agent: greeter, args: obj({ name: inp("name"), locale: c.text("en") }) })
 * ```
 */
import { refuseUnknown } from "./def-keys.js";
import { registerKind } from "./kind.js";
import type { DiagnosticsFor } from "../workspace/diagnostics.js";
import type { ObjectKind } from "./kind.js";
import { encodeToolsetBase, resolveToolsetCanonical } from "./toolset.js";
import type { ToolsetBaseXdo, ToolsetToolEntry, ToolsetToolRef } from "./toolset.js";
import type { HistoryInput } from "./history.js";
import { encodeInput } from "../inputs/input.js";
import type { InputDescriptor } from "../inputs/input.js";
import type { InputXdo } from "../types/xdo.js";
import type { NoExtraKeys, RowFromFieldMap } from "../fields/value-types.js";
import { assertKnownKeys, nearestKey } from "../util/known-keys.js";
import { brandDef } from "./def-brand.js";

/** The LLM provider — the `agent_settings.type` value and the `configs` key. */
export type LlmProvider = "xano-free" | "openai" | "anthropic" | "google-genai";

/**
 * Fields common to every provider's LLM settings. String fields accept Twig
 * placeholders (`{{ $args.x }}` for run inputs, `{{ $env.X }}` for env vars) —
 * see the module header for the full templating contract.
 */
interface LlmCommon {
  /** The agent's system prompt (`agent_settings.system_prompt`). Templatable. */
  systemPrompt?: string;
  /** Max reasoning/tool steps (`agent_settings.max_steps`). Defaults to 5. */
  maxSteps?: number;
  /**
   * Forward-compat escape hatch: extra keys merged into `configs.<provider>`
   * last (for engine fields added after this typing). Prefer the typed fields.
   */
  extraConfig?: Record<string, unknown>;
}

/**
 * A numeric provider setting, as PERSISTED.
 *
 * These read as numbers and were declared `number`, but the editor's controls
 * are `json`-typed, so the corpus stores every one of them both ways —
 * `temperature` 12 times as an int and 18 as a string, `thinkingBudget` 12 and
 * 10, `thinking.budgetTokens` always as a string — with `""` the spelling an
 * untouched control leaves behind.
 *
 * The value round-trips verbatim either way (`normalize` already canonicalizes
 * the two numeric spellings to one), so all the narrower type bought was a
 * generated `temperature: ""` that would not compile.
 *
 * Widened rather than elided at `""`: dropping it would make the encoder write
 * the SDK default instead, and whether the engine reads a blank as that default
 * or as zero is a semantic claim nothing here can settle. Carrying the bytes
 * through unchanged needs no such claim.
 */
export type LlmNumber = number | string;

/** Anthropic provider settings → `configs.anthropic`. */
interface AnthropicProvider extends LlmCommon {
  type: "anthropic";
  apiKey?: string;
  model?: string;
  /** 0–1; outside it is refused at register. */
  temperature?: LlmNumber;
  /** Include reasoning in the response (stored `sendReasoning`). Defaults to true. */
  sendReasoning?: boolean;
  /** Extended-thinking token budget — presence enables `thinking` (`thinking.budgetTokens`). */
  thinkingTokens?: LlmNumber;
  baseURL?: string;
  headers?: string;
}

/** OpenAI provider settings → `configs.openai`. */
interface OpenAiProvider extends LlmCommon {
  type: "openai";
  apiKey?: string;
  model?: string;
  /** 0–2; outside it is refused at register. */
  temperature?: LlmNumber;
  /** `configs.openai.reasoningEffort` (e.g. "low" | "medium" | "high"). Defaults to "medium". */
  reasoningEffort?: string;
  baseURL?: string;
  headers?: string;
  organization?: string;
  project?: string;
  /** `configs.openai.compatibility` (e.g. "strict"). Defaults to "strict". */
  compatibility?: string;
}

/** Google GenAI provider settings → `configs.google-genai`. */
interface GoogleGenAiProvider extends LlmCommon {
  type: "google-genai";
  apiKey?: string;
  model?: string;
  /** 0–2; outside it is refused at register. */
  temperature?: LlmNumber;
  /** Stored `useSearchGrounding`. */
  searchGrounding?: boolean;
  /** Stored `thinkingConfig.thinkingBudget`. */
  thinkingBudget?: LlmNumber;
  /** Stored `thinkingConfig.includeThoughts`. */
  includeThoughts?: boolean;
  baseURL?: string;
  headers?: string;
  safetySettings?: string;
  /** Stored `dynamicRetrievalConfig` (note: the engine's XanoScript field is misspelled `dynamic_retrival`). */
  dynamicRetrieval?: string;
}

/** Xano Free provider settings → `configs.xano-free` (a Google-GenAI wrapper with no `apiKey`/`model`). */
interface XanoFreeProvider extends LlmCommon {
  type: "xano-free";
  /** 0–2; outside it is refused at register. */
  temperature?: LlmNumber;
  searchGrounding?: boolean;
  thinkingBudget?: LlmNumber;
  includeThoughts?: boolean;
  baseURL?: string;
  headers?: string;
  safetySettings?: string;
  dynamicRetrieval?: string;
}

/**
 * The run prompt, in exactly one of its two spellings.
 *
 * The engine stores ONE prompt behind a `prompt_type` discriminator: either a
 * `prompt` string or a `prompt_messages` template, never both. If authoring
 * both compiled, one would silently win — the other written as `""` into the
 * payload while the author kept believing their instruction was live. That is
 * the worst shape a settings object can have, because prompts are routinely
 * assembled from merged fragments where no human reads the result.
 *
 * A union rather than two optional keys, so the contradiction is a compile
 * error at the call site and not a runtime surprise. Neither key is also valid
 * — an agent whose run prompt comes entirely from `systemPrompt` plus its
 * inputs is a normal agent.
 */
export type LlmPrompt =
  | {
      /** A single prompt string (`prompt_type:"prompt"`). Templatable. Excludes `messages`. */
      prompt?: string;
      messages?: never;
    }
  | {
      /** A messages template (`prompt_type:"messages"`). Templatable. Excludes `prompt`. */
      messages?: string;
      prompt?: never;
    };

/**
 * Each provider's settings, carrying the prompt XOR. Intersected per provider
 * rather than only on the union so the exported per-provider types stay usable
 * on their own — `const llm: AnthropicLlm = { type: "anthropic", prompt: "…" }`
 * must still compile.
 */
export type AnthropicLlm = AnthropicProvider & LlmPrompt;
export type OpenAiLlm = OpenAiProvider & LlmPrompt;
export type GoogleGenAiLlm = GoogleGenAiProvider & LlmPrompt;
export type XanoFreeLlm = XanoFreeProvider & LlmPrompt;

/** Typed LLM settings, discriminated by provider `type`. */
export type LlmSettings = AnthropicLlm | OpenAiLlm | GoogleGenAiLlm | XanoFreeLlm;

/**
 * Structured-output authoring. `schema` is a record of named fields authored with
 * the `input.*` catalog — exactly like a `defineFunction`/`query` `input:` map. The
 * stored `structuredOutputsSchema` is the same wire shape as function inputs, so
 * `encodeInput` produces it verbatim (no parallel encoder). e.g.
 * `output: { schema: { priority: input.enum(["low","high"]), summary: input.text() } }`.
 * The item shape is byte-verified against a captured live-engine golden.
 */
export interface AgentOutput {
  schema: Record<string, InputDescriptor>;
  /** Whether structured output is enabled (`structuredOutputs`). Defaults to true. */
  enabled?: boolean;
}

/**
 * The `.result` completion type for a run of agent `A` — derived from its
 * declared `output.schema` when structured outputs are on, else `string`.
 *
 * `A` is whatever `s.ai.agent.run({ agent })` was handed: an {@link AgentHandle}
 * (or {@link AgentDef}) carries a precise, branded `output.schema`, so this reads
 * the shape the agent already declares once — no second `resultShape` witness at
 * the call site. A bare name/ref carries no schema → `string`.
 *
 * The schema is a *response* shape (the object the model returns), so every
 * declared field is treated as present — {@link RowFromFieldMap}, not the
 * request-payload `FromFieldMap` — with `nullable`/`array` still applied. An
 * explicit `enabled: false` disables structured outputs, so the result is
 * `string` again.
 */
export type AgentResultOf<A> = A extends { output?: infer O }
  ? O extends { schema: infer S; enabled?: infer E }
    ? [E] extends [false]
      ? string
      : // `agent()` captures the def under a `const` type param, so the schema
        // record is deeply `readonly`; strip it so `.result` reads as a plain
        // mutable object (matching `InferInput`'s `FromFieldMap`).
        { -readonly [K in keyof RowFromFieldMap<S, "input">]: RowFromFieldMap<S, "input">[K] }
    : string
  : string;

/**
 * Agent authoring def. Note: no `instructions`/`spec` — Xano's `Agent`
 * transform has neither.
 */
export interface AgentDef {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "agent";
  name: string;
  /** Explicit Xano `guid` (this object's identity). Defaults to a guid derived from `name`; set it to keep identity across a rename or to match an existing object. */
  guid?: string;
  description?: string;
  docs?: string;
  enabled?: boolean;
  canonical?: string;
  tags?: string[];
  /**
   * Request-history default for this agent's tools (the container tier — stored
   * `tool_enabled`/`tool_limit`). Omit to inherit from the workspace. A scalar:
   * `false` off, `true` on at default depth, a number = capture depth, `"all"`
   * unlimited. See {@link HistoryInput}.
   */
  history?: HistoryInput;
  /**
   * The tools this agent can call. Each entry is a bare `tool()` handle (or its
   * name), or a `{ tool, enabled?, auth? }` wrapper. See {@link ToolsetToolEntry}.
   */
  tools?: ToolsetToolEntry[];
  /** Accepted export warnings for this def ({@link DiagnosticsFor}). Never emitted. */
  diagnostics?: DiagnosticsFor<"agent">;
  /** The typed LLM settings (provider + model + generation config). */
  llm: LlmSettings;
  /** Optional structured output schema. */
  output?: AgentOutput;
}

/** The stored `agent_settings` block — the real engine shape (see module header). */
export interface AgentSettingsXdo {
  type: LlmProvider;
  system_prompt: string;
  max_steps: number;
  prompt_type: "prompt" | "messages";
  prompt: string;
  prompt_messages: string;
  structuredOutputs: boolean;
  structuredOutputsSchema: InputXdo[];
  configs: Record<string, Record<string, unknown>>;
}

export interface AgentXdo extends ToolsetBaseXdo {
  type: "agent";
  agent_settings: AgentSettingsXdo;
}

/** Build the `configs.<provider>` block with the engine's camelCase keys. */
function buildProviderConfig(llm: LlmSettings): Record<string, unknown> {
  let config: Record<string, unknown>;
  switch (llm.type) {
    case "anthropic":
      config = {
        apiKey: llm.apiKey ?? "",
        model: llm.model ?? "",
        temperature: llm.temperature ?? 1,
        sendReasoning: llm.sendReasoning ?? true,
        thinking:
          llm.thinkingTokens !== undefined
            ? { type: "enabled", budgetTokens: llm.thinkingTokens }
            : { type: "disabled", budgetTokens: "" },
        baseURL: llm.baseURL ?? "",
        headers: llm.headers ?? "",
      };
      break;
    case "openai":
      config = {
        apiKey: llm.apiKey ?? "",
        model: llm.model ?? "",
        temperature: llm.temperature ?? 1,
        reasoningEffort: llm.reasoningEffort ?? "medium",
        baseURL: llm.baseURL ?? "",
        headers: llm.headers ?? "",
        organization: llm.organization ?? "",
        project: llm.project ?? "",
        compatibility: llm.compatibility ?? "strict",
      };
      break;
    case "google-genai":
      config = {
        apiKey: llm.apiKey ?? "",
        model: llm.model ?? "",
        temperature: llm.temperature ?? 1,
        useSearchGrounding: llm.searchGrounding ?? false,
        thinkingConfig: {
          includeThoughts: llm.includeThoughts ?? false,
          thinkingBudget: llm.thinkingBudget ?? 0,
        },
        baseURL: llm.baseURL ?? "",
        headers: llm.headers ?? "",
        safetySettings: llm.safetySettings ?? "",
        dynamicRetrievalConfig: llm.dynamicRetrieval ?? "",
      };
      break;
    case "xano-free":
      // A Google-GenAI wrapper without apiKey/model.
      config = {
        temperature: llm.temperature ?? 1,
        useSearchGrounding: llm.searchGrounding ?? false,
        thinkingConfig: {
          includeThoughts: llm.includeThoughts ?? false,
          thinkingBudget: llm.thinkingBudget ?? 0,
        },
        baseURL: llm.baseURL ?? "",
        headers: llm.headers ?? "",
        safetySettings: llm.safetySettings ?? "",
        dynamicRetrievalConfig: llm.dynamicRetrieval ?? "",
      };
      break;
  }
  // Forward-compat escape hatch, merged last.
  return llm.extraConfig ? { ...config, ...llm.extraConfig } : config;
}

/** Each provider's own keys, beyond the ones every provider shares. */
const LLM_KEYS: Record<string, string[]> = {
  anthropic: ["sendReasoning", "thinkingTokens"],
  openai: ["reasoningEffort", "organization", "project", "compatibility"],
  "google-genai": ["searchGrounding", "thinkingBudget", "includeThoughts", "safetySettings", "dynamicRetrieval"],
  "xano-free": ["searchGrounding", "thinkingBudget", "includeThoughts", "safetySettings", "dynamicRetrieval"],
};

/** Map the typed authoring def onto the engine's stored `agent_settings`. */
/**
 * Build the stored `agent_settings` block from the two def fields that feed it.
 *
 * Takes just those fields rather than an `AgentDef` because `mcpServer` shares
 * it: both surfaces author ONE `mvp_toolset` row, so an MCP server can carry the
 * same block. One builder means the two cannot drift into two wire shapes.
 */
export function buildAgentSettings(
  def: { llm: LlmSettings; output?: AgentOutput },
  owner = "agent",
): AgentSettingsXdo {
  const llm = def.llm;
  const provider = Object.hasOwn(LLM_KEYS, llm.type) ? LLM_KEYS[llm.type] : undefined;
  // An unknown provider built no config at all — `model` and every setting
  // were dropped without a word. A blank type is what an engine agent that
  // never chose a provider stores, and carries through.
  if (!provider && (llm.type as string) !== "") {
    const types = Object.keys(LLM_KEYS);
    const near = typeof llm.type === "string" ? nearestKey(llm.type, types) : undefined;
    throw new Error(
      `${owner} llm: unknown provider type ${JSON.stringify(llm.type)}${near ? ` — did you mean "${near}"?` : "."} ` +
        `Expected one of: ${types.join(", ")}.`,
    );
  }
  if (provider) {
    assertKnownKeys(`${owner} llm (${llm.type})`, llm, [
      "type", "systemPrompt", "maxSteps", "extraConfig", "prompt", "messages",
      ...(llm.type === "xano-free" ? [] : ["apiKey", "model"]),
      "temperature", "baseURL", "headers", ...provider,
    ]);
  }
  // Numeric settings are stored as typed literals, not templated: a number, a
  // numeric string, or the `""` an untouched editor control leaves.
  for (const key of ["temperature", "thinkingTokens", "thinkingBudget"] as const) {
    const v = (llm as unknown as Record<string, unknown>)[key];
    if (v === undefined || v === "") continue;
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isFinite(n)) {
      // `String` for a number: JSON prints NaN and Infinity as `null`.
      throw new Error(
        `${owner} llm (${llm.type}): \`${key}\` must be a number — got ${typeof v === "number" ? String(v) : JSON.stringify(v)}.`,
      );
    }
    // The provider refuses a temperature outside its range on every run, so the
    // agent deploys and never answers.
    const max = llm.type === "anthropic" ? 1 : 2;
    if (key === "temperature" && (n < 0 || n > max)) {
      throw new Error(`${owner} llm (${llm.type}): \`temperature\` must be between 0 and ${max} for this provider — got ${n}.`);
    }
  }
  if (def.output !== undefined) {
    if (typeof def.output === "object" && def.output !== null) refuseUnknown(`${owner} \`output\``, def.output, ["schema", "enabled"]);
    const schema = (def.output as { schema?: unknown }).schema;
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error(
        `${owner} \`output\`: \`schema\` is required — a { field: input.*() } record, e.g. ` +
          "`output: { schema: { summary: input.text() } }`.",
      );
    }
  }
  // The type union already refuses both spellings; this is the same rule for a
  // JavaScript caller, a merged config object, or anything that reached here
  // through a cast. Silently dropping one of two prompts is the failure mode
  // that has to be impossible, not merely discouraged.
  if (llm.prompt !== undefined && llm.messages !== undefined) {
    throw new Error(
      `${owner} llm: \`prompt\` and \`messages\` are two spellings of ONE run prompt and cannot both ` +
        "be set — the engine stores a single `prompt_type`, so one of them would be dropped. " +
        "Keep `prompt` for a plain string, or `messages` for a messages template.",
    );
  }
  const promptType: "prompt" | "messages" = llm.messages !== undefined ? "messages" : "prompt";
  return {
    type: llm.type,
    system_prompt: llm.systemPrompt ?? "",
    max_steps: llm.maxSteps ?? 5,
    prompt_type: promptType,
    prompt: promptType === "prompt" ? (llm.prompt ?? "") : "",
    prompt_messages: promptType === "messages" ? (llm.messages ?? "") : "",
    structuredOutputs: def.output ? (def.output.enabled ?? true) : false,
    structuredOutputsSchema: def.output
      ? Object.entries(def.output.schema).map(([name, d]) => encodeInput(name, d))
      : [],
    configs: { [llm.type]: buildProviderConfig(llm) },
  };
}

export function encodeAgent(def: AgentDef): AgentXdo {
  if (!def.name) throw new Error("agent: `name` is required.");
  if (!def.llm) throw new Error(`agent "${def.name}": \`llm\` is required.`);
  return {
    ...encodeToolsetBase(def, "agent"),
    type: "agent",
    agent_settings: buildAgentSettings(def, `agent "${def.name}"`),
  };
}

export const agentKind: ObjectKind<AgentDef, AgentXdo> = {
  name: "agent",
  payloadKey: "toolset",
  encode: encodeAgent,
};
registerKind(agentKind);

/**
 * An `agent()` handle: the def plus a `getCanonical()` accessor. Unlike
 * {@link McpServerHandle} there is **no** `getUrl()`/`getPath()` — an agent has
 * no public HTTP endpoint (it is invoked in-stack via `s.ai.agent.run`, never
 * addressed by an external client). `getCanonical()` gives a pinned `canonical`
 * a client-side payoff without fabricating a URL. The accessor is dropped by
 * `JSON.stringify` and ignored by `encodeAgent`, so serialization is unaffected.
 */
export type AgentHandle<D extends AgentDef = AgentDef> = D & {
  /**
   * Type-only kind marker. `D` is the literal def, which never spells
   * `__kind`, so without restating it here the handle fit any register call
   * whose def type the literal happened to satisfy — `registerMcpServers([agent])`.
   */
  readonly __kind?: "agent";
  /**
   * The agent's resolved `canonical` token — from the def's `canonical` (or
   * `opts.canonical`, or the value frozen in `xano.lock` under `toolset:<name>`);
   * throws if none resolves.
   */
  getCanonical(opts?: { canonical?: string }): string;
};

/**
 * `llm` held to its provider's keys. `D` is inferred from the literal, so a typo
 * there (`system_prompt`, `maxStep`, `temprature`) widened `D` and was dropped.
 */
type AgentLlmKeys<D> = NoExtraKeys<D, AgentDef, Exclude<keyof AgentDef, "__kind">> &
  (D extends { llm: infer L extends { type: string } }
  ? {
      llm: NoExtraKeys<
        L,
        Extract<LlmSettings, { type: L["type"] }>,
        `systemPrompt | maxSteps | prompt | messages | extraConfig | ${L["type"] extends `${"a" | "e" | "i" | "o" | "u"}${string}` ? "an" : "a"} ${L["type"]} setting`
      >;
    }
  : unknown) &
  // Each `{ tool, … }` wrapper held to its keys: a misspelt `auth` was dropped,
  // shipping the tool with no caller.
  (D extends { tools: infer T extends readonly unknown[] }
    ? {
        tools: {
          [I in keyof T]: T[I] extends { tool: unknown } | { id: unknown }
            ? NoExtraKeys<T[I], ToolsetToolRef, Exclude<keyof ToolsetToolRef, symbol>>
            : unknown;
        };
      }
    : unknown) &
  (D extends { output: infer O } ? { output: NoExtraKeys<O, AgentOutput, "schema | enabled"> } : unknown);

/**
 * Author an AI agent — an LLM orchestrator over a set of tools. Returns an
 * {@link AgentHandle} (the def plus `getCanonical()`).
 *
 * Generic over the concrete def `D` so the handle preserves the exact,
 * branded `output.schema`. That lets `s.ai.agent.run({ agent })` read the
 * completion shape straight off the handle via {@link AgentResultOf} — the
 * structured-output type is declared once here, not re-stated as a `resultShape`
 * witness at every call site.
 */
export function agent<const D extends AgentDef>(def: D & AgentLlmKeys<D>): AgentHandle<D> {
  const getCanonical = (opts?: { canonical?: string }): string =>
    resolveToolsetCanonical(def, opts?.canonical);
  return brandDef({ ...def, getCanonical } as AgentHandle<D>, "agent");
}
