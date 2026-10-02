/**
 * Reads and checks a {@link HostedFile} on the deploy path. Node-only: the
 * browser-safe `export()` never calls this, which keeps file bytes out of any
 * frontend bundle.
 *
 * Every refusal names the def's field and the file, because a bad reference is
 * fixed at the place it was written, not where the archive was assembled.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LocalFileNotFoundError } from "../emit/errors.js";
import {
  HOSTED_FILE,
  HOSTED_FILE_SCHEME,
  HOSTED_ROW_PATH_PREFIX,
  type HostedFile,
  type HostedFileAccess,
  type HostedFileRules,
} from "../fields/hosted-file.js";
import { isMissingFile } from "../util/local-file.js";
import { repoBoundaryFrom } from "../util/project-root.js";

export type { HostedFileRules } from "../fields/hosted-file.js";

/** Largest file the archive will carry. A release ships as one request, so this is small on purpose. */
export const HOSTED_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** A hosted file read and checked, ready to become archive entries. */
export interface ResolvedHostedFile {
  /** The file's own name, which is also its name in the file library. */
  name: string;
  bytes: Uint8Array;
  size: number;
  mime: string;
  access: HostedFileAccess;
  /** Identity derived from the bytes: the same content is the same file on every publish. */
  canonical: string;
  /**
   * The engine's content signature (SHA-1 of the bytes). An import compares it
   * with what it already stores under `canonical` and skips uploading a file it
   * holds.
   */
  sig: string;
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
  ".csv": "text/csv",
};

/**
 * The leading bytes each raster image type starts with. A file named for one
 * of these types whose contents do not match is refused: the extension is what
 * decides the served type, so SVG markup saved as `.png` would otherwise pass a
 * rule that exists to keep SVG out.
 */
const IMAGE_SIGNATURES: Readonly<Record<string, (b: Buffer) => boolean>> = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  "image/gif": (b) => b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a",
  "image/x-icon": (b) => b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0,
};

/**
 * Refuse a file outside the repository the declaring module belongs to (see
 * {@link repoBoundaryFrom} for how that root is found). Both sides are
 * resolved through symlinks, so a link cannot carry a file out.
 */
function assertInsideRepo(where: string, file: string, base: string): void {
  if (!base.startsWith("file:")) return;
  const boundary = repoBoundaryFrom(dirname(fileURLToPath(base)));
  const root = realpathSync(boundary.root);
  const real = realpathSync(file);
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    const via = lstatSync(file).isSymbolicLink() ? ` (a link to "${real}")` : "";
    throw new Error(
      `${where}: "${file}"${via} is outside the ${boundary.kind} (${root}). A hosted file ships only from inside it — ` +
        `copy the file into ${root} and point at the copy.`,
    );
  }
}

/** Read a {@link HostedFile}, check it against `rules`, and derive its identity. */
export function resolveHostedFile(ref: HostedFile, rules: HostedFileRules = {}): ResolvedHostedFile {
  const { path, base, access } = ref[HOSTED_FILE];
  const where = `${rules.field ? `${rules.field}: ` : ""}hostedFile("${path}")`;
  const baseUrl = /^[a-z][a-z0-9+.-]*:/i.test(base) ? base : pathToFileURL(base).href;
  const file = fileURLToPath(new URL(path, baseUrl));

  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (cause) {
    const relative = "The path is resolved relative to the module that declares it (the `import.meta.url` you passed as `base`).";
    if (isMissingFile(cause)) throw new LocalFileNotFoundError(`${where}: no file at "${file}". ${relative}`);
    throw new Error(`${where}: cannot read "${file}". ${relative}`, { cause });
  }

  assertInsideRepo(where, file, baseUrl);
  if (bytes.length === 0) throw new Error(`${where}: "${file}" is empty.`);
  if (bytes.length > HOSTED_FILE_MAX_BYTES) {
    throw new Error(`${where}: "${file}" is ${bytes.length} bytes, over the ${HOSTED_FILE_MAX_BYTES}-byte limit for a hosted file.`);
  }

  const mime = MIME_BY_EXT[extname(file).toLowerCase()] ?? "application/octet-stream";
  const signature = IMAGE_SIGNATURES[mime];
  if (signature !== undefined && !signature(bytes)) {
    throw new Error(`${where}: "${file}" is named as ${mime}, but its contents are not a ${mime.slice(6).toUpperCase()} image.`);
  }
  if (rules.declaredMime !== undefined && rules.declaredMime !== mime) {
    throw new Error(`${where}: \`mimeType\` says ${rules.declaredMime}, but "${file}" is ${mime}. Drop \`mimeType\` or make it ${mime}.`);
  }
  if (rules.allowedMimes && !rules.allowedMimes.includes(mime)) {
    throw new Error(`${where}: "${file}" is ${mime}, but this field accepts ${rules.allowedMimes.join(", ")}.`);
  }
  if (rules.mimeKind && !mime.startsWith(`${rules.mimeKind}/`)) {
    throw new Error(`${where}: "${file}" is ${mime}, but this field holds ${rules.mimeKind}/* files.`);
  }
  if (rules.requirePublic && access !== "public") {
    throw new Error(`${where}: a private file cannot be used here — this field is fetched with no credentials, so the file must be public.`);
  }

  const canonical = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  const name = basename(file);
  // The archive member is `vault/<canonical>/<name>` and a tar header holds 100
  // bytes of name; refused here, where the field and file can be named.
  if (Buffer.byteLength(`vault/${canonical}/${name}`) > 100) {
    throw new Error(`${where}: the file name "${name}" is too long to ship — keep it under ${100 - `vault/${canonical}/`.length} bytes.`);
  }

  return {
    name,
    bytes,
    size: bytes.length,
    mime,
    access,
    canonical,
    sig: createHash("sha1").update(bytes).digest("hex"),
  };
}

/**
 * Collects every hosted file one compile references. `export()` asks it for
 * each placeholder's final value; the deploy path then reads the distinct files
 * for the archive and the expected reference count for the landing check.
 */
export interface HostedFileResolver {
  /** Read and check `ref`, and return the placeholder the archive carries for it. */
  resolve(ref: HostedFile, rules: HostedFileRules): string;
  /** Read and check `ref`, register it, and return the file every reference to it shares. */
  resolveFile(ref: HostedFile, rules: HostedFileRules): ResolvedHostedFile;
  /** Each distinct file, once, in first-reference order. */
  files(): ResolvedHostedFile[];
  /** The payload's file-library rows, one per distinct file. */
  libraryRows(): Record<string, unknown>[];
}

/** A fresh {@link HostedFileResolver} for one compile. */
export function hostedFileResolver(): HostedFileResolver {
  const byCanonical = new Map<string, ResolvedHostedFile>();
  const resolveFile = (ref: HostedFile, rules: HostedFileRules): ResolvedHostedFile => {
    const file = resolveHostedFile(ref, rules);
    const seen = byCanonical.get(file.canonical);
    // Same bytes under two names would be two library rows fighting over one
    // identity; the first name wins, which is what every field then points at.
    // Access is part of the one row both share, so a conflict cannot be merged:
    // a public icon would get a private file, or a private file would ship public.
    if (seen !== undefined && seen.access !== file.access) {
      throw new Error(
        `${rules.field ? `${rules.field}: ` : ""}hostedFile("${ref[HOSTED_FILE].path}") is ${file.access}, but the same file is ` +
          `already used as ${seen.access} (as "${seen.name}"). One file cannot be both — give the ${
            file.access === "private" ? "private" : "public"
          } use its own copy.`,
      );
    }
    if (seen !== undefined) return seen;
    byCanonical.set(file.canonical, file);
    return file;
  };
  return {
    resolve: (ref, rules) => hostedFilePlaceholder(resolveFile(ref, rules)),
    resolveFile,
    files: () => [...byCanonical.values()],
    libraryRows: () => [...byCanonical.values()].map(hostedFileLibraryRow),
  };
}

/** `xanosdk-file://<canonical>/<name>` — what a resolved field holds in the archive. */
export function hostedFilePlaceholder(file: Pick<ResolvedHostedFile, "canonical" | "name">): string {
  return `${HOSTED_FILE_SCHEME}${file.canonical}/${encodeURIComponent(file.name)}`;
}

/** The file-library kind the engine files a mime type under. */
function libraryType(mime: string): string {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "attachment";
}

/**
 * The value a seeded file column holds for `file`: the shape an exported row
 * carries. Only the canonical (fourth segment) and `name` of the path are read
 * — the engine rebuilds the destination's own path from them as it loads the
 * row — so the workspace and signature segments are placeholders.
 */
export function hostedFileColumnValue(file: ResolvedHostedFile): Record<string, unknown> {
  return {
    access: file.access,
    path: `${HOSTED_ROW_PATH_PREFIX}${file.canonical}/_/${encodeURIComponent(file.name)}`,
    name: file.name,
    type: libraryType(file.mime),
    size: file.size,
    mime: file.mime,
    meta: {},
  };
}

/** A file's row in the payload's file library (`vault`). The bytes ride beside it at {@link hostedFileArchivePath}. */
export function hostedFileLibraryRow(file: ResolvedHostedFile): Record<string, unknown> {
  return {
    name: file.name,
    size: file.size,
    type: libraryType(file.mime),
    mime: file.mime,
    canonical: file.canonical,
    // The row's identity on import is its guid, so the content identity doubles
    // as it: re-importing the same file updates its row instead of adding one.
    guid: file.canonical,
    sig: file.sig,
    access: file.access,
    meta: {},
  };
}

/** Where a file's bytes sit in the archive: the file library's `<canonical>/<name>` layout. */
export function hostedFileArchivePath(file: Pick<ResolvedHostedFile, "canonical" | "name">): string {
  return `vault/${file.canonical}/${file.name}`;
}
