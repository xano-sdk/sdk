/**
 * `s.redis.range` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const redisRange = defineFunction({
  name: "ex_redis_range",
  stack: [
    s.redis.range({ as: "result", key: c.text("••••") }),
  ],
  response: ref("result"),
});
