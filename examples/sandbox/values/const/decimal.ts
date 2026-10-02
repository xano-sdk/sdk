/**
 * `c.decimal(...)` — a constant decimal value (c.decimal → tagged constant).
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const constDecimal = defineFunction({
  name: "ex_value_const_decimal",
  stack: [s.set_var("v", c.decimal(3.14))],
  response: ref("v"),
});
