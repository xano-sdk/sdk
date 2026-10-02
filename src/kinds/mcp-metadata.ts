/**
 * MCP metadata shared by the three primitives an MCP server exposes — `tool`,
 * `prompt` and `resource`: display `title`, `icons`, the tool behavior
 * `annotations`, the resource `annotations`, and the resource URI template.
 *
 * Every value here is validated at export with the platform's own rules,
 * because the platform refuses the same values at push. Catching them here
 * names the def and the field instead of failing a deploy.
 *
 * Every field is omitted from the stored object at its default, so a tool that
 * sets none of them keeps exactly the bytes it had before they existed.
 */
import { refuseUnknown } from "./def-keys.js";
import { HOSTED_FILE_SCHEME, isHostedFile, pendingHostedSrc, type HostedFile } from "../fields/hosted-file.js";

// ---------- icons ----------

/** Raster types an icon may be. SVG is refused: it can carry script. */
export type McpIconMimeType = "image/png" | "image/jpeg" | "image/webp";

/**
 * One icon a client may show next to the tool, prompt or resource.
 *
 * `src` is an `https:` URL (≤ 2048 chars), a base64 `data:` URI of a PNG,
 * JPEG or WebP image (≤ 64 KiB decoded), or a file in your repo:
 * `src: hostedFile("./icon.png", import.meta.url)` ships the file with the
 * release and serves it from each backend it lands on. A `/vault/…` path (what
 * a pull reads such an icon back as) is kept as it is, and serves only on the
 * backend it was read from: to ship the icon anywhere else, put the file in
 * the repo and use `hostedFile()`. Nothing else is
 * accepted — not `http:`, not SVG. The server never fetches it; clients do.
 */
export interface McpIcon {
  src: string | HostedFile;
  mimeType?: McpIconMimeType;
  /** `"48x48"`-style sizes, or `"any"` for a scalable image. */
  sizes?: string[];
  /** The UI theme this icon is drawn for. */
  theme?: "light" | "dark";
}

/** Stored icon: every member present, unset ones as `null`/`[]`. */
export interface McpIconXdo {
  src: string;
  mime_type: string | null;
  sizes: string[];
  theme: string | null;
}

const ICON_KEYS = ["src", "mimeType", "sizes", "theme"] satisfies (keyof McpIcon)[];
const ICON_MIME_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
const ICON_DATA_MAX_BYTES = 65536;
const ICON_URL_MAX_LENGTH = 2048;

/** Why an icon `src` is refused, or `undefined`. */
function iconSrcProblem(src: string): string | undefined {
  const lower = src.toLowerCase();
  // A hosted-file placeholder read back out of a bundle: the archive's own
  // form, which the destination resolves on landing or refuses.
  if (src.startsWith(HOSTED_FILE_SCHEME)) {
    return /^xanosdk-file:\/\/[^/\s]+\/[^/\s]+$/.test(src) ? undefined : "a xanosdk-file: src must be xanosdk-file://<canonical>/<name>";
  }
  // A file in the workspace's own library, as a pull reads a hostedFile() icon
  // back: the served path, made absolute by the MCP server per request.
  if (/^\/vault\/[^/\s]+\/[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(src)) {
    return src.length > ICON_URL_MAX_LENGTH ? `src is longer than ${ICON_URL_MAX_LENGTH} characters` : undefined;
  }
  if (lower.startsWith("https://")) {
    if (src.length > ICON_URL_MAX_LENGTH) return `src is longer than ${ICON_URL_MAX_LENGTH} characters`;
    let host = "";
    try {
      host = new URL(src).host;
    } catch {
      // Falls through to the "not a valid https URL" answer below.
    }
    if (host === "" || /\s/.test(src)) return "src is not a valid https URL";
    return undefined;
  }
  if (lower.startsWith("data:")) {
    const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(src);
    if (!m) return "a data: src must be base64 image data (data:image/png;base64,…)";
    const mime = (m[1] as string).toLowerCase();
    if (!ICON_MIME_TYPES.includes(mime)) {
      return `a data: src must be ${ICON_MIME_TYPES.join(", ")} — got "${mime}" (SVG is refused: it can carry script)`;
    }
    const payload = m[2] as string;
    if (payload === "") return "a data: src must be base64 image data (data:image/png;base64,…)";
    // Decoded length from the encoded one, without allocating the bytes.
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    if ((payload.length / 4) * 3 - padding > ICON_DATA_MAX_BYTES) {
      return `a data: src is larger than ${ICON_DATA_MAX_BYTES} bytes`;
    }
    return undefined;
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(src)?.[1] ?? src.slice(0, 20);
  return `src must be https: or a data: image — got "${scheme}"`;
}

/** Validate and encode an icon list. Omitted/empty → `undefined` (the key is not written). */
export function encodeIcons(owner: string, icons: readonly McpIcon[] | undefined): McpIconXdo[] | undefined {
  if (icons === undefined || icons.length === 0) return undefined;
  if (!Array.isArray(icons)) throw new Error(`${owner} \`icons\`: expected a list of { src, mimeType?, sizes?, theme? }.`);
  return icons.map((icon, i) => {
    const at = `${owner} \`icons[${i}]\``;
    if (icon === null || typeof icon !== "object") throw new Error(`${at}: expected { src, mimeType?, sizes?, theme? }.`);
    refuseUnknown(at, icon, ICON_KEYS);
    const hosted = isHostedFile(icon.src) ? icon.src : undefined;
    if (hosted === undefined) {
      if (typeof icon.src !== "string" || icon.src.trim() === "") throw new Error(`${at}: an icon needs a \`src\`.`);
      const srcProblem = iconSrcProblem(icon.src);
      if (srcProblem) throw new Error(`${at}: ${srcProblem}.`);
    }
    if (icon.mimeType !== undefined && !ICON_MIME_TYPES.includes(String(icon.mimeType).toLowerCase())) {
      throw new Error(`${at}: \`mimeType\` must be one of ${ICON_MIME_TYPES.join(", ")} — got "${String(icon.mimeType)}".`);
    }
    for (const size of icon.sizes ?? []) {
      if (typeof size !== "string" || !/^(\d{1,5}x\d{1,5}|any)$/.test(size)) {
        throw new Error(`${at}: each of \`sizes\` must be "WxH" (e.g. "48x48") or "any" — got ${JSON.stringify(size)}.`);
      }
    }
    if (icon.theme !== undefined && icon.theme !== "light" && icon.theme !== "dark") {
      throw new Error(`${at}: \`theme\` must be "light" or "dark" — got ${JSON.stringify(icon.theme)}.`);
    }
    const out: McpIconXdo = {
      src: "",
      mime_type: icon.mimeType ?? null,
      sizes: [...(icon.sizes ?? [])],
      theme: icon.theme ?? null,
    };
    // A hosted file's bytes are read on the deploy path; the type and access
    // rules travel with the placeholder so they are checked there.
    out.src = hosted === undefined
      ? (icon.src as string)
      : pendingHostedSrc(out, hosted, {
          field: at,
          allowedMimes: ICON_MIME_TYPES,
          requirePublic: true,
          ...(icon.mimeType !== undefined ? { declaredMime: String(icon.mimeType).toLowerCase() } : {}),
        });
    return out;
  });
}

/** Encode a display `title`. Empty/omitted → `undefined` (the key is not written). */
export function encodeTitle(owner: string, title: string | undefined): string | undefined {
  if (title === undefined || title === "") return undefined;
  if (typeof title !== "string") throw new Error(`${owner} \`title\`: expected a string.`);
  return title;
}

// ---------- tool annotations ----------

/**
 * Hints about how a tool behaves, sent to MCP clients in `tools/list`. They are
 * hints — a client decides what to do with them (for example, whether to ask
 * the user before calling). They never change what the tool does.
 *
 * An unset hint is left for the platform to derive from the tool; setting one
 * overrides that.
 */
export interface ToolAnnotations {
  /** The tool does not modify anything. */
  readOnlyHint?: boolean;
  /** The tool may delete or overwrite data (meaningful when not read-only). */
  destructiveHint?: boolean;
  /** Calling it again with the same arguments has no further effect. */
  idempotentHint?: boolean;
  /** The tool reaches systems outside this workspace (the web, a third-party API). */
  openWorldHint?: boolean;
}

export interface ToolAnnotationsXdo {
  read_only_hint: boolean | null;
  destructive_hint: boolean | null;
  idempotent_hint: boolean | null;
  open_world_hint: boolean | null;
}

/** Authored hint → its stored key. The decoder inverts this same table. */
export const TOOL_ANNOTATION_WIRE = {
  readOnlyHint: "read_only_hint",
  destructiveHint: "destructive_hint",
  idempotentHint: "idempotent_hint",
  openWorldHint: "open_world_hint",
} as const satisfies Record<keyof ToolAnnotations, keyof ToolAnnotationsXdo>;

/** Encode tool annotations. None set → `undefined` (the key is not written). */
export function encodeToolAnnotations(
  owner: string,
  annotations: ToolAnnotations | undefined,
): ToolAnnotationsXdo | undefined {
  if (annotations === undefined) return undefined;
  const at = `${owner} \`annotations\``;
  if (annotations === null || typeof annotations !== "object") throw new Error(`${at}: expected an object of boolean hints.`);
  refuseUnknown(at, annotations, Object.keys(TOOL_ANNOTATION_WIRE));
  const out: ToolAnnotationsXdo = {
    read_only_hint: null,
    destructive_hint: null,
    idempotent_hint: null,
    open_world_hint: null,
  };
  let any = false;
  for (const [key, wire] of Object.entries(TOOL_ANNOTATION_WIRE) as [keyof ToolAnnotations, keyof ToolAnnotationsXdo][]) {
    const value = annotations[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new Error(`${at}: \`${key}\` must be true or false — got ${JSON.stringify(value)}.`);
    out[wire] = value;
    any = true;
  }
  return any ? out : undefined;
}

// ---------- resource annotations ----------

/** Hints about a resource's contents, sent to MCP clients in `resources/list`. */
export interface ResourceAnnotations {
  /** Who the contents are meant for. */
  audience?: Array<"user" | "assistant">;
  /** How important the resource is, from 0 (least) to 1 (most). */
  priority?: number;
  /** When the contents last changed, as an ISO 8601 date (`"2025-01-12T15:00:58Z"`). */
  lastModified?: string;
}

export interface ResourceAnnotationsXdo {
  audience: string[];
  priority: number | null;
  last_modified: string | null;
}

const RESOURCE_ANNOTATION_KEYS = ["audience", "priority", "lastModified"] satisfies (keyof ResourceAnnotations)[];
const ISO_8601 = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Encode resource annotations. None set → `undefined` (the key is not written). */
export function encodeResourceAnnotations(
  owner: string,
  annotations: ResourceAnnotations | undefined,
): ResourceAnnotationsXdo | undefined {
  if (annotations === undefined) return undefined;
  const at = `${owner} \`annotations\``;
  if (annotations === null || typeof annotations !== "object") throw new Error(`${at}: expected { audience?, priority?, lastModified? }.`);
  refuseUnknown(at, annotations, RESOURCE_ANNOTATION_KEYS);
  const audience = annotations.audience ?? [];
  for (const who of audience) {
    if (who !== "user" && who !== "assistant") {
      throw new Error(`${at}: \`audience\` entries must be "user" or "assistant" — got ${JSON.stringify(who)}.`);
    }
  }
  const { priority, lastModified } = annotations;
  if (priority !== undefined && (typeof priority !== "number" || !Number.isFinite(priority) || priority < 0 || priority > 1)) {
    throw new Error(`${at}: \`priority\` must be a number from 0 to 1 — got ${JSON.stringify(priority)}.`);
  }
  if (lastModified !== undefined && (typeof lastModified !== "string" || !ISO_8601.test(lastModified) || Number.isNaN(Date.parse(lastModified)))) {
    throw new Error(
      `${at}: \`lastModified\` must be an ISO 8601 date, e.g. "2025-01-12T15:00:58Z" — got ${JSON.stringify(lastModified)}.`,
    );
  }
  if (audience.length === 0 && priority === undefined && lastModified === undefined) return undefined;
  return { audience: [...audience], priority: priority ?? null, last_modified: lastModified ?? null };
}

// ---------- resource uri ----------

/** Input types a URI template variable may be. Each is read from one path segment of the URI. */
export const RESOURCE_VARIABLE_TYPES: readonly string[] = ["text", "int", "decimal", "bool", "enum", "email", "uuid"];

/**
 * Parse a resource URI: a literal (`docs://readme`) or an RFC 6570 level-1
 * template (`orders://{region}/{order_id}`). Returns the template variables in
 * order (`[]` for a literal). Throws on anything the platform refuses.
 */
export function parseResourceUri(owner: string, uri: string): string[] {
  const at = `${owner} \`uri\``;
  if (typeof uri !== "string" || uri === "") throw new Error(`${at}: a resource needs a uri (e.g. "docs://readme").`);
  if (uri.length > 2048) throw new Error(`${at}: is longer than 2048 characters.`);
  // Whitespace or a control character: neither can appear in a URI.
  if ([...uri].some((ch) => /\s/.test(ch) || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) throw new Error(`${at}: "${uri}" must not contain whitespace.`);
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) throw new Error(`${at}: "${uri}" must start with a scheme, e.g. docs://readme.`);
  const variables: string[] = [];
  let lastClose = -2;
  for (let i = 0; i < uri.length; i++) {
    const ch = uri[i];
    if (ch === "}") throw new Error(`${at}: "${uri}" has a "}" with no matching "{".`);
    if (ch !== "{") continue;
    const close = uri.indexOf("}", i + 1);
    if (close === -1) throw new Error(`${at}: "${uri}" has an unclosed "{".`);
    const expression = uri.slice(i + 1, close);
    if (expression.includes("{")) throw new Error(`${at}: "${uri}" has an unclosed "{".`);
    if (expression === "") throw new Error(`${at}: "${uri}" has an empty "{}".`);
    if ("+#./;?&=,!@|".includes(expression[0] as string)) {
      throw new Error(`${at}: "{${expression}}" uses an operator; only level-1 {name} variables are supported.`);
    }
    if (expression.includes(",")) throw new Error(`${at}: "{${expression}}" lists several variables; use one {name} per variable.`);
    if (expression.includes("*") || expression.includes(":")) {
      throw new Error(`${at}: "{${expression}}" uses a modifier; only level-1 {name} variables are supported.`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(expression)) throw new Error(`${at}: variable "${expression}" must be letters, digits and _.`);
    if (variables.includes(expression)) throw new Error(`${at}: variable "${expression}" appears more than once.`);
    if (lastClose === i - 1) throw new Error(`${at}: "${uri}" has two adjacent variables, which cannot be told apart.`);
    variables.push(expression);
    lastClose = close;
    i = close;
  }
  return variables;
}

/**
 * A resource's `input` must be exactly its URI template's variables: each
 * variable declared once as a single scalar, and nothing else. A literal URI
 * takes no input at all. Reads the ENCODED inputs, where a list is explicit.
 */
export function assertResourceInput(
  owner: string,
  uri: string,
  input: ReadonlyArray<{ name: string; type: string; style?: { type?: string } }>,
): void {
  const variables = parseResourceUri(owner, uri);
  const fields = new Map(input.map((field) => [field.name, field]));
  for (const variable of variables) {
    const field = fields.get(variable);
    if (field === undefined) {
      throw new Error(
        `${owner}: uri variable "${variable}" must be declared in \`input\` (e.g. \`input: { ${variable}: input.text() }\`).`,
      );
    }
    if (!RESOURCE_VARIABLE_TYPES.includes(field.type)) {
      throw new Error(
        `${owner}: uri variable "${variable}" must be one of ${RESOURCE_VARIABLE_TYPES.join(", ")} — got "${field.type}".`,
      );
    }
    if (field.style?.type === "list") throw new Error(`${owner}: uri variable "${variable}" must be a single value, not a list.`);
  }
  for (const name of fields.keys()) {
    if (variables.includes(name)) continue;
    throw new Error(
      variables.length === 0
        ? `${owner}: input "${name}" cannot be set — a static resource has no inputs. Use a uri template ("…/{${name}}") to take one.`
        : `${owner}: input "${name}" is not a variable of the uri "${uri}". A resource's input is exactly its uri template's variables.`,
    );
  }
}
