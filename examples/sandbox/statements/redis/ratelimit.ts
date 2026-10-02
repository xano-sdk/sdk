/**
 * `s.redis.ratelimit` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const redisRatelimit = defineFunction({
  name: "ex_redis_ratelimit",
  stack: [
    s.redis.ratelimit({ as: "result", key: c.text("••••"), max: c.int(10), ttl: c.int(60), error: c.text("Too many requests.") }),
  ],
  response: ref("result"),
});
