/**
 * Capture harness (NOT a shipped example, NOT auto-indexed).
 *
 * A curated subset of the sandbox — one object per authored KIND plus the deps
 * each needs — used as the `xanosdk preflight --capture` input to source real
 * engine goldens for the per-kind byte-verify corpus.
 *
 * It reuses the maintained `kinds/` example objects verbatim rather than
 * re-authoring shapes, but omits the 600 auto-generated field/statement/filter
 * examples that make the full `index.ts` import too fragile to capture against.
 *
 * Run:  node dist/bin.js validate examples/sandbox/_capture.ts --capture --out validate-out
 */
import { workspace, query, workflowTest, s, c, inp, input, ref } from "@xano/sdk";
import { api, users, posts, doubleFn } from "./_shared.js";
import { fieldTableRef } from "./fields/tableRef.js";
import { productTable } from "./kinds/table.js";
import { getUserQuery } from "./kinds/query.js";
import { onUserInsert, onMessage, onBranchLive } from "./kinds/trigger.js";
import { searchTool } from "./kinds/tool.js";
import { exampleMcpServer, assistant, askAssistant } from "./kinds/ai.js";
import { nightlyCleanup } from "./kinds/task.js";
import { doubleFnTest } from "./kinds/workflowTest.js";
import { rateLimit } from "./kinds/middleware.js";
import { authorAddon } from "./kinds/addon.js";
import { houseRules, deployRunbook } from "./kinds/knowledge.js";
import { echoService, helmService } from "./kinds/microservice.js";
import {
  microserviceRequest,
  microserviceRequestPort,
  microserviceRequestInstanceHost,
} from "./statements/microservice/request.js";
import {
  chatServer,
  lobbyChannel,
  roomChannel,
  sendMessage,
  typingMessage,
  onChatConnect,
  onRoomJoin,
  onRoomDeliver,
} from "./kinds/realtime.js";

// A query with a CUSTOMIZED (inherit:false) request-history block — the golden
// source for byte-verifying authored history (the shipped examples all inherit).
const historyQuery = query({
  // Addressed in the PATH, like every by-one-row read — see `getUserQuery`.
  name: "ex_history_query/{id}",
  verb: "GET",
  apiGroup: api,
  history: 100,
  input: { id: input.int({ required: true }) },
  stack: [s.db.get({ table: users, fieldValue: inp("id"), as: "user" })],
  response: ref("user"),
});

// A workflow test whose stack references NOTHING. The shipped example calls a
// function, and a `.call` stores its target's guid — which only matches a golden
// when the SDK's own bundle was the thing deployed. This one is capture-only so
// the kind's ENVELOPE (active/datasource/docs/tag/run) can be byte-verified on
// its own; statement fidelity is the statement corpus's job. Same reason
// `historyQuery` above is defined here rather than reused from `kinds/`.
const workflowTestGolden = workflowTest({
  name: "ex_kind_workflow_test",
  description: "asserts a computed value",
  tags: ["smoke", "release"],
  stack: [
    s.set_var("doubled", c.int(42)),
    s.expect.to_be_defined({ expr: ref("doubled") }),
    s.expect.to_equal({ expr: ref("doubled"), value: c.int(42) }),
  ],
});

// register* buckets are typed per kind; the examples span many kinds.
const defs = (xs: unknown[]) => xs as never[];

export default workspace("xanosdk-capture-kinds")
  .registerApiGroups(defs([api]))
  .registerTables(defs([users, posts, productTable, fieldTableRef]))
  .registerQueries(defs([getUserQuery, askAssistant, historyQuery]))
  .registerTriggers(defs([onUserInsert, onMessage, onBranchLive, onChatConnect, onRoomJoin, onRoomDeliver]))
  .registerTools(defs([searchTool]))
  .registerMcpServers(defs([exampleMcpServer]))
  .registerAgents(defs([assistant]))
  .registerFunctions(defs([doubleFn, microserviceRequest, microserviceRequestPort, microserviceRequestInstanceHost]))
  .registerTasks(defs([nightlyCleanup]))
  .registerWorkflowTests(defs([doubleFnTest, workflowTestGolden]))
  .registerMiddleware(defs([rateLimit]))
  .registerAddons(defs([authorAddon]))
  .registerKnowledge(defs([houseRules, deployRunbook]))
  .registerMicroservices(defs([echoService, helmService]))
  .registerRealtimeServers(defs([chatServer]))
  .registerRealtimeChannels(defs([lobbyChannel, roomChannel]))
  .registerRealtimeMessages(defs([sendMessage, typingMessage]));
