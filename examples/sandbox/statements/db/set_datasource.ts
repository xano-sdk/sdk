/**
 * `s.db.set_datasource` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const dbSetDatasource = defineFunction({
  name: "ex_db_set_datasource",
  stack: [
    s.db.set_datasource({ value: c.text("example") }),
  ],
});
