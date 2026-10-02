/**
 * Capture harness (NOT a shipped example, NOT auto-indexed).
 *
 * Minimal workspace with one realtime trigger whose stack is a single
 * `s.realtime.get_session` statement — the golden source for byte-verifying that
 * statement's persisted encoding. Run:
 *   node dist/bin.js validate examples/sandbox/_rt-getsession.ts --capture --out validate-out
 */
import { workspace, realtimeTrigger, s } from "@xano/sdk";

const onSession = realtimeTrigger({
  name: "ex_rt_get_session",
  actions: { message: true },
  stack: () => [s.realtime.get_session({ as: "session" })],
  response: (t) => t.payload,
});

const defs = (xs: unknown[]) => xs as never[];

export default workspace("xanosdk-capture-getsession").registerTriggers(defs([onSession]));
