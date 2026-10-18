/**
 * `s.array.group_by` — groups the items by a key expression.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const arrayGroupBy = defineFunction({
  name: "ex_array_group_by",
  stack: [
    s.array.group_by({ as: "result", expr: c.array([{ team: "red", n: 1 }, { team: "blue", n: 2 }, { team: "red", n: 3 }]), by: c.expression("$this.team") }),
  ],
  response: ref("result"),
});
