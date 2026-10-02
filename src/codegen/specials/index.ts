/**
 * Specials registry — hand-written decoders keyed by stored statement name.
 *
 * These are checked before the spec-inverse arm because the families
 * here have hand-written *encoders*, and a naive spec inversion would mangle
 * their stored shape.
 */
import type { SpecialDecoder } from "./prove.js";
import { CONTROL_FLOW_DECODERS } from "./control-flow.js";
import { CALL_DECODERS } from "./calls.js";
import { DB_DECODERS } from "./db.js";
import { AI_CLOUD_DECODERS } from "./ai-cloud.js";
import { MISC_DECODERS } from "./misc.js";

/** Every registered special decoder, by stored name. */
export const SPECIAL_DECODERS: ReadonlyMap<string, SpecialDecoder> = new Map([
  ...CONTROL_FLOW_DECODERS,
  ...CALL_DECODERS,
  ...DB_DECODERS,
  ...AI_CLOUD_DECODERS,
  ...MISC_DECODERS,
]);

export type { SpecialArgs, SpecialDecoder } from "./prove.js";
export { prove, getPath } from "./prove.js";
