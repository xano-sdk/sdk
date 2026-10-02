/**
 * `s.redis.incr` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const redisIncr = defineFunction({
  name: "ex_redis_incr",
  stack: [
    s.redis.incr({ as: "result", key: c.text("••••") }),
  ],
  response: ref("result"),
});
