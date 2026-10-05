/**
 * `xanosdk tables [backend]` — a running backend's tables: id, guid, and name.
 *
 * `release create --seed` selects by guid, and a guid appears in no artifact a
 * user holds, so this verb is how one is obtained at all. It was once three
 * copies under `workspace`, `ephemeral` and `tenant`; one verb with the
 * selector grammar covers a Xano Engine too, and bare follows what the project
 * last deployed to — which is the backend whose guids are wanted, since a
 * release is usually cut from the environment a deploy just stood up.
 *
 * Resolved through the tracked-backend resolver, so a gone, expired or
 * unreachable backend reports the way every other command reports it rather
 * than as an empty table list. A credential is fetched only for a hosted kind:
 * a Xano Engine is listed with its own bearer, and `--profile` beside one is
 * refused rather than dropped.
 *
 * Node-only (fetch + OAuth); lazily imported by the dispatcher like its siblings.
 */
import type { ParsedArgs } from "./cli.js";
import { getAccessToken } from "../auth/token.js";
import { requireBackendSlot } from "./backend-slot.js";
import { resolveBackend } from "./tracked-backend.js";
import type { ResolveDeps } from "./source-resolve.js";
import { printTableListing } from "./table-listing.js";

/** Seams the tests replace; production callers pass nothing. */
export interface TablesCommandOptions {
  /** The resolver's seams (hosted lookups, the engine enumeration, where records live). */
  deps?: ResolveDeps;
}

export async function runTablesCommand(args: ParsedArgs, opts: TablesCommandOptions = {}): Promise<void> {
  const slot = requireBackendSlot("tables", undefined, "subject");
  const resolved = await resolveBackend(slot, args.positionals[0], {
    credential: () => getAccessToken(args),
    profile: args.profile,
    ...(opts.deps === undefined ? {} : { deps: opts.deps }),
  });
  await printTableListing(args, resolved);
}
