/**
 * `s.redis.push` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const redisPush = defineFunction({
  name: "ex_redis_push",
  stack: [
    s.redis.push({ as: "result", key: c.text("••••"), value: c.text("example") }),
  ],
  response: ref("result"),
});
