/**
 * Typed overrides for statement args the engine declares as a CLOSED SET but the
 * codegen ships as a bare `string`.
 *
 * The generated catalog harvests `enum` from the engine's runtime INPUT schemas,
 * so a closed set declared on a `context`-routed field arrives untyped. Both
 * fields here are context-routed, which is why they slipped through: the engine
 * states the members plainly, the SDK's types did not, and a typo type-checked,
 * exported, and deployed before misbehaving on a live environment.
 *
 * `access` is the sharp case. It defaults to `public`, so a misspelled
 * `"private"` does not fail closed — it serves the file to the world. That is
 * the wrong direction to fail in, and it was reachable with no compile-time
 * signal and no documented value list.
 *
 * Same shape as {@link ../special/precondition.ts}: delegate to the codegen'd
 * factory so the encoded statement is byte-identical, and narrow only the
 * authoring type. The member arrays are exported and consumed by the manifest
 * renderer (`CONTEXT_FIELD_ENUMS`), so the shipped types and the rendered
 * catalog line cannot drift from each other.
 */
import type { Statement } from "../statement.js";
import { generated } from "../generated/factories.generated.js";

/**
 * Who can read a file created by the `s.storage.create_*` family.
 *
 * - `public` — world-readable by URL (**the engine's default**).
 * - `private` — reachable only through a signed URL
 *   (`s.storage.sign_private_url`).
 *
 * Mirrors the engine's `access` enum on `mvp:create_attachment`,
 * `mvp:create_audio`, `mvp:create_image` and `mvp:create_video`.
 */
export const STORAGE_ACCESS = ["public", "private"] as const;

export type StorageAccess = (typeof STORAGE_ACCESS)[number];

/**
 * What `s.util.set_header` does when the header it sets is already present.
 *
 * - `replace` — overwrite the existing value (**the engine's default**).
 * - `append` — add another value, keeping the existing one.
 *
 * Mirrors the engine's `duplicates` enum on `mvp:setheader`.
 */
export const HEADER_DUPLICATES = ["replace", "append"] as const;

export type HeaderDuplicates = (typeof HEADER_DUPLICATES)[number];

/**
 * The runtime half of a narrowed field: the type refuses an unknown value, but
 * a call through `any` or untyped JavaScript reaches here with whatever it was
 * given, and the generated factory writes a plain string field as-is — so
 * `duplicates: "bogus"` landed in the bundle. Absent is fine (the default
 * applies); anything else outside the set is refused, naming the factory.
 */
function assertClosed(factory: string, field: string, values: readonly string[], got: unknown): void {
  if (got === undefined || (typeof got === "string" && values.includes(got))) return;
  throw new Error(
    `Statement "${factory}": argument "${field}" accepts only ${values.map((v) => JSON.stringify(v)).join(" | ")} — ` +
      `got ${typeof got === "string" ? JSON.stringify(got) : String(got)}.`,
  );
}

/** Tolerates a missing argument object: the generated factory names what is required. */
function field(a: unknown, key: string): unknown {
  return a !== null && typeof a === "object" ? (a as Record<string, unknown>)[key] : undefined;
}

/** `access` narrowed on a generated `storage.create_*` factory. */
type WithAccess<T> = Omit<T, "access"> & { access?: StorageAccess };

type CreateAttachmentArgs = WithAccess<Parameters<typeof generated.storage.create_attachment>[0]>;
type CreateAudioArgs = WithAccess<Parameters<typeof generated.storage.create_audio>[0]>;
type CreateImageArgs = WithAccess<Parameters<typeof generated.storage.create_image>[0]>;
type CreateVideoArgs = WithAccess<Parameters<typeof generated.storage.create_video>[0]>;

type SetHeaderArgs = Omit<Parameters<typeof generated.util.set_header>[0], "duplicates"> & {
  duplicates?: HeaderDuplicates;
};

/**
 * `create_attachment` — store an uploaded file resource as an attachment.
 *
 * ⚠ `access` defaults to `"public"` (world-readable by URL). Pass
 * `access: "private"` and reach the file through `s.storage.sign_private_url`
 * when it must not be.
 */
export function createAttachment(a: CreateAttachmentArgs): Statement {
  assertClosed("s.storage.create_attachment", "access", STORAGE_ACCESS, field(a, "access"));
  return generated.storage.create_attachment(a);
}

/**
 * `create_audio` — store an uploaded file resource as audio metadata.
 *
 * ⚠ `access` defaults to `"public"` (world-readable by URL).
 */
export function createAudio(a: CreateAudioArgs): Statement {
  assertClosed("s.storage.create_audio", "access", STORAGE_ACCESS, field(a, "access"));
  return generated.storage.create_audio(a);
}

/**
 * `create_image` — store an uploaded file resource as image metadata.
 *
 * ⚠ `access` defaults to `"public"` (world-readable by URL).
 */
export function createImage(a: CreateImageArgs): Statement {
  assertClosed("s.storage.create_image", "access", STORAGE_ACCESS, field(a, "access"));
  return generated.storage.create_image(a);
}

/**
 * `create_video` — store an uploaded file resource as video metadata.
 *
 * ⚠ `access` defaults to `"public"` (world-readable by URL).
 */
export function createVideo(a: CreateVideoArgs): Statement {
  assertClosed("s.storage.create_video", "access", STORAGE_ACCESS, field(a, "access"));
  return generated.storage.create_video(a);
}

/**
 * `set_header` — set a response header. `duplicates` decides what happens when
 * the header is already present: `replace` (the default) overwrites it,
 * `append` adds another value alongside it.
 */
export function setHeader(a: SetHeaderArgs): Statement {
  assertClosed("s.util.set_header", "duplicates", HEADER_DUPLICATES, field(a, "duplicates"));
  return generated.util.set_header(a);
}
