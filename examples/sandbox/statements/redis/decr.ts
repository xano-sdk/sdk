/**
 * `s.redis.decr` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const redisDecr = defineFunction({
  name: "ex_redis_decr",
  stack: [
    s.redis.decr({ as: "result", key: c.text("••••") }),
  ],
  response: ref("result"),
});
