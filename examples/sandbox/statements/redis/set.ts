/**
 * `s.redis.set` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, expr, s } from "@xano/sdk";

export const redisSet = defineFunction({
  name: "ex_redis_set",
  stack: [
    s.redis.set({ key: c.text("••••"), data: c.text("example") }),
  ],
});

/**
 * A conditional write, and reading its answer.
 *
 * `create_only` writes only when the key is absent — the engine's SET NX. Use it
 * to claim a lock or a one-time slot rather than reading first and then writing,
 * which two callers can interleave. Because the write may not happen, `as` is
 * the only thing that reports whether it did: it binds `true` when this call took
 * the key and `false` when it was already held. Bind it and branch on it, or the
 * caller cannot tell a claim from a collision.
 */
export const redisSetClaimLock = defineFunction({
  name: "ex_redis_set_claim_lock",
  stack: [
    s.redis.set({
      as: "claimed",
      key: c.text("••••:lock"),
      data: c.text("held"),
      ttl: c.int(30),
      create_only: c.bool(true),
    }),
    s.conditional({
      when: expr(ref("claimed"), "===", c.bool(true)),
      then: [s.set_var("outcome", c.text("claimed"))],
      else: [s.set_var("outcome", c.text("held by someone else"))],
    }),
  ],
  response: ref("outcome"),
});
