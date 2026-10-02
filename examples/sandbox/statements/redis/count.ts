/**
 * `s.redis.count` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const redisCount = defineFunction({
  name: "ex_redis_count",
  stack: [
    s.redis.count({ as: "result", key: c.text("••••") }),
  ],
  response: ref("result"),
});
