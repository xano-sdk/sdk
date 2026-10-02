/**
 * The implementation-examples sandbox — one deployable Xano workspace that
 * registers every example so the whole set type-checks and `export()`s.
 *
 * The statement / value / filter / field examples are collected automatically
 * (see `_auto.ts`, regenerated with `npm run examples:index`). The object-kind
 * examples in `kinds/` are hand-wired below, since each is a different kind with
 * its own `register*` bucket.
 */
import { workspace } from "@xano/sdk";
import { api, users, posts, doubleFn } from "./_shared.js";
import { autoTables, autoQueries, autoFunctions } from "./_auto.js";

// --- object-kind examples (kinds/) ---
import { addFunction } from "./kinds/function.js";
import { productTable, productNoteTable, accessoryTable, auditTable, demoLoginTable } from "./kinds/table.js";
import { browserApi, publicApi } from "./kinds/apiGroup.js";
import {
  getUserQuery,
  userPostQuery,
  listItemsQuery,
  createItemQuery,
} from "./kinds/query.js";
import { onUserInsert, onMessage, onBranchLive } from "./kinds/trigger.js";
import { searchTool } from "./kinds/tool.js";
import { valueToolset } from "./values/toolset.js";
import { exampleMcpServer, assistant, classifier, askAssistant, classifyTicket } from "./kinds/ai.js";
import {
  countPostsTool,
  archivePostTool,
  summarizePrompt,
  readmeResource,
  postResource,
  fullMcpServer,
  signedInMcpServer,
} from "./kinds/mcp.js";
import { nightlyCleanup } from "./kinds/task.js";
import { doubleFnTest } from "./kinds/workflowTest.js";
import { scoreQuery } from "./kinds/unitTest.js";
// The `Run …` statement examples. Hand-wired rather than collected by `_auto`
// because each one must register as a WORKFLOW TEST — its statement only runs
// inside one — and the barrel's shape rule would file them as functions.
import { apiCallTest, apiCallAuthedTest } from "./statements/api/call.js";
import { taskCallTest } from "./statements/task/call.js";
import { triggerCallTest } from "./statements/trigger/call.js";
import { workflowTestCallTest } from "./statements/workflow_test/call.js";
// The `s.expect.*` assertion examples — workflow tests for the same reason:
// an assertion outside one raises and takes the host request down with it.
import { expectToBeDefined } from "./statements/expect/to_be_defined.js";
import { expectToBeEmpty } from "./statements/expect/to_be_empty.js";
import { expectToBeFalse } from "./statements/expect/to_be_false.js";
import { expectToBeGreaterThan } from "./statements/expect/to_be_greater_than.js";
import { expectToBeInTheFuture } from "./statements/expect/to_be_in_the_future.js";
import { expectToBeInThePast } from "./statements/expect/to_be_in_the_past.js";
import { expectToBeLessThan } from "./statements/expect/to_be_less_than.js";
import { expectToBeNull } from "./statements/expect/to_be_null.js";
import { expectToBeTrue } from "./statements/expect/to_be_true.js";
import { expectToBeWithin } from "./statements/expect/to_be_within.js";
import { expectToContain } from "./statements/expect/to_contain.js";
import { expectToEndWith } from "./statements/expect/to_end_with.js";
import { expectToEqual } from "./statements/expect/to_equal.js";
import { expectToMatch } from "./statements/expect/to_match.js";
import { expectToNotBeDefined } from "./statements/expect/to_not_be_defined.js";
import { expectToNotBeNull } from "./statements/expect/to_not_be_null.js";
import { expectToNotEqual } from "./statements/expect/to_not_equal.js";
import { expectToStartWith } from "./statements/expect/to_start_with.js";
import { expectToThrow, expectToThrowMessage } from "./statements/expect/to_throw.js";
import { rateLimit, publicRateLimit } from "./kinds/middleware.js";
import { authorAddon } from "./kinds/addon.js";
import { houseRules, deployRunbook } from "./kinds/knowledge.js";
import { wsConfig } from "./kinds/workspaceConfig.js";
import { echoService, helmService } from "./kinds/microservice.js";
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

// The examples span many def-object kinds; register* buckets are typed per kind.
const defs = (xs: unknown[]) => xs as never[];

export default workspace("xanosdk-examples")
  .registerWorkspace(wsConfig)
  .registerApiGroups(defs([api, publicApi, browserApi]))
  .registerTables(defs([users, posts, productTable, productNoteTable, accessoryTable, auditTable, demoLoginTable, ...autoTables]))
  .registerFunctions(defs([doubleFn, addFunction, ...autoFunctions]))
  .registerQueries(defs([getUserQuery, userPostQuery, listItemsQuery, createItemQuery, scoreQuery, askAssistant, classifyTicket, ...autoQueries]))
  .registerTriggers(defs([onUserInsert, onMessage, onBranchLive, onChatConnect, onRoomJoin, onRoomDeliver]))
  .registerTools(defs([searchTool, valueToolset, countPostsTool, archivePostTool]))
  .registerPrompts(defs([summarizePrompt]))
  .registerResources(defs([readmeResource, postResource]))
  .registerMcpServers(defs([exampleMcpServer, fullMcpServer, signedInMcpServer]))
  .registerAgents(defs([assistant, classifier]))
  .registerTasks(defs([nightlyCleanup]))
  .registerWorkflowTests(defs([
    doubleFnTest,
    apiCallTest,
    apiCallAuthedTest,
    taskCallTest,
    triggerCallTest,
    workflowTestCallTest,
    expectToBeDefined,
    expectToBeEmpty,
    expectToBeFalse,
    expectToBeGreaterThan,
    expectToBeInTheFuture,
    expectToBeInThePast,
    expectToBeLessThan,
    expectToBeNull,
    expectToBeTrue,
    expectToBeWithin,
    expectToContain,
    expectToEndWith,
    expectToEqual,
    expectToMatch,
    expectToNotBeDefined,
    expectToNotBeNull,
    expectToNotEqual,
    expectToStartWith,
    expectToThrow,
    expectToThrowMessage,
  ]))
  .registerMiddleware(defs([rateLimit, publicRateLimit]))
  .registerMicroservices(defs([echoService, helmService]))
  .registerAddons(defs([authorAddon]))
  .registerKnowledge(defs([houseRules, deployRunbook]))
  .registerRealtimeServers(defs([chatServer]))
  .registerRealtimeChannels(defs([lobbyChannel, roomChannel]))
  .registerRealtimeMessages(defs([sendMessage, typingMessage]));
