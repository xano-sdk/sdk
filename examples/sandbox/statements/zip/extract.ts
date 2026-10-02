/**
 * `s.zip.extract` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const zipExtract = defineFunction({
  name: "ex_zip_extract",
  stack: [
    s.zip.extract({ as: "result", zip: c.text("example") }),
  ],
  response: ref("result"),
});
