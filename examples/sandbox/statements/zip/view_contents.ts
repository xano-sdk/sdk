/**
 * `s.zip.view_contents` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const zipViewContents = defineFunction({
  name: "ex_zip_view_contents",
  stack: [
    s.zip.view_contents({ as: "result", zip: c.text("example") }),
  ],
  response: ref("result"),
});
