/**
 * `s.redis.keys` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const redisKeys = defineFunction({
  name: "ex_redis_keys",
  stack: [
    s.redis.keys({ as: "result", search: c.text("example") }),
  ],
  response: ref("result"),
});
