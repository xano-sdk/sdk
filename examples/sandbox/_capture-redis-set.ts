/**
 * `redis.set` golden capture (NOT a shipped example, NOT auto-indexed).
 *
 * One statement, so the captured function's `run[0]` promotes straight to
 * `test/fixtures/statements/redis_set.json`. It carries the two members this
 * statement's authoring surface gained most recently — the result binding and
 * `create_only` — because a golden that omits them pins nothing about either.
 *
 * Run:
 *   node dist/bin.js validate examples/sandbox/_capture-redis-set.ts --capture --out validate-out
 */
import { workspace, defineFunction, s, c, ref } from "@xano/sdk";

const defs = (xs: unknown[]) => xs as never[];

const probeRedisSet = defineFunction({
  name: "ex_capture_redis_set",
  stack: [
    s.redis.set({
      as: "wrote",
      key: c.text("cap:lock"),
      data: c.text("held"),
      ttl: c.int(60),
      create_only: c.bool(true),
    }),
  ],
  response: ref("wrote"),
});

export default workspace("xanosdk-capture-redis-set").registerFunctions(defs([probeRedisSet]));
