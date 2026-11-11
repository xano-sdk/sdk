/**
 * `s.ai.speech.generate` — text to speech with a Xano AI model.
 *
 * REQUIRED: `text`. Optional: `voice` (any string; autocompletes the known
 * voices), `instructions` (how to say it: tone, pace), and `model`.
 *
 * ⚠ `save_to_files` `"public"`/`"private"` needs a paid plan. Left `""`, `.audio`
 * is a short-lived file resource: keep it with `s.storage.create_audio`.
 *
 * `location` blank inherits the workspace's Xano AI location.
 */
import { c, defineFunction, ref, s } from "@xano/sdk";

export const aiSpeechGenerate = defineFunction({
  name: "ex_ai_speech_generate",
  stack: [
    s.ai.speech.generate({
      as: "speech",
      model: "gemini-3.8-flash-tts",
      text: c.text("Your order has shipped."),
      voice: "Kore",
      instructions: c.text("Warm and brief."),
      save_to_files: "",
      location: "",
    }),
  ],
  response: ref("speech.audio"),
});
