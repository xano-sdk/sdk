/**
 * `s.zip.add_to_archive` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const zipAddToArchive = defineFunction({
  name: "ex_zip_add_to_archive",
  stack: [
    s.zip.add_to_archive({ file: c.text("example"), filename: c.text("example"), zip: c.text("example") }),
  ],
});
