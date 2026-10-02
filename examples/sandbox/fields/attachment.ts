/**
 * `f.attachment` field type — shown as a column on a table (a field type lives in a
 * table schema, it is not a standalone object).
 */
import { table, f } from "@xano/sdk";

export const fieldAttachment = table({
  name: "ex_field_attachment",
  schema: {
    primary: f.attachment(),
  },
});
