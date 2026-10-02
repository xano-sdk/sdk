/**
 * `s.redis.get` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const redisGet = defineFunction({
  name: "ex_redis_get",
  stack: [
    s.redis.get({ as: "result", key: c.text("••••") }),
  ],
  response: ref("result"),
});
