/**
 * `inp(name)` — reference a function/endpoint input.
 */
import { defineFunction, s, inp, ref, input } from "@xano/sdk";

export const valueInp = defineFunction({
  name: "ex_value_inp",
  input: { name: input.text({ required: true }) },
  stack: [s.set_var("greeting", inp("name"))],
  response: ref("greeting"),
});
