/**
 * Reading a knowledge item's markdown off disk — the Node half of the kind.
 *
 * A `knowledge()` def names its body and its reference folder by PATH
 * ({@link import("../kinds/knowledge.js").knowledgeFile} /
 * {@link import("../kinds/knowledge.js").knowledgeDir}). The encoder emits an
 * empty `content` and drops the markers, so `export()` stays free of `node:fs`
 * and a frontend build can never pull a knowledge body into a served chunk.
 *
 * This module is where the bytes actually enter, and it runs in the CLI's
 * compile path — which every command that produces a bundle goes through, so a
 * bundle written to disk with `xanosdk export` carries the same bodies a deploy
 * would send. That is the whole reason resolution lives at compile rather than
 * in the deploy command: seed content is a separate archive member and can be
 * built later, but a knowledge body rides INSIDE the payload and has to be there
 * before the bundle is signed.
 */
import type { AnyWarningCode } from "../codes.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, relative, sep } from "node:path";
import { isMissingFile } from "../util/local-file.js";
import { LocalFileNotFoundError } from "../emit/errors.js";
import type { KnowledgeDef } from "../kinds/knowledge.js";
import { KNOWLEDGE_FILE, KNOWLEDGE_DIR, isOsMetadataFile } from "../kinds/knowledge.js";

/** The engine's per-file ceiling for a knowledge reference file. */
export const MAX_KNOWLEDGE_FILE_BYTES = 1024 * 1024;

/** One reference file, as it rides the bundle. */
export interface ResolvedKnowledgeFile {
  /** POSIX path relative to the item's reference directory. */
  path: string;
  content: string;
  size: number;
}

/** One knowledge item's resolved bytes, keyed back to the def by name. */
export interface ResolvedKnowledge {
  name: string;
  content: string;
  files: ResolvedKnowledgeFile[];
  /** Warnings about this item, raised by the export that carries it so its `diagnostics.allow` applies. */
  warnings?: Array<{ code: AnyWarningCode; message: string }>;
}

/**
 * Absolute path for a marker, resolved against the module that declared it.
 *
 * `base` is `import.meta.url` at the call site, so a relative path means
 * "beside the file I am reading", not "beside the CLI's cwd". A base that is
 * already a bare filesystem path (a hand-built marker in a test) is tolerated.
 */
function resolveMarker(ref: { path: string; base: string }): string {
  const base = /^[a-z][a-z0-9+.-]*:/i.test(ref.base) ? ref.base : pathToFileURL(ref.base).href;
  return fileURLToPath(new URL(ref.path, base));
}

/**
 * Decode `bytes` as UTF-8 text, or say why it is not text: a NUL byte (binary
 * that happens to decode as UTF-8), or an invalid UTF-8 sequence. A lossy decode
 * would ship U+FFFD in place of every byte it could not read.
 */
function utf8Text(bytes: Buffer): { text: string } | { problem: "nul" | "encoding" } {
  if (bytes.includes(0)) return { problem: "nul" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { problem: "encoding" };
  }
}

/** Why a file is not text, completing "… is not text: …", with its remedy. */
function notTextReason(problem: "nul" | "encoding", remedy: string): string {
  return problem === "nul"
    ? `it contains a NUL byte, so it is binary content, not text. ${remedy}`
    : `it is not valid UTF-8 (binary, or another encoding). ${remedy} — or, if it is text, re-save it as UTF-8.`;
}

/** Recursively collect regular files under `dir`, POSIX-relative to it. */
function collectRefFiles(
  dir: string,
  itemName: string,
  refsWhere: string,
  warnings: Array<{ code: AnyWarningCode; message: string }>,
): ResolvedKnowledgeFile[] {
  const out: ResolvedKnowledgeFile[] = [];
  const links: string[] = [];
  const walk = (cur: string): void => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      const rel = relative(dir, full).split(sep).join("/");
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // A link is not followed: its target can sit anywhere on the machine.
      if (entry.isSymbolicLink()) {
        links.push(rel);
        continue;
      }
      // Sockets, devices and pipes carry no content to ship.
      if (!entry.isFile()) continue;
      const bytes = readFileSync(full);
      const decoded = utf8Text(bytes);
      if ("problem" in decoded) {
        if (isOsMetadataFile(rel, true)) continue;
        throw new Error(
          `knowledge "${itemName}": reference file "${rel}" under ${refsWhere} cannot ship — a reference file ` +
            `ships as text, and ${notTextReason(decoded.problem, "Move it out of the directory")}`,
        );
      }
      const content = decoded.text;
      const size = bytes.length;
      if (size > MAX_KNOWLEDGE_FILE_BYTES) {
        throw new Error(
          `knowledge "${itemName}": reference file "${rel}" is ${size} bytes, over the ` +
            `${MAX_KNOWLEDGE_FILE_BYTES}-byte limit the engine accepts. Split it, or move the ` +
            `bulk of it somewhere the agent fetches at run time.`,
        );
      }
      out.push({ path: rel, content, size });
    }
  };
  walk(dir);
  if (links.length > 0) {
    links.sort();
    warnings.push({
      code: "knowledge.refs-symlink-skipped",
      message:
        `knowledge "${itemName}": ${refsWhere} contains ${links.map((l) => `"${l}"`).join(", ")}, ` +
        `${links.length === 1 ? "a symbolic link" : "symbolic links"}, which ${links.length === 1 ? "does" : "do"} not ` +
        `ship — a link is not followed. Copy the file it points at into the directory to ship it.`,
    });
  }
  // Sorted so a bundle is byte-identical across runs regardless of readdir order.
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * Read every registered knowledge item's markdown.
 *
 * Synchronous, matching the seed reader: the compile path is already
 * synchronous here and an async read buys nothing.
 *
 * Errors name the path AS AUTHORED (`knowledgeFile("./x.md")`) rather than the
 * absolute path it resolved to — the author never typed the latter, and an
 * absolute path in the message sends them looking in the wrong place.
 */
export function resolveKnowledge(defs: readonly KnowledgeDef[]): ResolvedKnowledge[] {
  const resolved: ResolvedKnowledge[] = [];
  for (const def of defs) {
    const bodyRef = def.body[KNOWLEDGE_FILE];
    const where = `knowledgeFile("${bodyRef.path}")`;
    let content: string;
    try {
      const abs = resolveMarker(bodyRef);
      if (statSync(abs).isDirectory()) {
        throw new Error(
          `knowledge "${def.name}": ${where} points at a DIRECTORY. A body is one markdown ` +
            `file; use \`refs: knowledgeDir(...)\` for a folder of reference files.`,
        );
      }
      const decoded = utf8Text(readFileSync(abs));
      if ("problem" in decoded) {
        throw new Error(
          `knowledge "${def.name}": ${where} cannot ship — a body ships as text, and ` +
            notTextReason(decoded.problem, "Point the body at a markdown file"),
        );
      }
      content = decoded.text;
    } catch (err) {
      if (err instanceof Error && /points at a DIRECTORY|cannot ship — a body ships as text/.test(err.message)) throw err;
      throw new (isMissingFile(err) ? LocalFileNotFoundError : Error)(
        `knowledge "${def.name}": cannot read ${where} — ${(err as Error).message}. The path ` +
          `resolves relative to the module that declares the item (its \`import.meta.url\`).`,
      );
    }

    let files: ResolvedKnowledgeFile[] = [];
    const warnings: Array<{ code: AnyWarningCode; message: string }> = [];
    if (def.refs !== undefined) {
      const refsRef = def.refs[KNOWLEDGE_DIR];
      const refsWhere = `knowledgeDir("${refsRef.path}")`;
      const abs = resolveMarker(refsRef);
      try {
        if (!statSync(abs).isDirectory()) {
          throw new Error(
            `knowledge "${def.name}": ${refsWhere} is not a directory. Reference files are a ` +
              `FOLDER the agent searches; a single file belongs in the body.`,
          );
        }
      } catch (err) {
        if (err instanceof Error && /is not a directory/.test(err.message)) throw err;
        throw new (isMissingFile(err) ? LocalFileNotFoundError : Error)(
          `knowledge "${def.name}": cannot read ${refsWhere} — ${(err as Error).message}.`,
        );
      }
      files = collectRefFiles(abs, def.name, refsWhere, warnings);
      // The body and the module declaring the item, found under the refs
      // directory, ship as reference files like anything else there.
      const own = new Map<string, string>([[resolveMarker(bodyRef), where]]);
      for (const base of [bodyRef.base, refsRef.base]) {
        const module = base.startsWith("file:") ? fileURLToPath(base) : /^[a-z][a-z0-9+.-]*:/i.test(base) ? undefined : base;
        if (module !== undefined) own.set(module, "the module that declares it");
      }
      // Any other source file too: a helper module beside the declaring one
      // ships as a reference file just the same.
      const shipped = files
        .map((f) => ({
          rel: f.path,
          what:
            own.get(join(abs, ...f.path.split("/"))) ??
            (/\.[cm]?[jt]sx?$/i.test(f.path) ? "a source file" : undefined),
        }))
        .filter((f) => f.what !== undefined);
      if (shipped.length > 0) {
        warnings.push({
          code: "knowledge.refs-include-source",
          message:
            `knowledge "${def.name}": ${refsWhere} contains ${shipped.map((f) => `"${f.rel}" (${f.what})`).join(", ")}, ` +
            `which ${shipped.length === 1 ? "ships" : "ship"} as ${shipped.length === 1 ? "a reference file" : "reference files"} — ` +
            `everything under the directory is collected. Move ${shipped.length === 1 ? "it" : "them"} out of it, ` +
            `or point \`refs\` at a subdirectory (\`knowledgeDir("./refs", import.meta.url)\`).`,
        });
      }
    }

    resolved.push({ name: def.name, content, files, ...(warnings.length > 0 ? { warnings } : {}) });
  }
  return resolved;
}
