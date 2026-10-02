/**
 * `s.redis.unshift` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const redisUnshift = defineFunction({
  name: "ex_redis_unshift",
  stack: [
    s.redis.unshift({ as: "result", key: c.text("••••"), value: c.text("example") }),
  ],
  response: ref("result"),
});
