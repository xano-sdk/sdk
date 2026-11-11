/**
 * `s.ai.music.generate` — a Xano AI music model.
 *
 * REQUIRED: `prompt`. Optional: `negative_prompt` and `seed`, which only some
 * models take, and `model`. `npx @xano/sdk ai models --json` shows each model's
 * options (length, vocals, lyrics, negative_prompt, seed).
 *
 * ⚠ `save_to_files` `"public"`/`"private"` needs a paid plan. Left `""`, `.audio`
 * is a short-lived file resource: keep it with `s.storage.create_audio`.
 * `.lyrics` and `.description` are null from a model that returns none.
 *
 * `location` blank inherits the workspace's Xano AI location.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const aiMusicGenerate = defineFunction({
  name: "ex_ai_music_generate",
  stack: [
    s.ai.music.generate({
      as: "track",
      model: "lyria-002",
      prompt: c.text("Calm lo-fi piano for studying"),
      negative_prompt: c.text("drums"),
      seed: c.int(7),
      save_to_files: "",
      location: "",
    }),
  ],
  response: { audio: ref("track.audio"), lyrics: ref("track.lyrics") },
});
