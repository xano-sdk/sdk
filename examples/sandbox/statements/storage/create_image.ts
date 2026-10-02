/**
 * `s.storage.create_image` — codegen'd declarative statement.
 * Generated from GENERATED_SPECS; edit freely to make it more illustrative.
 */
import { c, defineFunction, inp, input, ref, s } from "@xano/sdk";

/**
 * The upload → store → write flow, which is the only way a file reaches a column.
 *
 * `input.file()` is the raw upload: the request's bytes. It is NOT a stored file
 * resource, so it cannot be written to an `f.image()` column directly.
 * `s.storage.create_image` stores it and yields the resource that can be —
 * here bound to `img` and returned.
 *
 * Read the upload with `inp("upload")`. `ref("input.upload")` looks equivalent
 * and is not: `ref` spells a stack variable, so the engine looks for one named
 * `input` and fails the request with `Missing var entry: input`.
 *
 * ⚠ `access` defaults to `"public"`, so an omitted `access` publishes the file
 * at a guessable URL. An avatar is fine public; anything user-scoped is not.
 * Pass `access: "private"` and hand out a signed URL from
 * `s.storage.sign_private_url` instead. The value is a closed set, so a typo is
 * a compile error rather than a world-readable file.
 */
export const storageCreateImage = defineFunction({
  name: "ex_storage_create_image",
  input: { upload: input.file({ required: true }) },
  stack: [
    s.storage.create_image({
      as: "img",
      value: inp("upload"),
      filename: c.text("avatar.png"),
      access: "public", // stated rather than inherited — this one is a public avatar
    }),
  ],
  response: ref("img"),
});
