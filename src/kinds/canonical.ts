/**
 * Shared `canonical` resolution for the kinds that carry a mintable public URL
 * token (toolsets, realtime servers — see `CANONICAL_PAYLOAD_KEYS`).
 *
 * The rule is identical for all of them and is worth stating once: an explicit
 * override wins, then the def's own non-empty `canonical`, then the value
 * minted-and-frozen in `xano.lock` under `<payloadKey>:<name>`.
 *
 * It deliberately never mints. A canonical must be unique per Xano *instance
 * across all workspaces*, so the only safe place to generate one is
 * an ordinary `xanosdk export` — random, collision-checked, then frozen so every later export
 * and every client agree on the same token.
 */
import { lockKey } from "../lock/lock.js";
import { getLockedCanonical } from "../lock/store.js";

/**
 * Resolve a canonical, or throw with the fix. `label` names the kind in the
 * error ("toolset", "realtime server"); `payloadKey` is the lock-key prefix;
 * `accessor` is the escape-hatch call shown in the message.
 */
export function resolveCanonicalToken(
  label: string,
  payloadKey: string,
  accessor: string,
  def: { name: string; canonical?: string },
  override?: string,
): string {
  if (override) return override;
  if (typeof def.canonical === "string" && def.canonical !== "") return def.canonical;
  const locked = getLockedCanonical(lockKey(payloadKey, def.name));
  if (locked) return locked;
  throw new Error(
    `${label} "${def.name}": cannot resolve the \`canonical\` URL token. ` +
      `Set an explicit \`canonical\` in code, or run \`xanosdk export <entry>\` once (it ` +
      `mints a unique canonical and freezes it in xano.lock) and seed that lock before ` +
      `importing defs — the CLI does this automatically. As a last resort pass one ` +
      `directly (e.g. \`${accessor}({ canonical: "..." })\`). (Minting here is unsafe — ` +
      `canonicals must be unique per instance across all workspaces, so they are only ` +
      `generated at locked export.)`,
  );
}
