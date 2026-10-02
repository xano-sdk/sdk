/**
 * `defineFunction({...})` — a reusable server-side function (payload key
 * `function`). Function-like: typed `input`, a statement `stack`, and a
 * `response`.
 */
import { defineFunction, s, c, inp, ref, input } from "@xano/sdk";

export const addFunction = defineFunction({
  name: "ex_kind_function_add",
  input: { a: input.int({ required: true }), b: input.int({ required: true }) },
  stack: [
    s.set_var("sum", inp("a")),
    s.math.add({ name: "sum", value: inp("b") }),
    s.conditional({ when: { left: ref("sum"), op: ">", right: c.int(0) }, then: [] }),
  ],
  response: ref("sum"),
});
