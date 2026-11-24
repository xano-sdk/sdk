/**
 * Minimal `.zip` writer, dependency-free: each file deflated (or stored, when
 * deflating does not shrink it), UTF-8 names, every timestamp pinned to
 * 1980-01-01 so the same files always make the same bytes. No zip64: callers
 * stay under 65,535 entries and 4 GB (the static upload cap is far below both).
 *
 * The SDK's tarball (`tar.ts`) caps a name at 100 bytes; an app's source has
 * deeper paths than a build, so its archive is a zip, as Xano Studio's is.
 *
 * Node-only (`node:zlib`).
 */
import { deflateRawSync } from "node:zlib";

/** One zip member: its slash-separated name and raw bytes. */
export interface ZipFile {
  name: string;
  data: Buffer;
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 a zip entry carries. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 1980-01-01 00:00, the earliest DOS date. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
/** General-purpose flag bit 11: the name is UTF-8. */
const UTF8_NAMES = 0x0800;

/**
 * A `.zip` built one file at a time: each is compressed as it is added, so a
 * caller can watch {@link ZipWriter.size} and stop before reading more.
 */
export class ZipWriter {
  private readonly parts: Buffer[] = [];
  private readonly central: Buffer[] = [];
  private offset = 0;
  private count = 0;

  /** The bytes the archive holds so far, its directory not counted. */
  get size(): number {
    return this.offset;
  }

  add(file: ZipFile): void {
    if (this.count >= 0xffff) throw new Error("a zip without zip64 holds at most 65535 entries");
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(file.data);
    const deflated = deflateRawSync(file.data);
    const stored = deflated.length >= file.data.length;
    const body = stored ? file.data : deflated;
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    this.parts.push(local, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(UTF8_NAMES, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    // extra, comment, disk start, internal attributes: 0
    entry.writeUInt32LE(0, 38); // external attributes
    entry.writeUInt32LE(this.offset, 42);
    this.central.push(entry, name);

    this.offset += local.length + name.length + body.length;
    this.count += 1;
  }

  /** The finished archive: every file added, then the directory. */
  finish(): Buffer {
    const directory = Buffer.concat(this.central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.count, 8);
    end.writeUInt16LE(this.count, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(this.offset, 16);
    return Buffer.concat([...this.parts, directory, end]);
  }
}

/** Assemble a `.zip` of `files`, in order. */
export function zipFiles(files: readonly ZipFile[]): Buffer {
  const zip = new ZipWriter();
  for (const file of files) zip.add(file);
  return zip.finish();
}
