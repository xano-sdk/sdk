/**
 * `s.storage.read_file_resource` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const storageReadFileResource = defineFunction({
  name: "ex_storage_read_file_resource",
  stack: [
    s.storage.read_file_resource({ as: "result", value: c.text("example") }),
  ],
  response: ref("result"),
});
