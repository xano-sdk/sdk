/**
 * Read a `.zip` or a (gzipped) tar into memory, dependency-free (DEV-10113).
 *
 * The archives come from a server: a static site build's kept source, which
 * whoever published the build chose. So nothing in one is trusted. A name that
 * climbs out of its folder (`../x`, `/etc/x`) refuses the whole archive; a link,
 * a device or any other non-file entry is left out (a link would copy this
 * computer's files into the project); and the unpacked size and the number of
 * files are bounded, so a small archive cannot inflate past memory.
 *
 * Folders an app never carries (`node_modules`, `.git`, `__MACOSX`, `.DS_Store`,
 * `.xano`) are left out. When everything sits in one top folder (a zip of a
 * folder), that folder is the root, as it is when Xano Studio unpacks one.
 *
 * Node-only (`node:zlib`).
 */
import { gunzipSync, inflateRawSync } from "node:zlib";

/** One file of an archive: its slash-separated path from the archive's root, and its bytes. */
export interface ArchiveFile {
  path: string;
  data: Buffer;
}

/** The archive kinds {@link readArchive} reads. */
export type ArchiveFormat = "zip" | "tar";

/** An archive that could not be read: not one, damaged, unsafe, or too large. */
export class ArchiveReadError extends Error {
  override readonly name = "ArchiveReadError";
}

/** The most files one archive may hold. */
export const MAX_ARCHIVE_FILES = 50_000;

/** The most bytes one archive may unpack to. */
export const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;

/** Names left out wherever they appear in a path. */
const SKIPPED = new Set(["node_modules", ".git", "__MACOSX", ".DS_Store", ".xano"]);

export interface ReadArchiveOptions {
  maxFiles?: number;
  maxBytes?: number;
}

/** What the first bytes say: a zip, a gzip (taken as a gzipped tar), a plain tar, or neither. */
export function archiveFormat(bytes: Uint8Array): ArchiveFormat | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "zip";
  // An empty zip is only its end record.
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x05 && bytes[3] === 0x06) return "zip";
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "tar";
  if (bytes.length >= 262 && Buffer.from(bytes.subarray(257, 262)).toString("latin1") === "ustar") return "tar";
  return undefined;
}

/**
 * Every file of `bytes`, sorted by path, rooted at the archive's content root.
 * Throws {@link ArchiveReadError} on anything it will not read.
 */
export function readArchive(bytes: Uint8Array, opts: ReadArchiveOptions = {}): ArchiveFile[] {
  const format = archiveFormat(bytes);
  if (format === undefined) throw new ArchiveReadError("not a .zip or .tar archive");
  const limits = { maxFiles: opts.maxFiles ?? MAX_ARCHIVE_FILES, maxBytes: opts.maxBytes ?? MAX_UNPACKED_BYTES };
  const raw = format === "zip" ? readZip(Buffer.from(bytes), limits) : readTar(Buffer.from(bytes), limits);
  const kept = raw.filter((f) => !f.path.split("/").some((part) => SKIPPED.has(part)));
  return contentRooted(kept).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A path as stored, made relative and checked: `undefined` for a folder entry or an empty name. */
function safePath(stored: string): string | undefined {
  let path = stored.replace(/^(\.\/)+/, "");
  const folder = path.endsWith("/");
  path = path.replace(/\/+$/, "");
  if (path === "" || folder) return undefined;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\") || path.includes("\0")) {
    throw new ArchiveReadError(`it holds a file outside its own folder ("${stored}")`);
  }
  const parts = path.split("/");
  if (parts.some((p) => p === ".." )) throw new ArchiveReadError(`it holds a file outside its own folder ("${stored}")`);
  return parts.filter((p) => p !== "" && p !== ".").join("/");
}

/** Strip one top folder that holds everything, as a zip of a folder has. */
function contentRooted(files: ArchiveFile[]): ArchiveFile[] {
  const tops = new Set(files.map((f) => f.path.split("/")[0]!));
  if (tops.size !== 1 || files.some((f) => !f.path.includes("/"))) return files;
  const top = [...tops][0]!;
  return files.map((f) => ({ path: f.path.slice(top.length + 1), data: f.data }));
}

interface Limits {
  maxFiles: number;
  maxBytes: number;
}

function tally(limits: Limits): (size: number) => void {
  let count = 0;
  let total = 0;
  return (size) => {
    count += 1;
    total += size;
    if (count > limits.maxFiles) throw new ArchiveReadError(`it holds more than ${limits.maxFiles} files`);
    if (total > limits.maxBytes) throw new ArchiveReadError(`it unpacks to more than ${Math.round(limits.maxBytes / (1024 * 1024))} MB`);
  };
}

/* ------------------------------------------------------------------ *
 * zip
 * ------------------------------------------------------------------ */

function readZip(buf: Buffer, limits: Limits): ArchiveFile[] {
  // The end-of-central-directory record: within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveReadError("the .zip has no directory (it is damaged or cut short)");
  const entries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) throw new ArchiveReadError("a ZIP64 archive is not read");
  const count = tally(limits);
  const files: ArchiveFile[] = [];
  let at = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new ArchiveReadError("the .zip's directory is damaged");
    const madeBy = buf.readUInt16LE(at + 4) >> 8;
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const external = buf.readUInt32LE(at + 38);
    const local = buf.readUInt32LE(at + 42);
    const stored = buf.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;

    const path = safePath(stored);
    if (path === undefined) continue;
    // Unix hosts keep the file type in the high half: anything but a file is left out.
    if (madeBy === 3) {
      const type = (external >>> 16) & 0o170000;
      if (type !== 0 && type !== 0o100000) continue;
    }
    if ((flags & 1) !== 0) throw new ArchiveReadError(`"${path}" is encrypted`);
    if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new ArchiveReadError("a ZIP64 archive is not read");
    count(size);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new ArchiveReadError("the .zip is damaged");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + compressed > buf.length) throw new ArchiveReadError("the .zip is cut short");
    const body = buf.subarray(start, start + compressed);
    let data: Buffer;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) {
      try {
        data = inflateRawSync(body, { maxOutputLength: Math.max(size, 1) });
      } catch {
        throw new ArchiveReadError(`"${path}" could not be unpacked`);
      }
    } else throw new ArchiveReadError(`"${path}" is compressed in a way that is not read (method ${method})`);
    if (data.length !== size) throw new ArchiveReadError(`"${path}" is damaged`);
    files.push({ path, data });
  }
  return files;
}

/* ------------------------------------------------------------------ *
 * tar
 * ------------------------------------------------------------------ */

function octal(field: Buffer): number {
  const text = field.toString("latin1").replace(/\0.*$/s, "").trim();
  return text === "" ? 0 : parseInt(text, 8);
}

function cString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.toString("utf8", 0, end === -1 ? field.length : end);
}

function checksumOk(block: Buffer): boolean {
  const stored = octal(block.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
  return sum === stored;
}

/** The `path` a pax extended header names, when it names one. */
function paxPath(data: Buffer): string | undefined {
  const text = data.toString("utf8");
  let at = 0;
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    if (space < 0) break;
    const len = parseInt(text.slice(at, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(space + 1, at + len - 1);
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") return record.slice(eq + 1);
    at += len;
  }
  return undefined;
}

function readTar(input: Buffer, limits: Limits): ArchiveFile[] {
  let tar = input;
  if (input[0] === 0x1f && input[1] === 0x8b) {
    try {
      tar = gunzipSync(input, { maxOutputLength: limits.maxBytes + 1024 * 1024 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        throw new ArchiveReadError(`it unpacks to more than ${Math.round(limits.maxBytes / (1024 * 1024))} MB`);
      }
      throw new ArchiveReadError("not a gzip archive (it is damaged)");
    }
  }
  const count = tally(limits);
  const files: ArchiveFile[] = [];
  let longName: string | undefined;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break;
    if (!checksumOk(block)) throw new ArchiveReadError("not a tar archive (a header is damaged)");
    const size = octal(block.subarray(124, 136));
    const type = String.fromCharCode(block[156]!);
    const start = offset + 512;
    if (start + size > tar.length) throw new ArchiveReadError("the tar is cut short");
    const data = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;

    if (type === "L") {
      longName = cString(Buffer.from(data));
      continue;
    }
    if (type === "x") {
      longName = paxPath(Buffer.from(data)) ?? longName;
      continue;
    }
    if (type === "g") continue;
    const ustar = block.toString("latin1", 257, 262) === "ustar";
    const prefix = ustar ? cString(block.subarray(345, 500)) : "";
    const name = longName ?? (prefix === "" ? cString(block.subarray(0, 100)) : `${prefix}/${cString(block.subarray(0, 100))}`);
    longName = undefined;
    // Only regular files: folders are implied, links and devices are left out.
    if (type !== "0" && type !== "\0" && type !== "7") continue;
    const path = safePath(name);
    if (path === undefined) continue;
    count(size);
    files.push({ path, data: Buffer.from(data) });
  }
  return files;
}
