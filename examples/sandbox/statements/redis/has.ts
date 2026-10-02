/**
 * `s.redis.has` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const redisHas = defineFunction({
  name: "ex_redis_has",
  stack: [
    s.redis.has({ as: "result", key: c.text("••••") }),
  ],
  response: ref("result"),
});
