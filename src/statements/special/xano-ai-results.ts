/**
 * What each Xano AI statement binds to its `as` variable.
 *
 * The statements themselves are generated; `s.ts` casts each factory to a
 * signature carrying one of these shapes, so `ref("out.text")` traces to
 * `string` instead of `unknown`. The casts change no bytes.
 */
import type { XanoFileRef, XanoFileUpload } from "../../fields/value-types.js";

/**
 * Token counts the model reported. Either key can be missing: a model that
 * reports no usage binds `{}`, so read `usage.input_tokens` as
 * `number | undefined`.
 */
export interface XanoAiUsage {
  input_tokens?: number;
  output_tokens?: number;
}

/**
 * A generated media file. With `save_to_files` off (the default) it is the file
 * resource itself: pass it to `s.storage.create_image` / `create_video` /
 * `create_audio` to keep it. With `save_to_files` `"public"` or `"private"` it is
 * already stored, and this is the stored file value those statements return,
 * ready for a file column.
 */
export type XanoAiMedia = XanoFileUpload | XanoFileRef;

/** `s.ai.text.generate`. */
export interface XanoAiTextResult {
  /** The model's reply. */
  text: string;
  /**
   * The reply parsed as JSON when `response_format` is `"json"` (the statement
   * throws if it does not parse), else `null`.
   */
  json: unknown;
  /** The model that answered. */
  model: string;
  /** Why the model stopped: `"stop"`, `"max_tokens"`, `"safety"`, ...; `null` when it gave no reason. */
  finish_reason: string | null;
  usage: XanoAiUsage;
}

/** `s.ai.image.generate`. */
export interface XanoAiImageResult {
  image: XanoAiMedia;
  /** Any text the model returned beside the image, else `""`. */
  text: string;
  model: string;
  usage: XanoAiUsage;
}

/** `s.ai.video.generate`. */
export interface XanoAiVideoResult {
  video: XanoAiMedia;
  model: string;
  /** The clip length in seconds. */
  duration: number;
}

/** `s.ai.speech.generate`. */
export interface XanoAiSpeechResult {
  audio: XanoAiMedia;
  model: string;
  usage: XanoAiUsage;
}

/** `s.ai.music.generate`. */
export interface XanoAiMusicResult {
  audio: XanoAiMedia;
  model: string;
  /** The clip's lyrics, or `null` when the model gives none (some models never do). */
  lyrics: string | null;
  /** The model's description of the clip, or `null` when it gives none. */
  description: string | null;
}

/** `s.ai.speech.transcribe`. */
export interface XanoAiTranscribeResult {
  /** The transcript, trimmed. */
  text: string;
  model: string;
  usage: XanoAiUsage;
}

/** `s.ai.embedding.create`. */
export interface XanoAiEmbeddingResult {
  /** One vector per input, in input order. A single text input still binds a list of one. */
  embeddings: number[][];
  model: string;
  usage: XanoAiUsage;
}

/** One ranked document of `s.ai.rerank`. */
export interface XanoAiRerankHit {
  /** The document's position in the `documents` you passed. */
  index: number;
  /** The document's `id`, or its index as a string when it had none. */
  id: string;
  /** Relevance to the query; higher is better. */
  score: number;
  /** The document's text. */
  content: string;
}

/** `s.ai.rerank`. */
export interface XanoAiRerankResult {
  /** Best first. `top_n` limits how many come back. */
  results: XanoAiRerankHit[];
  model: string;
}
