/**
 * Decode a Xano workspace export archive into its `workspace.json` bundle.
 *
 * The export endpoint serves a gzipped tar (observed double-gzipped) whose root
 * holds `workspace.json` — the same `packageExport` shape the SDK emits, with
 * full object logic (`run`/`result`). This is what makes a faithful round-trip
 * (and real fixture capture) possible: both sides are packageExport, so the
 * existing normalizer compares them directly.
 *
 * Node-only (uses `node:zlib`); reached through the meta client.
 */
import { gunzipSync } from "node:zlib";
import { tarGz } from "../util/tar.js";

/** One archive member: its in-archive path and the UTF-8 text stored at it. */
export interface ArchiveEntry {
  name: string;
  /** Text members (the bundle, seed pages) are UTF-8; a hosted file's bytes ride as-is. */
  content: string | Uint8Array;
}

/**
 * Encode a compiled `packageExport` bundle into the `gzip(tar(...))` archive the
 * SDK's import route (`POST /api:meta/workspace/{id}/xanosdk/import`) accepts — the
 * exact inverse of {@link decodeWorkspaceArchive}. The bundle text is written
 * verbatim as the root `workspace.json` entry (the path the server reads back from
 * its extraction dir); any `extra` members (e.g. `content/<guid>-<page>.json` seed
 * files) follow it in order, so the deploy path reuses the SDK's existing bundle
 * plus its seed content unchanged.
 *
 * The result is a single-gzip archive; the server peels every gzip layer, so one
 * is enough. Callers upload it as the multipart `file` field with a filename
 * that must NOT end in `.enc.gz` (which the server treats as encrypted).
 */
export function encodeWorkspaceArchive(
  workspaceJson: string,
  extra: readonly ArchiveEntry[] = [],
): Uint8Array {
  return tarGz([
    { name: "workspace.json", data: Buffer.from(workspaceJson, "utf8") },
    ...extra.map((e) => ({
      name: e.name,
      data: typeof e.content === "string" ? Buffer.from(e.content, "utf8") : Buffer.from(e.content),
    })),
  ]);
}

/**
 * The hosted-file members an archive carries (`vault/<canonical>/<name>`),
 * byte for byte. A merge re-encodes its archive from the bundle text alone, so
 * it takes these from the archive it would otherwise have sent: the bundle's
 * file library names them, and an archive without them cannot land.
 */
export function archiveHostedFiles(archive: Uint8Array): ArchiveEntry[] {
  return Object.entries(readArchiveEntries(archive))
    .filter(([name]) => name.startsWith("vault/"))
    .map(([name, data]) => ({ name, content: data }));
}

/**
 * The most bytes one gzip layer may inflate to. Far past any real workspace
 * archive, and a bound on what a hostile one can make this process buffer.
 */
export const MAX_UNWRAPPED_BYTES = 1024 * 1024 * 1024;

/** An archive that inflates past the bound it was read under, so it was not read. */
export class ArchiveTooLargeError extends Error {
  override readonly name = "ArchiveTooLargeError";
  constructor(readonly maxBytes: number) {
    super(`The archive decompresses to more than ${maxBytes} bytes, so it was not read.`);
  }
}

/**
 * The tar inside an archive: every gzip layer peeled. An export is gzipped,
 * sometimes twice, and a release the import route stored comes back as the bare
 * tar — so this is the one form every copy of an archive shares.
 *
 * Every layer is inflated under `maxBytes`. The input is not always ours: a
 * release transfer peels every release the destination holds under the name,
 * and anyone who can import there can plant a small archive that inflates
 * without bound. Past the bound this throws rather than buffers.
 */
export function unwrapGzip(data: Uint8Array, opts: { maxBytes?: number } = {}): Buffer {
  const maxBytes = opts.maxBytes ?? MAX_UNWRAPPED_BYTES;
  let buf = Buffer.from(data);
  let guard = 0;
  while (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b && guard++ < 8) {
    try {
      buf = gunzipSync(buf, { maxOutputLength: maxBytes });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        throw new ArchiveTooLargeError(maxBytes);
      }
      throw err;
    }
  }
  return buf;
}

/**
 * Every member of an archive, gzip layers peeled, keyed by its in-archive path
 * with any leading `./` dropped — a server-built archive carries one, and the
 * import resolves members from the extraction root either way.
 */
export function readArchiveEntries(data: Uint8Array): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const [name, bytes] of Object.entries(readTar(unwrapGzip(data)))) {
    out[name.replace(/^\.\//, "")] = bytes;
  }
  return out;
}

/** Peel gzip layers, untar, and return the parsed `workspace.json` object. */
export function decodeWorkspaceArchive(data: Uint8Array): unknown {
  const files = readTar(unwrapGzip(data));
  const key = Object.keys(files).find((k) => k.endsWith("workspace.json"));
  if (key === undefined) {
    const seen = Object.keys(files).join(", ") || "none";
    throw new Error(`Workspace export archive has no workspace.json (entries: ${seen}).`);
  }
  return JSON.parse(files[key]!.toString("utf8")) as unknown;
}

/**
 * Minimal ustar reader → `{ filename: contents }`. Each entry is a 512-byte
 * header (name@0..100, octal size@124..136) followed by its data padded to a
 * 512-byte boundary. Sufficient for the small, GNU-tar-produced workspace archive.
 */
function readTar(buf: Buffer): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = buf.toString("utf8", off, off + 100).replace(/\0.*$/, "");
    if (name === "") break; // two zero blocks mark the archive end
    const sizeField = buf.toString("utf8", off + 124, off + 136).replace(/\0.*$/, "").trim();
    const size = parseInt(sizeField || "0", 8);
    const start = off + 512;
    if (Number.isFinite(size) && size > 0) files[name] = buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
  }
  return files;
}
