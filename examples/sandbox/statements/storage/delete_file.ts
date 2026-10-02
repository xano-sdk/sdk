/**
 * `s.storage.delete_file` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, s } from "@xano/sdk";

export const storageDeleteFile = defineFunction({
  name: "ex_storage_delete_file",
  stack: [
    s.storage.delete_file({ pathname: c.text("example") }),
  ],
});
