/**
 * `s.redis.remove` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const redisRemove = defineFunction({
  name: "ex_redis_remove",
  stack: [
    s.redis.remove({ key: c.text("••••"), value: c.text("example") }),
  ],
});
