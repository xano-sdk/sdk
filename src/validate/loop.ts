/**
 * The `xanosdk preflight` loop: import a compiled JSON bundle into a live
 * instance, then read each authored object back and diff it against what we
 * compiled. Acceptance of the real import proves the import; the per-object
 * JSON diff proves round-trip parity.
 *
 * Pure orchestration: it takes an already-serialized bundle and a client, so it
 * carries no file IO or module loading and is unit-testable with a fake client.
 * Round-trip parity is checked for every registered kind (see `./kinds.ts`):
 * tables (`dbo`), functions, queries, triggers, and the rest. A registered kind
 * the export does not surface as a populated top-level array (e.g. `tool`,
 * nested under `toolset`) is demoted to present-but-unchecked rather than
 * emitting a false per-object `missing`.
 */
import { normalize } from "./normalize.js";
import { ROUND_TRIP_KINDS, identityMatcher, kindIsRunnable } from "./kinds.js";
import { payloadGuidRemap, remapGuids } from "./guid-remap.js";
import { rowLabeler, sectionKind } from "../deploy/live-diff.js";
import type { ImportResult } from "./meta-client.js";

/** The client surface the loop needs (satisfied structurally by MetaClient). */
export interface LoopClient {
  importBundle(bundle: string): Promise<ImportResult>;
  exportWorkspace(workspaceId: number): Promise<{ payload: Record<string, unknown> }>;
  /** The engine's own rendering of the workspace; only needed for `includeEngineRendering`. */
  exportMultidoc?(workspaceId: number): Promise<string>;
}

export interface ValidateLoopOptions {
  /**
   * Also fetch the engine's own rendering of the imported workspace, and carry
   * both payloads out unrendered, for a caller that wants to compare them.
   *
   * Named for what it DOES rather than for who asks: the validation loop has no
   * business knowing the word "plugin". The SDK's job is the FETCH alone —
   * `exportMultidoc` is a generic engine route that is not reachable from any
   * published subpath, so an outside caller could not make it itself. Every
   * derivation past that point belongs to whoever asked.
   */
  includeEngineRendering?: boolean;
}


/** One leaf-level mismatch between compiled and fetched, after normalization. */
export interface DiffLine {
  path: string;
  expected: unknown;
  actual: unknown;
}

/** Round-trip outcome for a single authored object. */
export interface RoundTripEntry {
  /** Payload kind the object belongs to (e.g. "dbo", "function"). */
  kind: string;
  /** The SDK kind the object was authored as (`table`, `apiGroup`, ...): what a report prints. */
  sdkKind: string;
  name: string;
  /**
   * The object as every report names it: `<sdkKind>:<name>`, and for a query
   * its verb and group too (`query:GET ping (apiGroup shop)`).
   */
  label: string;
  status: "match" | "diff" | "missing" | "ambiguous";
  diffs: DiffLine[];
  /** The persisted JSON read back (kept for --capture); undefined when missing. */
  fetched: unknown;
}

/** Full result of one validate run. */
export interface ValidateResult {
  /** Did the engine accept the import? */
  accepted: boolean;
  /** The engine's rejection message when `accepted` is false. */
  importError?: string;
  /** The imported workspace id (target for round-trip reads). */
  workspaceId: number | undefined;
  /** Per-function round-trip parity. */
  roundTrip: RoundTripEntry[];
  /** Imported kinds present in the bundle that the loop did not round-trip. */
  unchecked: Array<{ kind: string; count: number }>;
  /**
   * Present when `includeEngineRendering` asked for it: the engine's own
   * rendering (or why it is unavailable) plus both payloads, unrendered. The
   * loop holds no rendering knowledge about any of it.
   */
  engineComparison?: {
    engineRendering: { kind: "text"; text: string } | { kind: "error"; why: string };
    exportedPayload: Record<string, unknown>;
    remappedPayload: Record<string, unknown>;
  };
}

/** Run import → round-trip for one compiled bundle. */
export async function runValidateLoop(
  client: LoopClient,
  bundleText: string,
  options: ValidateLoopOptions = {},
): Promise<ValidateResult> {
  const bundle = JSON.parse(bundleText) as { payload?: Record<string, unknown> };
  const payload = bundle.payload ?? {};

  let imported: ImportResult;
  try {
    imported = await client.importBundle(bundleText);
  } catch (err) {
    return {
      accepted: false,
      importError: err instanceof Error ? err.message : String(err),
      workspaceId: undefined,
      roundTrip: [],
      unchecked: [],
    };
  }

  const workspaceId = imported.workspaceId;
  // The engine's own rendering is independent of the JSON round-trip,
  // so its fetch starts now and overlaps the export and the diff loop below.
  // A failure is captured, never thrown: the round-trip report is complete
  // without it, and losing that report over a missing text route is worse than
  // reporting the check as unavailable.
  const multidoc =
    options.includeEngineRendering === true &&
    workspaceId !== undefined &&
    client.exportMultidoc !== undefined
      ? client.exportMultidoc(workspaceId).then(
          (text) => ({ text }),
          (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
        )
      : undefined;
  // Registered kinds actually present on the compiled (bundle) side.
  const present = ROUND_TRIP_KINDS.map((k) => ({ kind: k.key, compiled: asRecords(payload[k.key]) })).filter(
    (p) => p.compiled.length > 0,
  );

  // Without a workspace id (can't read anything back), or with no registered
  // authored kinds to round-trip, we accepted the import but skip the export
  // entirely — every present kind, if any, is reported unchecked.
  if (workspaceId === undefined || (present.length === 0 && options.includeEngineRendering !== true)) {
    return {
      accepted: true,
      workspaceId,
      roundTrip: [],
      unchecked: present.map((p) => ({ kind: p.kind, count: p.compiled.length })),
    };
  }

  // Export the imported workspace back as a packageExport bundle (same shape we
  // sent, full logic) and match each compiled object to its persisted twin via
  // the shared normalizer — apples-to-apples across every registered kind.
  const exported = await client.exportWorkspace(workspaceId);
  const roundTrip: RoundTripEntry[] = [];
  const unchecked: Array<{ kind: string; count: number }> = [];

  // The engine re-mints every guid on import and rewrites each reference to the
  // new one, so a reference the SDK stores as a BARE guid (a query's `auth`
  // table, `create_auth_token`'s table argument) can never compare equal as
  // authored. Translate the compiled side into the engine's guids first — see
  // `./guid-remap.ts` for why this is a translation and not a strip rule.
  const remap = payloadGuidRemap(payload, exported.payload);
  // One translation of the whole compiled payload serves the per-object diffs
  // below and the engine rendering after them.
  const remapped = remapGuids(payload, remap);
  const labelOf = rowLabeler(payload);

  for (const { kind, compiled } of present) {
    const fetched = asRecords(exported.payload[kind]);
    // The export doesn't surface this kind as a populated top-level array (e.g.
    // `tool`, persisted nested under `toolset`): demote the whole kind to
    // unchecked rather than emit a false `missing` per compiled object.
    if (fetched.length === 0) {
      unchecked.push({ kind, count: compiled.length });
      continue;
    }
    const match = identityMatcher(kind, fetched, exported.payload, payload);
    const remappedKind = asRecords(remapped[kind]);
    for (const [i, obj] of compiled.entries()) {
      const name = typeof obj.name === "string" ? obj.name : "(unnamed)";
      const named = { kind, sdkKind: sectionKind(kind, obj), name, label: labelOf(kind, obj) };
      const resolved = match(obj);
      if (resolved.outcome !== "found") {
        // "missing" or "ambiguous" — the outcome IS the status; no fetched body.
        roundTrip.push({ ...named, status: resolved.outcome, diffs: [], fetched: undefined });
      } else {
        const diffs = deepDiff(normalize(remappedKind[i] ?? obj), normalize(resolved.fetched));
        roundTrip.push({ ...named, status: diffs.length === 0 ? "match" : "diff", diffs, fetched: resolved.fetched });
      }
    }
  }

  const result: ValidateResult = { accepted: true, workspaceId, roundTrip, unchecked };

  if (options.includeEngineRendering === true) {
    const fetched = multidoc === undefined ? { error: "(no workspace to read back)" } : await multidoc;
    result.engineComparison = {
      engineRendering: "error" in fetched ? { kind: "error", why: fetched.error } : { kind: "text", text: fetched.text },
      exportedPayload: exported.payload,
      remappedPayload: remapped,
    };
  }

  return result;
}

/**
 * The names eligible for a `--runtime` smoke-run: entries of a runnable kind
 * (per the registry — only `function` today) that actually imported (status
 * match/diff). Tables and other non-runnable kinds are not invocable via the
 * function/run route, and missing/ambiguous names never landed. Extracted as a
 * pure helper so the gate is unit-testable (it is command behavior, not loop
 * behavior) and reads the registry instead of hardcoding a kind string.
 */
export function runnableFunctionNames(entries: RoundTripEntry[]): string[] {
  return entries
    .filter((e) => kindIsRunnable(e.kind) && (e.status === "match" || e.status === "diff"))
    .map((e) => e.name);
}

/** Coerce a payload array to records; tolerates a missing/non-array value. */
function asRecords(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((o): o is Record<string, unknown> => o !== null && typeof o === "object") : [];
}

/**
 * Leaf-level deep diff of two normalized values. Returns one entry per mismatched
 * leaf (empty array = equal). Both sides are already normalized, so a difference
 * is either a strip-rule gap or a real encoder divergence — the caller decides.
 */
export function deepDiff(expected: unknown, actual: unknown, path = "$"): DiffLine[] {
  if (expected === actual) return [];
  const bothObjects =
    expected !== null &&
    actual !== null &&
    typeof expected === "object" &&
    typeof actual === "object";
  if (!bothObjects) return [{ path, expected, actual }];

  const expIsArr = Array.isArray(expected);
  const actIsArr = Array.isArray(actual);
  if (expIsArr !== actIsArr) return [{ path, expected, actual }];

  // Both flags in the condition so TS narrows `expected` AND `actual` to arrays.
  if (expIsArr && actIsArr) {
    const len = Math.max(expected.length, actual.length);
    const out: DiffLine[] = [];
    for (let i = 0; i < len; i++) out.push(...deepDiff(expected[i], actual[i], `${path}[${i}]`));
    return out;
  }

  const e = expected as Record<string, unknown>;
  const a = actual as Record<string, unknown>;
  const keys = new Set([...Object.keys(e), ...Object.keys(a)]);
  const out: DiffLine[] = [];
  for (const k of keys) out.push(...deepDiff(e[k], a[k], `${path}.${k}`));
  return out;
}
