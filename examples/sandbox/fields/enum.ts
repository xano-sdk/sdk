/**
 * `f.enum(values, opts?)` — a field constrained to a fixed set of values.
 *
 * Field types are demonstrated as columns on a `table()` (a field type isn't a
 * standalone object — it lives in a table schema). `values` is required and must
 * be non-empty; a `default` must be one of the values.
 */
import { table, f } from "@xano/sdk";

export const enumField = table({
  name: "ex_field_enum",
  schema: {
    status: f.enum(["draft", "published", "archived"], { default: "draft" }),
    priority: f.enum([1, 2, 3]), // numeric enums are allowed too
  },
});
