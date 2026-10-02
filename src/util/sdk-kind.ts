/**
 * The SDK's own name for each bundle section whose stored key differs from it.
 *
 * A bundle's payload keys are the engine's storage names (`dbo`, `app`,
 * `workflow_test`), and a reader authored `table()`, `apiGroup()` and
 * `workflowTest()` — so anything the CLI prints about an object names its kind
 * the way the author wrote it. The stored spelling stays where it is part of a
 * file format (a `xano.lock` key is `dbo:users`), and input accepts both.
 *
 * `toolset` holds two kinds (an MCP server and an agent) that the key alone
 * cannot tell apart; a caller with the row in hand tells them apart by its
 * `type`, and one without prints the key as stored.
 */
export const SDK_KIND_BY_PAYLOAD_KEY: Readonly<Record<string, string>> = {
  dbo: "table",
  app: "apiGroup",
  workflow_test: "workflowTest",
  realtime_server: "realtimeServer",
  channel: "realtimeChannel",
  message: "realtimeMessage",
};

/** A trigger's stored `obj_type` → the factory that authors it (`toolset` is two, so it stays `trigger`). */
const TRIGGER_FACTORY: Readonly<Record<string, string>> = {
  database: "tableTrigger",
  workspace_realtime_channel: "realtimeTrigger",
  realtime_server: "realtimeServerTrigger",
  channel: "realtimeChannelTrigger",
  workspace: "workspaceTrigger",
  error: "errorTrigger",
};

/** The SDK kind name for a payload key (`dbo` → `table`); an unmapped key is returned as is. */
export function sdkKindName(payloadKey: string, row?: { type?: unknown; obj_type?: unknown }): string {
  if (payloadKey === "toolset" && row !== undefined) return row.type === "agent" ? "agent" : "mcpServer";
  // A trigger is authored through the factory for what it is attached to.
  if (payloadKey === "trigger" && typeof row?.obj_type === "string" && Object.hasOwn(TRIGGER_FACTORY, row.obj_type)) {
    return TRIGGER_FACTORY[row.obj_type]!;
  }
  return (Object.hasOwn(SDK_KIND_BY_PAYLOAD_KEY, payloadKey) ? SDK_KIND_BY_PAYLOAD_KEY[payloadKey] : undefined) ?? payloadKey;
}

/** SDK kind names accepted as input, resolved to the payload key they are stored under. */
export const PAYLOAD_KEY_BY_SDK_KIND: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(SDK_KIND_BY_PAYLOAD_KEY).map(([key, kind]) => [kind, key])),
  mcpServer: "toolset",
  agent: "toolset",
};
