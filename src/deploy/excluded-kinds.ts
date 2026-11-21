/**
 * A bundle as a project that excludes some kinds reads it (DEV-10009): the same
 * bundle with those payload sections empty. See `EXCLUDE_FIELD` in
 * `emit/project-config.ts` for the setting.
 *
 * Applied to what the SDK reads (a pull's or generate's source, the target a
 * diff or a release compares against), and to the bundle a compile builds, so a
 * release sends none of the excluded objects and the workspace keeps its own.
 * The signature is left as it was; the compile re-signs what it ships.
 *
 * Pure and browser-safe.
 */
export function withoutKinds<B>(bundle: B, kinds: readonly string[]): B {
  if (kinds.length === 0) return bundle;
  const payload = (bundle as { payload?: unknown } | null)?.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return bundle;
  const next: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const kind of kinds) if (Array.isArray(next[kind])) next[kind] = [];
  return { ...(bundle as object), payload: next } as B;
}
