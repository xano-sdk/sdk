/**
 * Statement versions the platform has retired.
 *
 * A handful of statements are VERSIONED by suffix — `…_encode`, `…_encode2`,
 * `…_encode3`. Only the highest number is offered when you add a statement; the
 * earlier ones still run, because existing stacks contain them, but each new
 * version was a BREAKING change to the one before it. They are history, not
 * choices.
 *
 * So this SDK models the latest of each family and nothing else. The rest are
 * listed here and carried through `raw()` — byte-exact, readable enough to see
 * what a pulled workspace contains, and reported with the version that replaces
 * them. They are deliberately absent from the authoring catalog
 * (`STATEMENT_SURFACES`), which is what keeps them out of the agent-grounding
 * manifest: an AI reading this SDK is never offered a retired spelling.
 *
 * **Adding a version to a family means adding the previous one here**, or the
 * SDK will keep offering a spelling the platform has moved past.
 *
 * The value is the stored name that supersedes each key, or `""` for a statement
 * that was retired outright with nothing taking its place.
 */
export const SUPERSEDED_STATEMENTS: ReadonlyMap<string, string> = new Map([
  // Four crypto families, each phased forward with breaking changes between
  // versions. The engine still registers a class for every one of them.
  ["mvp:crypto_jwe_decode", "mvp:crypto_jwe_decode2"],
  ["mvp:crypto_jwe_encode", "mvp:crypto_jwe_encode3"],
  ["mvp:crypto_jwe_encode2", "mvp:crypto_jwe_encode3"],
  ["mvp:crypto_jws_decode", "mvp:crypto_jws_decode2"],
  ["mvp:crypto_jws_encode", "mvp:crypto_jws_encode2"],
  // Retired outright — an old third-party log connector with no successor.
  ["mvp:connect_ncscale_send_log", ""],
]);

/**
 * The public surface that replaces a superseded statement, for the report line.
 * Falls back to the stored name when the successor has no authoring surface of
 * its own, and returns null for a statement retired with no replacement.
 */
export function supersededBy(
  storedName: string,
  surfaceOf: (stored: string) => string | undefined,
): string | null {
  const successor = SUPERSEDED_STATEMENTS.get(storedName);
  if (successor === undefined || successor === "") return null;
  return surfaceOf(successor) ?? successor;
}
