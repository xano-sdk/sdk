/**
 * Addressing a stored file from a client.
 *
 * A file column comes back as a {@link XanoFileRef}: a `path` into the vault
 * plus metadata, and an absolute, authoritative-looking `url`. On a
 * tenant-scoped environment — which is what `xanosdk deploy` provisions — that
 * `url` addresses the instance host and OMITS the `/tenant/<name>` segment every
 * other URL on that environment carries, so it 404s. The `path` is correct; only
 * the host prefix is wrong.
 *
 * It fails as a broken `<img>` and nothing else: the API response is complete
 * and every assertion about it passes, because the field IS present, with a real
 * `size` and real `meta.width`/`meta.height`. Only fetching the URL reveals it.
 *
 * {@link fileUrl} joins `path` to the base URL the client already has, which is
 * correct on a tenant-scoped environment and on an instance workspace alike.
 * Use it instead of reading `url` directly.
 */
import type { XanoFileRef } from "./value-types.js";

/**
 * The URL to fetch a stored file from, built against the base URL the client is
 * already talking to.
 *
 * ```ts
 * <img src={fileUrl(row.avatar, XANO_HOST) ?? ""} />
 * ```
 *
 * `XANO_HOST` is the backend base URL `xanosdk deploy --static` injects (and
 * `xanosdk sandbox details` prints) — on an ephemeral it already carries the
 * `/tenant/<name>` segment, which is exactly the part the file's own `url` field
 * drops.
 *
 * Returns `null` for an absent file, so it composes with an optional column.
 * Falls back to the file's own `url` only when there is no `path` to join.
 */
export function fileUrl(file: XanoFileRef | null | undefined, baseUrl: string): string | null {
  if (!file) return null;
  if (typeof file.path === "string" && file.path !== "") {
    const base = baseUrl.replace(/\/+$/, "");
    return file.path.startsWith("/") ? base + file.path : `${base}/${file.path}`;
  }
  return typeof file.url === "string" && file.url !== "" ? file.url : null;
}
