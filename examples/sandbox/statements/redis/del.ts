/**
 * `s.redis.del` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const redisDel = defineFunction({
  name: "ex_redis_del",
  stack: [
    s.redis.del({ key: c.text("••••") }),
  ],
});
