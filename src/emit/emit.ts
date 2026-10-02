/**
 * Emit artifacts as strings: a single def's bundle entry or the aggregate
 * workspace bundle from a `Xano` registry. These are pure and browser-safe
 * — the `node:fs` writers live in `./write.js` so importing a def graph never
 * pulls in `fs`.
 */
import { registerAllKinds } from "../kinds/all.js";
import { registerAllStatements } from "../statements/s.js";
import { emitDiagnostic } from "../workspace/diagnostics.js";
import { Xano, standaloneDefKind } from "../workspace/xano.js";
import type { Bundle } from "../workspace/export.js";
import type { HostedFileResolver } from "../workspace/hosted-file.js";

/**
 * Encode one def to the pretty-printed JSON of the entry it becomes in an
 * exported bundle — the same per-kind encoder, guid and export-time fields
 * `export()` writes, so `emit(def)` deep-equals that def's bundle entry for
 * every kind.
 *
 * The kind is the one the def's factory stamped (a query by its `verb`, a group
 * by its `cors`/`swagger`/`canonical`, a table by its `schema`). A def none of
 * those name is refused — encoding it as some default kind would print an
 * artifact of the wrong shape. An empty canonical takes the seeded lock's;
 * `hostedFiles` and `documentationTokens` (scope key → value) fill icons and a
 * group's gate as export fills them. Knowledge bodies are export's.
 * Encoder warnings are raised through the diagnostic sink, as at export.
 */
export function emit(
  def: object,
  opts: { indent?: number; hostedFiles?: HostedFileResolver; documentationTokens?: Record<string, string> } = {},
): string {
  // This copy may encode a def another copy built (a project's own install, a
  // tsconfig path to the source): every kind and statement must be loaded here.
  registerAllKinds();
  registerAllStatements();
  const kind = standaloneDefKind(def);
  if (kind === undefined) {
    const name = (def as { name?: unknown } | null)?.name;
    throw new Error(
      `emit: cannot tell what kind of def${typeof name === "string" ? ` "${name}"` : ""} this is — ` +
        `nothing marks it as a function, table, query, task, tool, agent, …. Build it with its factory ` +
        `(\`defineFunction({...})\`, \`table({...})\`, \`task({...})\`, …) rather than as an object literal or a spread copy.`,
    );
  }
  const { entry, warnings } = new Xano().encodeEntry(kind, def, {
    ...(opts.hostedFiles !== undefined ? { hostedFiles: opts.hostedFiles } : {}),
    ...(opts.documentationTokens !== undefined ? { documentationTokens: opts.documentationTokens } : {}),
  });
  for (const warning of warnings) emitDiagnostic(warning);
  return JSON.stringify(entry, null, opts.indent ?? 2);
}

/** Pretty-print an already-built bundle (the CLI's lock path builds it itself). */
export function serializeBundle(bundle: Bundle, opts: { indent?: number } = {}): string {
  return JSON.stringify(bundle, null, opts.indent ?? 2);
}

/**
 * Pretty-print the aggregate `packageExport` bundle from a `Xano` registry.
 *
 * `opts.strict` fails the build on any warning instead of printing it — the
 * shapes that export clean and then lose data or return the wrong rows (a
 * `bulk.update` zero-filling omitted columns, an `ignoreEmpty` that drops its
 * predicate). Worth setting in CI and in any script whose output nobody reads.
 */
export function emitBundle(
  xano: Xano,
  opts: { indent?: number; strict?: boolean } = {},
): string {
  return serializeBundle(xano.export({ strict: opts.strict }), opts);
}
