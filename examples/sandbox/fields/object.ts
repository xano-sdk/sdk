/**
 * `f.object(children)` field type — a nested object column with typed children.
 */
import { table, f } from "@xano/sdk";

export const fieldObject = table({
  name: "ex_field_object",
  schema: {
    address: f.object({
      street: f.text(),
      city: f.text(),
      zip: f.text(),
    }),
  },
});
