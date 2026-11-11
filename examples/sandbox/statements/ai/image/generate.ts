/**
 * `s.ai.image.generate` — a Xano AI image model.
 *
 * REQUIRED: `prompt`. Optional: `images` (reference images to edit or draw
 * from), `aspect_ratio` and `image_size` (closed sets; not every model offers
 * every size — `npx @xano/sdk ai models --json` lists each model's options),
 * and `model` (any string, autocompletes the known models; leave it out for
 * the default).
 *
 * `save_to_files: ""` (the default) leaves `.image` a short-lived file
 * resource: pass it to `s.storage.create_image` to keep it. `"public"` or
 * `"private"` stores it in the workspace's files and binds the stored file
 * instead.
 *
 * `location` blank inherits the workspace's Xano AI location.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const aiImageGenerate = defineFunction({
  name: "ex_ai_image_generate",
  stack: [
    s.ai.image.generate({
      as: "art",
      model: "gemini-3.1-flash-image",
      prompt: c.text("A watercolor lighthouse at dawn"),
      aspect_ratio: "16:9",
      image_size: "1K",
      save_to_files: "private",
      location: "",
    }),
  ],
  // The stored file (save_to_files is set), plus any text the model returned.
  response: { image: ref("art.image"), caption: ref("art.text") },
});
