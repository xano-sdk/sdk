/**
 * `s.ai.speech.transcribe` — speech to text with a Xano AI model.
 *
 * REQUIRED: `audio`, a file resource (an `input.file()` upload, or one a
 * `s.storage.*` statement produced). Optional: `language` (a language code)
 * and `prompt`, which here is VOCABULARY, not an instruction: names and terms
 * to recognise, separated by commas or new lines.
 *
 * `model` takes any string; leave it out for the default. `location` blank
 * inherits the workspace's Xano AI location.
 */
import { c, defineFunction, inp, input, ref, s } from "@xano/sdk";

export const aiSpeechTranscribe = defineFunction({
  name: "ex_ai_speech_transcribe",
  input: { recording: input.file({ required: true }) },
  stack: [
    s.ai.speech.transcribe({
      as: "transcript",
      model: "gemini-3.5-transcribe",
      audio: inp("recording"),
      language: c.text("en"),
      prompt: c.text("Xano, XanoScript"),
      location: "",
    }),
  ],
  response: ref("transcript.text"),
});
