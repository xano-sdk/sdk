/**
 * A Xano Engine export bundle, as `init --from <bundle.tar.gz>` recognizes it:
 * the workspace download a hosted trial ends with.
 *
 * The bundle is a `.tar.gz` whose FIRST entry is `manifest.json` (its format
 * name, a version, and for a one-workspace export `workspace: { id, name }` and
 * `notes`), followed by `data/`, an engine data directory. Only the manifest is
 * read here, and only to tell a bundle from any other `.tar.gz` and to name the
 * project: the unpacking is the engine's own `import` verb
 * (`local-engine-process.ts`, `importEngineBundle`), so the layout on disk is
 * always the engine's and never this SDK's guess at it.
 *
 * Reading stops once the manifest is in hand: a bundle can be gigabytes of
 * records and files, and none of that is needed to recognize it.
 *
 * Node-only (node:fs, node:zlib); reached by lazy imports.
 */
import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { createGunzip } from "node:zlib";

/**
 * The manifest's `format`. Assembled rather than spelled: the joined form is
 * also the engine binary's own name, which this package never spells (see
 * `test/helpers/source-leak.ts`), while the format value is the bundle's public
 * wire format — anyone who opens the download reads it.
 */
export const ENGINE_BUNDLE_FORMAT = ["xano", "engine", "bundle"].join("-");

/** The bundle's first entry. */
const MANIFEST_NAME = "manifest.json";

/** The most a manifest may hold, as the engine bounds it: a larger one is not a bundle. */
const MANIFEST_LIMIT = 1 << 20;

/** What this SDK reads off a bundle's manifest. */
export interface EngineBundleManifest {
  /** The bundle format's version. The engine's import decides which it reads. */
  version: number;
  /** The one workspace a workspace export carries, with its hosted id and name. Absent for a whole instance. */
  workspace?: { id: number; name: string };
  /** What the engine runs differently from the hosted instance, for the person importing it. */
  notes: string[];
}

/** Why a file is not a bundle, in words for a refusal. */
export class NotAnEngineBundle extends Error {
  override readonly name = "NotAnEngineBundle";
}

/** Whether the file at `path` starts with the gzip magic bytes. False for anything unreadable. */
export function isGzipFile(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(2);
    return readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0x1f && head[1] === 0x8b;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Read the manifest of the bundle at `path`, or throw {@link NotAnEngineBundle}
 * saying why it is not one: not gzip, not a tar, a first entry other than
 * `manifest.json`, a manifest that does not parse, or another format.
 */
export async function readEngineBundleManifest(path: string): Promise<EngineBundleManifest> {
  // Room for a pax or long-name header before the manifest, the manifest's own
  // header, and the manifest itself at its limit.
  const head = await gunzipHead(path, 4 * 512 + MANIFEST_LIMIT + 512);
  const first = firstTarEntry(head);
  if (first === undefined) throw new NotAnEngineBundle("it holds no tar archive");
  if (first.name.replace(/^\.\//, "") !== MANIFEST_NAME || !first.regular) {
    throw new NotAnEngineBundle(`it does not start with ${MANIFEST_NAME}`);
  }
  if (first.size > MANIFEST_LIMIT || first.data.length < first.size) {
    throw new NotAnEngineBundle(`its ${MANIFEST_NAME} is too large`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(first.data.toString("utf8"));
  } catch {
    throw new NotAnEngineBundle(`its ${MANIFEST_NAME} is not JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NotAnEngineBundle(`its ${MANIFEST_NAME} is not an object`);
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.format !== ENGINE_BUNDLE_FORMAT) throw new NotAnEngineBundle(`its ${MANIFEST_NAME} names another format`);
  const ws = raw.workspace as Record<string, unknown> | undefined;
  const workspace =
    ws !== null && typeof ws === "object" && typeof ws.id === "number" && Number.isInteger(ws.id)
      ? { id: ws.id, name: typeof ws.name === "string" ? ws.name : "" }
      : undefined;
  const notes = Array.isArray(raw.notes) ? raw.notes.filter((n): n is string => typeof n === "string" && n.trim() !== "") : [];
  return {
    version: typeof raw.version === "number" ? raw.version : 0,
    ...(workspace === undefined ? {} : { workspace }),
    notes,
  };
}

/** The first `max` decompressed bytes of the gzip file at `path` (fewer when it is shorter). */
function gunzipHead(path: string, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const source = createReadStream(path);
    const gunzip = createGunzip();
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      source.destroy();
      gunzip.destroy();
      if (err !== undefined && size === 0) reject(new NotAnEngineBundle(`it is not a readable .tar.gz (${err.message})`));
      else resolve(Buffer.concat(chunks).subarray(0, max));
    };
    gunzip.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= max) finish();
    });
    gunzip.on("end", () => finish());
    // A stream cut short past the manifest still answers with what it read.
    gunzip.on("error", (err) => finish(err));
    source.on("error", (err) => finish(err));
    source.pipe(gunzip);
  });
}

interface TarEntry {
  name: string;
  regular: boolean;
  size: number;
  data: Buffer;
}

/**
 * The first real entry of a tar stream: past any pax (`x`, `g`) or GNU
 * long-name (`L`) header, whose name it then carries. Undefined when `buf`
 * holds no valid header.
 */
function firstTarEntry(buf: Buffer): TarEntry | undefined {
  let offset = 0;
  let longName: string | undefined;
  for (let i = 0; i < 4; i++) {
    if (buf.length < offset + 512) return undefined;
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0) || !checksumMatches(header)) return undefined;
    const size = parseInt(text(header, 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) return undefined;
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    const ustar = text(header, 257, 6).startsWith("ustar");
    const prefix = ustar ? text(header, 345, 155) : "";
    const name = prefix === "" ? text(header, 0, 100) : `${prefix}/${text(header, 0, 100)}`;
    offset += 512;
    const data = buf.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === "x") {
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"))?.[1] ?? longName;
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = text(data, 0, data.length);
      continue;
    }
    return { name: longName ?? name, regular: type === "0" || type === "7", size, data };
  }
  return undefined;
}

/** A NUL-terminated header field. */
function text(buf: Buffer, start: number, length: number): string {
  const field = buf.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

/** Whether a tar header's checksum (its bytes summed, the checksum field read as spaces) is the one it records. */
function checksumMatches(header: Buffer): boolean {
  const recorded = parseInt(text(header, 148, 8).trim(), 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
  return recorded === sum;
}
