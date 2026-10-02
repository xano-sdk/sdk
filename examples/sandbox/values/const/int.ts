/**
 * `c.int(...)` — a constant int value (c.int → tagged constant).
 *
 * Pass a string (or bigint) for an integer past `Number.MAX_SAFE_INTEGER`: the
 * number literal for `9223372036854775807` has already rounded. A `number` that
 * is not a safe integer throws rather than encoding the rounded value. The
 * engine's integers are signed 64-bit; past that range the export warns.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const constInt = defineFunction({
  name: "ex_value_const_int",
  stack: [s.set_var("v", c.int(42)), s.set_var("big", c.int("9223372036854775807"))],
  response: ref("v"),
});
