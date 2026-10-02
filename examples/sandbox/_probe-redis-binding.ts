/**
 * `redis.set`'s result binding — runtime probe (NOT a shipped example, NOT
 * auto-indexed).
 *
 * The offline sources say the statement returns a bool and that the engine binds
 * `as` from the stack item's own member, for every statement alike. That answers
 * "can the binding exist" but not "does THIS statement populate it" — and for a
 * conditional write the difference is the whole feature, since the return value
 * is the only thing reporting whether the write happened.
 *
 * The endpoint claims one fresh key twice in a single request, then writes it
 * unconditionally as a control that separates "the binding is null" from "the
 * binding is false".
 *
 * MEASURED on a deployed ephemeral, 2026-08-20:
 *
 *   {"first":true,"second":false,"unconditional":true,"stored":"overwritten"}
 *
 * The binding resolves, and it reports the conditional write's actual outcome:
 * the first claim took the key, the second found it held. Re-run against a fresh
 * key — the point is a key nothing has written yet.
 *
 * Run:
 *   node dist/bin.js deploy examples/sandbox/_probe-redis-binding.ts --expires-hours 1
 *   curl "<url>/api:probe201/redis_binding?key=probe-$(date +%s)"
 */
import { workspace, apiGroup, query, s, c, ref, inp, input } from "@xano/sdk";

const defs = (xs: unknown[]) => xs as never[];

const api = apiGroup({ name: "probe201", canonical: "probe201" });

const redisBinding = query({
  name: "redis_binding",
  verb: "GET",
  apiGroup: api,
  input: { key: input.text({ required: true }) },
  stack: [
    // First claim on a key nothing has written: the write should happen.
    s.redis.set({
      as: "first",
      key: inp("key"),
      data: c.text("held"),
      ttl: c.int(60),
      create_only: c.bool(true),
    }),
    // Same key, same call: the write should NOT happen.
    s.redis.set({
      as: "second",
      key: inp("key"),
      data: c.text("held again"),
      ttl: c.int(60),
      create_only: c.bool(true),
    }),
    // The control. Without `create_only` the write is unconditional, so whatever
    // this reports is what the statement returns when it definitely wrote —
    // which separates "binding is null" from "binding is false".
    s.redis.set({ as: "unconditional", key: inp("key"), data: c.text("overwritten"), ttl: c.int(60) }),
    // Proves the first claim actually landed, not merely that a bool came back.
    s.redis.get({ as: "stored", key: inp("key") }),
  ],
  response: {
    first: ref("first"),
    second: ref("second"),
    unconditional: ref("unconditional"),
    stored: ref("stored"),
  },
});

export default workspace("xanosdk-probe-201")
  .registerApiGroups(defs([api]))
  .registerQueries(defs([redisBinding]));
