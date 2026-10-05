/**
 * SHA-256 of a byte buffer or a UTF-8 string, as lowercase hex.
 *
 * Node-only, unlike its neighbour `hash.ts`: the callers are the local
 * cache, which re-checks an executable's digest before every spawn, and release
 * transfer, which hashes whole archives. Both run in the CLI, and both hash
 * enough bytes that the native implementation's speed is the point.
 */
import { createHash } from "node:crypto";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
