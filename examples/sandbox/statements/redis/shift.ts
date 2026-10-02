/**
 * `s.redis.shift` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const redisShift = defineFunction({
  name: "ex_redis_shift",
  stack: [
    s.redis.shift({ as: "result", key: c.text("••••") }),
  ],
  response: ref("result"),
});
