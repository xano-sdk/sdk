/**
 * Closed-set string fields — what the engine STORES for a value outside the set.
 * NOT a shipped example, NOT auto-indexed.
 *
 * Each field is typed as a string union in the SDK, but a union is compile-time
 * only, so a runtime-built def can reach the encoder with anything. The
 * question this answers is what the ENGINE does with the value that arrives:
 * reject the object, keep the string, or accept the write and silently store
 * something else. The `as never` casts are the point — they put the probe on
 * the path a JS caller or a `tsc`-less CLI run takes.
 *
 * Each case has a control beside it in the same deploy, so a null is
 * distinguishable from "the field is just empty here".
 *
 * MEASURED on a deployed ephemeral, 2026-08-21. Every case deployed CLEAN —
 * no error, no warning, at export, import or rollout:
 *
 *   query control               verb "GET"   → "GET"       response_type "standard" → "standard"
 *   query lower_verb            verb "post"  → null
 *   query unknown_verb          verb "TRACE" → null
 *   query bad_response_type     response_type "streaming"  → null
 *   query stream_response_type  response_type "stream"     → "stream"
 *   apiGroup probe203_good      cors.mode "custom" → "custom"
 *   apiGroup probe203_mode      cors.mode "Custom" → THE WHOLE GROUP IS ABSENT
 *
 * So the three fields fail three ways and none of them is a rejection. A verb
 * outside the six is nulled, and a null verb serves as GET. A `response_type`
 * outside the two is nulled, and a null one buffers as "standard". A `cors.mode`
 * outside the three does not null the field — the ENTIRE api group is dropped
 * on import, so every query bound to it has no group to answer under.
 *
 * Run (against a build WITHOUT the closed-set guards — they refuse these defs):
 *   node dist/bin.js validate examples/sandbox/_probe-closed-set.ts --verbose
 *   node dist/bin.js deploy examples/sandbox/_probe-closed-set.ts --expires-hours 1
 *   node dist/bin.js ephemeral export <env>   # then read payload.app / payload.query
 */
import { workspace, apiGroup, query, c } from "@xano/sdk";

const defs = (xs: unknown[]) => xs as never[];

/** Control: every closed-set field in range. */
const good = apiGroup({
  name: "probe203_good",
  canonical: "probe203good",
  cors: { mode: "custom", allowOrigins: ["https://example.com"] },
});

/** `cors.mode` outside {default, custom, disabled} — wrong casing. */
const badMode = apiGroup({
  name: "probe203_mode",
  canonical: "probe203mode",
  cors: { mode: "Custom" as never, allowOrigins: ["https://example.com"] },
});

const control = query({
  name: "control",
  verb: "GET",
  apiGroup: good,
  responseType: "standard",
  response: c.text("control"),
});

/** Lowercase verb — the casing miss the issue was filed for. */
const lowerVerb = query({
  name: "lower_verb",
  verb: "post" as never,
  apiGroup: good,
  response: c.text("lower_verb"),
});

/** A real HTTP verb the engine does not carry. */
const unknownVerb = query({
  name: "unknown_verb",
  verb: "TRACE" as never,
  apiGroup: good,
  response: c.text("unknown_verb"),
});

/** `responseType` outside {standard, stream}. */
const badResponseType = query({
  name: "bad_response_type",
  verb: "GET",
  apiGroup: good,
  responseType: "streaming" as never,
  response: c.text("bad_response_type"),
});

/** Control for the one above: the non-default value, spelled correctly. */
const streamResponseType = query({
  name: "stream_response_type",
  verb: "GET",
  apiGroup: good,
  responseType: "stream",
  response: c.text("stream_response_type"),
});

export default workspace("xanosdk-probe-203")
  .registerApiGroups(defs([good, badMode]))
  .registerQueries(
    defs([control, lowerVerb, unknownVerb, badResponseType, streamResponseType]),
  );
