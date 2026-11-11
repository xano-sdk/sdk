/**
 * The Xano AI catalog's statement keys: one per AI statement the catalog lists
 * models for, in the order every view shows them.
 *
 * Kept free of imports so both the authoring surface (field overrides, the
 * generated model suggestions) and the CLI's catalog reader can share it
 * without the authoring bundle pulling in Node-only CLI code.
 */
export const AI_STATEMENTS = ["text", "image", "video", "speech", "transcribe", "embedding", "rerank", "music"] as const;

export type AiStatement = (typeof AI_STATEMENTS)[number];

/**
 * Where Xano AI runs a model. `""` defers the choice: a statement or agent
 * inherits the workspace's Xano AI location, and the workspace leaves it to
 * the gateway. Lowercase only.
 */
export const XANO_AI_LOCATIONS = ["", "us", "global", "eu"] as const;

export type XanoAiLocationName = (typeof XANO_AI_LOCATIONS)[number];
