/**
 * `s.zip.delete_from_archive` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const zipDeleteFromArchive = defineFunction({
  name: "ex_zip_delete_from_archive",
  stack: [
    s.zip.delete_from_archive({ filename: c.text("example"), zip: c.text("example") }),
  ],
});
