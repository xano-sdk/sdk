/**
 * `f.text` field type — shown as a column on a table (a field type lives in a
 * table schema, it is not a standalone object).
 */
import { table, f } from "@xano/sdk";

export const fieldText = table({
  name: "ex_field_text",
  schema: {
    primary: f.text({ required: true }),
    title: f.text({ format: "markdown" }),
  },
});
