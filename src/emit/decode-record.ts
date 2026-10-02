/**
 * The record a decode leaves in the tree it wrote: which files, and each one's
 * digest. Pure string work, so the browser-safe scaffold templates can build a
 * marker; reading one back off disk lives in `backend-tree.ts`.
 */
import { md5Hex } from "../util/hash.js";

/** A file's content digest, as a decode records it. */
export function decodeDigest(content: string): string {
  return md5Hex(content);
}

/**
 * The marker fields recording what this decode wrote — `files`, and each file's
 * digest so the next replace can tell an edited file from one only the source
 * changed. Merged over `previous` (the marker already there), so what another
 * command recorded in it survives.
 */
export function decodeMarkerWith(
  previous: Record<string, unknown>,
  files: readonly { readonly path: string; readonly content: string }[],
): Record<string, unknown> {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return {
    ...previous,
    files: sorted.map((f) => f.path),
    digests: Object.fromEntries(sorted.map((f) => [f.path, decodeDigest(f.content)])),
  };
}

/** The source kinds a provenance can name (`ephemeral:x`); anything else is a bundle file. */
const SOURCE_KINDS = new Set(["workspace", "ephemeral", "local-engine", "tenant", "release"]);

/**
 * The marker's head — which source the tree came from, which command wrote it,
 * when — rewritten by EVERY decode, over whatever the marker already holds.
 *
 * A pull used to merge only `files`/`digests` into the marker `init --from`
 * left, so a tree pulled from an ephemeral kept saying `"source": "file"` and
 * "Written by `xanosdk init --from`" for the rest of its life — a record of the
 * first decode, not the last. `provenance` is the source as the command names it
 * (`ephemeral:e2e`, `release:v1`, `workspace`, `./bundle.json`).
 */
export function decodeMarkerHead(
  previous: Record<string, unknown>,
  command: "pull" | "generate",
  provenance: string,
  sdkVersion: string,
  report?: unknown,
): Record<string, unknown> {
  const colon = provenance.indexOf(":");
  const kind = colon === -1 ? provenance : provenance.slice(0, colon);
  const origin = SOURCE_KINDS.has(kind)
    ? { source: kind, origin: colon === -1 ? kind : provenance.slice(colon + 1) }
    : { source: "file", origin: provenance };
  // `generatedBy` was generate's own spelling of `note`; one field says it now.
  // `files`/`digests` are rewritten after the head (`decodeMarkerWith`), so every decode
  // writes the marker in one order: head, report, then the file record.
  const { generatedBy: _generatedBy, report: _previousReport, files: _files, digests: _digests, ...kept } = previous;
  return {
    ...kept,
    ...origin,
    sdkVersion,
    generatedAt: new Date().toISOString(),
    note: `Written by \`xanosdk ${command}\`. Its presence lets a later \`pull\`, \`generate --force\` or \`init --from\` refresh this tree in place.`,
    // The findings of THIS decode — a previous one's would describe a source
    // the tree no longer reflects. Dropped when this command has none to say.
    ...(report !== undefined ? { report } : {}),
  };
}
