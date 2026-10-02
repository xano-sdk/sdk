/**
 * Minimal gzipped USTAR writer — the single home for the ustar header math
 * (byte offsets, the `\0 ` checksum terminator, mtime pinned to 0) shared by the
 * two archive producers: the workspace-import archive ({@link import("../validate/archive.js")})
 * and the static-host tarball ({@link import("../deploy/static-host.js")}). Both
 * upload a `gzip(tar(...))` the server untars; keeping one implementation means
 * the fiddly checksum/offset code is written and tested once.
 *
 * Node-only (`node:zlib`).
 */
import { gzipSync } from "node:zlib";

/** One tar member: its in-archive name (≤100 bytes) and raw bytes. */
export interface TarFile {
  name: string;
  data: Buffer;
}

/** Build one 512-byte USTAR header with a correct checksum (mtime pinned to 0 for determinism). */
export function tarHeader(name: string, size: number): Buffer {
  if (Buffer.byteLength(name, "utf8") > 100) {
    throw new Error(`tar entry name too long for ustar (>100 bytes): ${name}`);
  }
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, "utf8"); // name (100)
  h.write("0000644\0", 100, "ascii"); // mode 0644 (8)
  h.write("0000000\0", 108, "ascii"); // uid (8)
  h.write("0000000\0", 116, "ascii"); // gid (8)
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii"); // size (12)
  h.write("00000000000\0", 136, "ascii"); // mtime 0 (12)
  h.write("        ", 148, "ascii"); // checksum placeholder: 8 spaces
  h.write("0", 156, "ascii"); // typeflag: regular file
  h.write("ustar\0", 257, "ascii"); // magic (6)
  h.write("00", 263, "ascii"); // version (2)
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i]!;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii"); // "NNNNNN\0 " (8)
  return h;
}

/**
 * Assemble a gzipped USTAR tarball from `files`, in order, terminated by two zero
 * blocks. Each entry is header + data + pad-to-512, pushed as flat blocks and
 * concatenated once before gzip (no per-entry intermediate copy).
 */
export function tarGz(files: readonly TarFile[]): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    blocks.push(tarHeader(f.name, f.data.length));
    blocks.push(f.data);
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0)); // two trailing zero blocks terminate the archive
  return gzipSync(Buffer.concat(blocks));
}
