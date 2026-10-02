/**
 * `f.uuid` field type — shown as a column on a table (a field type lives in a
 * table schema, it is not a standalone object).
 */
import { table, f } from "@xano/sdk";

export const fieldUuid = table({
  name: "ex_field_uuid",
  schema: {
    primary: f.uuid(),
  },
});
