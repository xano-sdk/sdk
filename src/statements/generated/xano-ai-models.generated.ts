// AUTO-GENERATED from xano-ai-catalog.snapshot.json by scripts/ai-catalog-snapshot.ts — DO NOT EDIT BY HAND.
// Refresh with `npm run codegen:ai-catalog`; `npm run codegen` re-renders it from the committed snapshot.
/**
 * Suggested values for the Xano AI fields that take any text: `model` on
 * every `s.ai.*` gateway statement and `voice` on `s.ai.speech.generate`.
 * The factories type those fields as these literals, any other string, or a
 * `Value`, so autocomplete offers the known models and a model released after
 * this snapshot still compiles. Retired (unlisted) models are left out.
 *
 * Snapshot taken 2026-11-11T00:06:05.822Z.
 */

/** The listed Xano AI `text` models, as the snapshot recorded them. Suggestions, not a closed set. */
export const XANO_AI_TEXT_MODELS = [
  "gemini-3.8-flash",
  "gemini-4-argon",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
] as const;
export type XanoAiTextModel = (typeof XANO_AI_TEXT_MODELS)[number];

/** The listed Xano AI `image` models, as the snapshot recorded them. Suggestions, not a closed set. */
export const XANO_AI_IMAGE_MODELS = [
  "gemini-3.1-flash-image",
  "gemini-3-pro-image",
  "gemini-3.1-flash-lite-image",
  "gemini-nano-banana-2.1",
] as const;
export type XanoAiImageModel = (typeof XANO_AI_IMAGE_MODELS)[number];

/** The listed Xano AI `video` models, as the snapshot recorded them. Suggestions, not a closed set. */
export const XANO_AI_VIDEO_MODELS = [
  "veo-3.1-fast-generate-001",
  "veo-3.1-generate-001",
  "veo-3.1-lite-generate-001",
] as const;
export type XanoAiVideoModel = (typeof XANO_AI_VIDEO_MODELS)[number];

/** The listed Xano AI `music` models, as the snapshot recorded them. Suggestions, not a closed set. */
export const XANO_AI_MUSIC_MODELS = [
  "lyria-002",
  "lyria-3-clip-preview",
  "lyria-3-pro-preview",
] as const;
export type XanoAiMusicModel = (typeof XANO_AI_MUSIC_MODELS)[number];

/** The listed Xano AI `speech` models, as the snapshot recorded them. Suggestions, not a closed set. */
export const XANO_AI_SPEECH_MODELS = [
  "gemini-3.8-flash-tts",
  "gemini-3.8-flash-lite-tts",
] as const;
export type XanoAiSpeechModel = (typeof XANO_AI_SPEECH_MODELS)[number];

/** The listed Xano AI `speech` voices, as the snapshot recorded them. Suggestions, not a closed set. */
export const XANO_AI_SPEECH_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
] as const;
export type XanoAiSpeechVoice = (typeof XANO_AI_SPEECH_VOICES)[number];

/** The listed Xano AI `transcribe` models, as the snapshot recorded them. Suggestions, not a closed set. */
export const XANO_AI_TRANSCRIBE_MODELS = [
  "gemini-3.5-transcribe",
] as const;
export type XanoAiTranscribeModel = (typeof XANO_AI_TRANSCRIBE_MODELS)[number];

/** The listed Xano AI `embedding` models, as the snapshot recorded them. Suggestions, not a closed set. */
export const XANO_AI_EMBEDDING_MODELS = [
  "gemini-embedding-2",
  "gemini-embedding-001",
] as const;
export type XanoAiEmbeddingModel = (typeof XANO_AI_EMBEDDING_MODELS)[number];

/** The listed Xano AI `rerank` models, as the snapshot recorded them. Suggestions, not a closed set. */
export const XANO_AI_RERANK_MODELS = [] as const;
export type XanoAiRerankModel = (typeof XANO_AI_RERANK_MODELS)[number];

/** The models a Xano AI agent may run. */
export const XANO_AI_AGENT_MODELS = [
  "gemini-3.8-flash",
  "gemini-4-argon",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
] as const;
export type XanoAiAgentModel = (typeof XANO_AI_AGENT_MODELS)[number];

/** Every open field's suggestions, keyed `"<stored statement name>:<field>"`. */
export const XANO_AI_SUGGESTIONS: Readonly<Record<string, readonly string[]>> = {
  "mvp:ai_text_generate:model": XANO_AI_TEXT_MODELS,
  "mvp:ai_image_generate:model": XANO_AI_IMAGE_MODELS,
  "mvp:ai_video_generate:model": XANO_AI_VIDEO_MODELS,
  "mvp:ai_music_generate:model": XANO_AI_MUSIC_MODELS,
  "mvp:ai_speech_generate:model": XANO_AI_SPEECH_MODELS,
  "mvp:ai_speech_generate:voice": XANO_AI_SPEECH_VOICES,
  "mvp:ai_speech_transcribe:model": XANO_AI_TRANSCRIBE_MODELS,
  "mvp:ai_embedding_create:model": XANO_AI_EMBEDDING_MODELS,
  "mvp:ai_rerank:model": XANO_AI_RERANK_MODELS,
};
