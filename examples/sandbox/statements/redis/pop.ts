/**
 * `s.redis.pop` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const redisPop = defineFunction({
  name: "ex_redis_pop",
  stack: [
    s.redis.pop({ as: "result", key: c.text("••••") }),
  ],
  response: ref("result"),
});
