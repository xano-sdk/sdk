/**
 * An INPUT named `run`, passed through a call. NOT a shipped example, NOT auto-indexed.
 *
 * MEASURED on a deployed ephemeral, 2026-09-25:
 *
 *   fn_obj   s.function.run, object inputs   {"a":"","b":"u2","whole_a":{"run_uuid":""},...}
 *   fn_text  s.function.run, text inputs     400 "Text filter requires ... value", param "run"
 *   fn_call  s.function.call, text inputs    400, same message, param "run"
 *   q_obj    POST body {run:{run_uuid:"u1"}}  {"a":"u1","b":"u2"}
 *   q_text   GET ?run=u1&run2=u2             {"a":"u1","b":"u2"}
 *
 * So the name is only lost through a call's input map; a request binds it. That
 * is the split `checkReservedInputNames` draws.
 *
 * Run (the guard warns on this file, so export without --strict):
 *   node dist/bin.js deploy examples/sandbox/_probe-480.ts --no-lock --expires-hours 1
 *   then GET api:probe480/fn_obj, /fn_text, /fn_call, /q_text?run=u1&run2=u2 and POST /q_obj
 */
import { workspace, defineFunction, query, apiGroup, input, f, obj, inp, ref, s, c } from "@xano/sdk";

const defs = (xs: unknown[]) => xs as never[];

const dbg = defineFunction({
  name: "dbg480",
  input: {
    run: input.object({ run_uuid: f.text() }),
    run2: input.object({ run_uuid: f.text() }),
  },
  response: obj({ a: inp("run.run_uuid"), b: inp("run2.run_uuid"), whole_a: inp("run"), whole_b: inp("run2") }),
});

const g = apiGroup({ name: "probe480", canonical: "probe480" });

const fnObj = query({
  name: "fn_obj",
  verb: "GET",
  apiGroup: g,
  stack: [s.function.run({ fn: dbg, input: { run: c.obj({ run_uuid: "u1" }), run2: c.obj({ run_uuid: "u2" }) }, as: "out" })],
  response: ref("out"),
});

const qObj = query({
  name: "q_obj",
  verb: "POST",
  apiGroup: g,
  input: {
    run: input.object({ run_uuid: f.text() }),
    run2: input.object({ run_uuid: f.text() }),
  },
  response: obj({ a: inp("run.run_uuid"), b: inp("run2.run_uuid") }),
});

const qText = query({
  name: "q_text",
  verb: "GET",
  apiGroup: g,
  input: { run: f.text(), run2: f.text() },
  response: obj({ a: inp("run"), b: inp("run2") }),
});

const dbgText = defineFunction({
  name: "dbg480_text",
  input: { run: f.text(), Run: f.text(), run_id: f.text(), run2: f.text() },
  response: obj({ run: inp("run"), Run: inp("Run"), run_id: inp("run_id"), run2: inp("run2") }),
});

const fnText = query({
  name: "fn_text",
  verb: "GET",
  apiGroup: g,
  stack: [s.function.run({ fn: dbgText, input: { run: c.text("a"), Run: c.text("b"), run_id: c.text("c"), run2: c.text("d") }, as: "out" })],
  response: ref("out"),
});

const fnCall = query({
  name: "fn_call",
  verb: "GET",
  apiGroup: g,
  stack: [s.function.call({ fn: dbgText, input: { run: c.text("a"), run2: c.text("d") }, as: "out" })],
  response: ref("out"),
});

export default workspace("xanosdk-probe-480")
  .registerFunctions(defs([dbg, dbgText]))
  .registerApiGroups(defs([g]))
  .registerQueries(defs([fnObj, qObj, qText, fnText, fnCall]));
