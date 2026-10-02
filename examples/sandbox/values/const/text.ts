/**
 * `c.text(...)` — a constant text value (c.text → tagged constant).
 */
import { defineFunction, s, c, ref } from "@xano/sdk";

export const constText = defineFunction({
  name: "ex_value_const_text",
  stack: [s.set_var("v", c.text("hello world"))],
  response: ref("v"),
});
