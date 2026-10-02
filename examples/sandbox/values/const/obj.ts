/**
 * `c.obj(...)` — a constant obj value (c.obj → tagged constant).
 * Plain JSON literals only — a nested tagged value (inp/ref/auth/c.*) is
 * rejected; for a computed object use a record of values, not c.obj.
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const constObj = defineFunction({
  name: "ex_value_const_obj",
  stack: [s.set_var("v", c.obj({ name: "Ada", age: 36 }))],
  response: ref("v"),
});
