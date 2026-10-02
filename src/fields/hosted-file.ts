/**
 * A file in your repo that is served from wherever the release lands.
 *
 * ```ts
 * icons: [{ src: hostedFile("./icon.png", import.meta.url) }]
 * ```
 *
 * The address is not known when you build: each backend (local engine,
 * ephemeral, tenant, workspace) serves the file at its own URL, so the field
 * holds that backend's address after the release lands. Files are public unless
 * you pass `{ access: "private" }`, and a field that a client fetches unauthenticated
 * (an icon) refuses a private one at build time.
 *
 * Not `seedFile`: that reads table ROWS from a JSON file. This ships a file's
 * bytes. This module holds only the marker, so it is safe in a browser bundle;
 * the bytes are read on the deploy path and never here.
 */

import type { UrlLike } from "../util/web-globals.js";

/** Brand for {@link hostedFile}'s marker, so the deploy path can recognise it structurally. */
export const HOSTED_FILE: unique symbol = Symbol.for("xanosdk.hosted.file") as never;

/** Who may fetch the file. `public` is the default. */
export type HostedFileAccess = "public" | "private";

/** A repo file to host — see {@link hostedFile}. Inert: it holds a path, never bytes. */
export interface HostedFile {
  readonly [HOSTED_FILE]: { readonly path: string; readonly base: string; readonly access: HostedFileAccess };
}

/**
 * Point a field at a file in your repo.
 *
 * @param path - Relative to `base`, like `seedFile`.
 * @param base - The declaring module's `import.meta.url`.
 * @param opts - `access: "private"` keeps the file off the public URL.
 */
export function hostedFile(
  path: string,
  base: string | UrlLike,
  opts: { access?: HostedFileAccess } = {},
): HostedFile {
  return {
    [HOSTED_FILE]: { path, base: typeof base === "string" ? base : base.href, access: opts.access ?? "public" },
  };
}

/** Whether a value is a {@link hostedFile} marker. */
export function isHostedFile(value: unknown): value is HostedFile {
  return typeof value === "object" && value !== null && HOSTED_FILE in value;
}

/**
 * Prefix of a string field that names a hosted file rather than holding a URL.
 * After a deploy compile it reads `xanosdk-file://<canonical>/<name>`; the
 * instance replaces it with the destination's own address as the archive
 * lands, and writes it back on export.
 */
export const HOSTED_FILE_SCHEME = "xanosdk-file://";

/**
 * Whether a file-library (`vault`) row is guarded material. A public file is
 * served to anyone holding its URL, so only a non-public one — a row with no
 * `access` included — needs keeping out of a committed file.
 */
export function isPrivateLibraryRow(row: unknown): boolean {
  return !(typeof row === "object" && row !== null && (row as { access?: unknown }).access === "public");
}

/** The payload sections whose `icons[].src` may hold a hosted-file placeholder. */
export const HOSTED_ICON_KINDS = ["tool", "prompt", "resource"] as const;

/**
 * The `<kind> "<name>"` of every object in `payload` whose icon names a hosted
 * file by placeholder — the references a bundle written without its files
 * cannot satisfy.
 */
export function hostedIconOwners(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const kind of HOSTED_ICON_KINDS) {
    const rows = payload[kind];
    if (!Array.isArray(rows)) continue;
    for (const row of rows as { name?: unknown; icons?: unknown }[]) {
      const icons = row !== null && typeof row === "object" && Array.isArray(row.icons) ? row.icons : [];
      const hosted = icons.some(
        (icon: unknown) =>
          typeof icon === "object" && icon !== null && String((icon as { src?: unknown }).src).startsWith(HOSTED_FILE_SCHEME),
      );
      if (hosted) out.push(`${kind} "${String(row.name ?? "")}"`);
    }
  }
  return out;
}

/**
 * Every icon in `payload` whose `src` is a `xanosdk-file://<canonical>/<name>`
 * placeholder naming a file outside `carried` — a placeholder copied into source
 * out of a bundle, which no compile can ship bytes for.
 */
export function uncarriedHostedIcons(
  payload: Record<string, unknown>,
  carried: ReadonlySet<string>,
): { owner: string; index: number; src: string; name: string }[] {
  const out: { owner: string; index: number; src: string; name: string }[] = [];
  for (const kind of HOSTED_ICON_KINDS) {
    const rows = payload[kind];
    if (!Array.isArray(rows)) continue;
    for (const row of rows as { name?: unknown; icons?: unknown }[]) {
      const icons = row !== null && typeof row === "object" && Array.isArray(row.icons) ? row.icons : [];
      icons.forEach((icon: unknown, index: number) => {
        const src = typeof icon === "object" && icon !== null ? (icon as { src?: unknown }).src : undefined;
        if (typeof src !== "string" || !src.startsWith(HOSTED_FILE_SCHEME)) return;
        const [canonical = "", file = ""] = src.slice(HOSTED_FILE_SCHEME.length).split("/");
        if (carried.has(canonical)) return;
        let name = file;
        try {
          name = decodeURIComponent(file);
        } catch {
          // Kept as written.
        }
        out.push({ owner: `${kind} "${String(row.name ?? "")}"`, index, src, name });
      });
    }
  }
  return out;
}

/**
 * How a seeded row's file column names a hosted file in the archive:
 * `/vault/_/<canonical>/_/<name>`. The workspace and signature segments are
 * placeholders the destination rebuilds as it loads the row.
 */
export const HOSTED_ROW_PATH_PREFIX = "/vault/_/";

/** What a field requires of a file. Checked when the bytes are read, on the deploy path. */
export interface HostedFileRules {
  /** Where the reference was written, for messages (`tool "x" \`icons[0]\``). */
  field?: string;
  /** Mime types the field accepts; anything else is refused. */
  allowedMimes?: readonly string[];
  /** The top-level kind the field holds (`image` accepts any `image/*`). */
  mimeKind?: "image" | "video" | "audio";
  /** The field is fetched with no credentials, so the file must be public. */
  requirePublic?: boolean;
  /** The mime type the field declares beside the file (an icon's `mimeType`); it must be the file's. */
  declaredMime?: string;
}

/**
 * Encoded objects that still hold a pending placeholder, keyed by identity. An
 * encoder runs when a def is registered, long before the Node compile path can
 * read the bytes, so it records which marker the placeholder stands for and
 * `export()` fills it in before signing.
 */
const pending = new WeakMap<object, { ref: HostedFile; rules: HostedFileRules }>();

/**
 * The placeholder an encoder writes for `ref`, remembered against `holder` (the
 * encoded object whose `src` it is). Carries only the file's own name, never its
 * path, so an unresolved `export()` leaks nothing about the author's machine.
 */
export function pendingHostedSrc(holder: object, ref: HostedFile, rules: HostedFileRules): string {
  pending.set(holder, { ref, rules });
  const name = ref[HOSTED_FILE].path.split(/[\\/]/).pop() ?? "";
  return `${HOSTED_FILE_SCHEME}pending/${encodeURIComponent(name)}`;
}

/** The marker behind an encoded object's placeholder, if it still has one. */
export function pendingHostedFile(holder: object): { ref: HostedFile; rules: HostedFileRules } | undefined {
  return pending.get(holder);
}
