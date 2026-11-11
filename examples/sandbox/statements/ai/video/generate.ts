/**
 * `s.ai.video.generate` — a Xano AI video model.
 *
 * REQUIRED: `prompt`. Optional: `negative_prompt`, a starting `image` and a
 * `last_image` (file resources), `aspect_ratio`, `resolution`, `duration`
 * (seconds; each model takes a fixed set — `npx @xano/sdk ai models --json`),
 * `generate_audio`, `timeout` (seconds to wait), and `model`.
 *
 * ⚠ `save_to_files` `"public"`/`"private"` needs a paid plan. Left `""`, `.video`
 * is a short-lived file resource: keep it with `s.storage.create_video`.
 *
 * `location` blank inherits the workspace's Xano AI location.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const aiVideoGenerate = defineFunction({
  name: "ex_ai_video_generate",
  stack: [
    s.ai.video.generate({
      as: "clip",
      model: "veo-3.1-fast-generate-001",
      prompt: c.text("A paper boat drifting down a rainy street"),
      aspect_ratio: "16:9",
      resolution: "720p",
      duration: c.int(4),
      generate_audio: c.bool(false),
      save_to_files: "",
      location: "",
    }),
  ],
  // `.duration` is in SECONDS.
  response: { video: ref("clip.video"), seconds: ref("clip.duration") },
});
