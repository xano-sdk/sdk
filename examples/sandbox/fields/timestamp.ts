/**
 * `f.timestamp` field type — shown as a column on a table (a field type lives in a
 * table schema, it is not a standalone object).
 */
import { table, f } from "@xano/sdk";

export const fieldTimestamp = table({
  name: "ex_field_timestamp",
  schema: {
    primary: f.timestamp({ default: "now" }),
  },
});
