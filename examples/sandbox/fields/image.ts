/**
 * `f.image` field type — shown as a column on a table (a field type lives in a
 * table schema, it is not a standalone object). A seeded row takes a repo file
 * through `hostedFile`: it ships with the deploy and the row stores that
 * backend's copy (read it with `fileUrl(row.primary, XANO_HOST)`).
 */
import { table, f, hostedFile } from "@xano/sdk";

export const fieldImage = table({
  name: "ex_field_image",
  schema: {
    primary: f.image(),
  },
  seed: [{ primary: hostedFile("./assets/logo.png", import.meta.url) }],
});
