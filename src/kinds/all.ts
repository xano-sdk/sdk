/**
 * Every object kind, and the one call that registers them all.
 *
 * Each kind module self-registers at load (`registerKind(...)`), but the
 * package is `sideEffects: false`, so a bare `import "./x.js"` is dropped from
 * a bundle and a build that reaches the registry without importing every kind
 * by name (the CLI's `compile`) would see only the ones it happened to import.
 * {@link registerAllKinds} names each kind object, so the bundler keeps them.
 */
import { registerKind, type ObjectKind } from "./kind.js";
import { functionKind } from "./function.js";
import { triggerKind } from "./trigger.js";
import { toolKind } from "./toolset.js";
import { promptKind } from "./prompt.js";
import { resourceKind } from "./resource.js";
import { mcpServerKind } from "./mcp-server.js";
import { agentKind } from "./agent.js";
import { tableKind } from "./table.js";
import { queryKind } from "./query.js";
import { apiGroupKind } from "./api-group.js";
import { taskKind } from "./task.js";
import { workflowTestKind } from "./workflow-test.js";
import { middlewareKind } from "./middleware.js";
import { addonKind } from "./addon.js";
import { microserviceKind } from "./microservice.js";
import { realtimeServerKind } from "./realtime-server.js";
import { realtimeChannelKind } from "./realtime-channel.js";
import { realtimeMessageKind } from "./realtime-message.js";
import { knowledgeKind } from "./knowledge.js";
import { workspaceKind } from "./workspace-config.js";

const ALL_KINDS: readonly ObjectKind[] = [
  functionKind,
  triggerKind,
  toolKind,
  promptKind,
  resourceKind,
  mcpServerKind,
  agentKind,
  tableKind,
  queryKind,
  apiGroupKind,
  taskKind,
  workflowTestKind,
  middlewareKind,
  addonKind,
  microserviceKind,
  realtimeServerKind,
  realtimeChannelKind,
  realtimeMessageKind,
  knowledgeKind,
  workspaceKind,
];

/** Register every object kind on this copy's registry. Idempotent. */
export function registerAllKinds(): void {
  for (const kind of ALL_KINDS) registerKind(kind);
}

registerAllKinds();
