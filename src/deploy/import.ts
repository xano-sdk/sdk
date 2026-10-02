/**
 * Shared vocabulary for importing a compiled workspace archive: the import
 * `mode`, the merge knobs, and the HTTP error the import transport throws.
 *
 * The transport itself is {@link ./xanosdk-import.ts} — the SDK's own import
 * route (`POST /api:meta/workspace/{id}/xanosdk/import`). Every import the SDK
 * makes goes there: `deploy` (ephemeral and local engine, `mode=replace`),
 * `deploy --keep-data` (`mode=merge`), `release`, and `preflight`'s disposable
 * environment. The SDK never calls the instance's general-purpose
 * `workspace/{id}/import` route, which is a backup-restore and transfer route
 * that resolves identity collisions by inventing names — see that module's
 * header for why that is wrong for a code deploy.
 *
 * These types live here rather than in the transport so the modules that only
 * need the vocabulary (the release command, the operation-outcome classifier)
 * do not pull the transport in with it.
 */
import { httpFailure } from "../util/http.js";

/**
 * How an import treats what is already in the target workspace.
 *
 * `replace` is the default everywhere, so an omitted mode can never turn a wipe
 * into a silent partial write (or the reverse).
 */
export type ImportMode = "replace" | "merge";

/**
 * The destructive knobs, all defaulting to off.
 *
 * They are only meaningful under `merge` — the server rejects them outright with
 * `replace`, which has already dropped everything they could describe, rather
 * than accepting and ignoring them.
 */
export interface MergeOptions {
  /** Update and add only (default), or also delete objects the archive omits. */
  prune?: boolean;
  /**
   * Write the archive's table rows. Off by default, so a merge cannot touch
   * live data. Note this is an UPSERT — a row whose id collides with a live one
   * is overwritten, so it modifies existing data as well as adding to it.
   */
  records?: boolean;
  /** Empty each imported table before any rows are written. */
  truncate?: boolean;
}

/**
 * An import answered a non-2xx that was not one of the route's structured
 * refusals. Carries the status so a caller can special-case it (the
 * operation-outcome classifier reads it to decide whether anything landed).
 */
export class ImportHttpError extends Error {
  constructor(
    readonly status: number,
    action: string,
    statusText: string,
    readonly body: string,
    /** A line under the status: what a status that is not a refusal means for the write. */
    aftermath?: string,
  ) {
    const head = httpFailure(action, { status, statusText }, body);
    super(aftermath === undefined ? head : `${head}\n${aftermath}`);
    this.name = "ImportHttpError";
  }
}

/**
 * An import the instance refused because the archive's signature does not
 * match its content — an exported bundle edited afterwards. Sent with a 500,
 * yet it is an answer: the same archive is refused every time, so it is never
 * classed as a server error worth a retry.
 */
export function isSignatureRefusal(err: unknown): err is ImportHttpError {
  return err instanceof ImportHttpError && /invalid workspace signature/i.test(err.body);
}
