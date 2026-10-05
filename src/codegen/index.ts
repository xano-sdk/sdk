/**
 * `src/codegen` — the decode direction: Xano bundle JSON → Xano SDK TypeScript.
 *
 * Decode is a plain function layer, not a `decode()` method on `ObjectKind`:
 * it needs bundle-wide context (the guid index, the current file's
 * imports, the report) rather than the pure unary shape `encode(def)` has, and
 * putting it on the kinds would drag the printer and every decoder into the
 * browser-safe authoring bundle.
 *
 * `decodeBundle` is pure and offline — no network, no filesystem. Writing the
 * tree and fetching a bundle from a live environment are the CLI's job.
 */
import { sdkKindName } from "../util/sdk-kind.js";
import { DecodeContext } from "./context.js";
import { planDocumentationTokens, rawEnvEntries, type DocumentationTokenEntry } from "./documentation-tokens.js";
import { DecodeReport } from "./report.js";
import { RefIndex } from "./ref-index.js";
import { consolidateSourceDuplicates, describeConflict } from "./consolidate.js";
import { assembleProject } from "./project.js";
import { PAYLOAD_ARRAY_KEYS } from "../workspace/export.js";
import { omissionSeverity, UNSUPPORTED_SECTIONS } from "./omissions.js";
import { reportObjectLabel } from "./labels.js";
import { isOsMetadataRow } from "../kinds/knowledge.js";

export { DecodeContext, ImportCollector, SDK_MODULE, CODEGEN_MODULE } from "./context.js";
export { DecodeReport } from "./report.js";
export { RefIndex, resolveReference } from "./ref-index.js";
export type { IndexedObject, ResolveOptions } from "./ref-index.js";
export { assembleProject, toSymbol } from "./project.js";
export type { ReportCategory, ReportEntry, ReportGroup, ReportSummary } from "./report.js";
export { printExpr, printModule, id, lit, call, obj, arr, arrow } from "./print.js";
export type { Expr, Stmt, ImportStmt } from "./print.js";

/** One file in the generated tree, at a path relative to the output directory. */
export interface GeneratedFile {
  /** Relative POSIX path, e.g. `functions/signup.ts`. */
  readonly path: string;
  readonly contents: string;
}

/** The result of decoding a bundle: a tree of source files plus what went wrong. */
export interface GeneratedProject {
  readonly files: readonly GeneratedFile[];
  readonly report: DecodeReport;
  /**
   * The archive the tree was actually generated from, after equivalent repeats
   * of one stored object were merged.
   *
   * Round-trip verification MUST compare against this rather than the bundle as
   * it arrived. Reconciling only the decode side would leave the regenerated
   * tree holding one object where the original archive holds three, and the
   * verifier would report two objects missing — turning a fix into a new
   * failure. Same object as the input payload when nothing was repeated.
   */
  readonly source: Record<string, unknown>;
  /**
   * The workspace env vars the bundle carried, name→value.
   *
   * RETURNED, never written. The decoder stays pure and offline: the generated
   * source declares these names as empty placeholders, and the CLI uses this map
   * for exactly two things — rendering the names into `xano/.env.example`, and
   * feeding the values back into the round-trip verification IN MEMORY, which
   * would otherwise fail against a bundle whose `payload.env` carries values the
   * placeholders do not. The values reach no file at any point.
   */
  readonly env: Record<string, string>;
  /**
   * The documentation tokens the bundle carried, `xano/.env` name→value.
   *
   * RETURNED, never written — the same contract {@link GeneratedProject.env}
   * has, and for the same reason. A documentation token gates a hosted doc site
   * and is a secret; the generated source names it and the value reaches no file
   * at any point. The CLI writes them to `xano/.secrets.json` and feeds them
   * back into the round-trip check IN MEMORY, which would otherwise fail against
   * a bundle whose blocks carry a token the source deliberately does not.
   *
   * Keyed by SCOPE (`workspace`, `apiGroup:<guid>`), with the label a flag accepts for
   * that scope. These are NOT backend env vars: they never reach the bundle's
   * top-level `env`, and `env("NAME")` in a stack does not read them.
   */
  readonly documentationTokens: Record<string, DocumentationTokenEntry>;
}

/**
 * Every payload key this decoder knows about — the canonical export key set plus
 * the scalars that are not object arrays. Derived from the export side rather
 * than restated, so a key added there cannot silently become "unknown" here.
 *
 * `metadata` is the release record a release archive carries about ITSELF (a
 * compile and a live export have none): the archive's envelope, not workspace
 * content, so nothing is lost by not decoding it — reporting it as an
 * unsupported section made every release pull warn about a loss that is not one.
 */
const KNOWN_PAYLOAD_KEYS: ReadonlySet<string> = new Set<string>([
  ...PAYLOAD_ARRAY_KEYS,
  ...Object.keys(UNSUPPORTED_SECTIONS),
  "metadata",
  "partial",
  "workspace",
]);

/**
 * Decode a Xano `packageExport` bundle into a tree of Xano SDK source files.
 *
 * Pure and offline — no network, no filesystem. Writing the tree, fetching a
 * bundle from a live environment, and verifying the round trip are the CLI's job.
 */
export function decodeBundle(
  bundle: { payload: Record<string, unknown> },
  opts: {
    /** How the report names the documentation-token sidecar the caller writes. */
    secretsFile?: string;
    /**
     * The workspace name to write over the source's — for a source whose name is
     * not the project's (a tenant's handle, a release that carries none).
     */
    workspaceName?: string;
  } = {},
): GeneratedProject {
  const ctx = new DecodeContext();
  if (opts.secretsFile !== undefined) ctx.secretsFile = opts.secretsFile;
  let raw = bundle.payload ?? {};
  if (opts.workspaceName !== undefined) {
    ctx.fallbackWorkspaceName = opts.workspaceName;
    const ws = raw.workspace;
    if (ws !== null && typeof ws === "object" && !Array.isArray(ws)) {
      raw = { ...raw, workspace: { ...(ws as Record<string, unknown>), name: opts.workspaceName } };
    }
  }

  // FIRST, before the reference index and before a single file is planned: an
  // archive that repeats one stored object has to be reconciled while the only
  // thing in hand is the archive. Everything downstream — references, codegen,
  // and the round-trip check the CLI runs against `source` — reads the result,
  // so the three cannot disagree about how many objects there are.
  const { payload, consolidated, conflicts } = consolidateSourceDuplicates(raw);

  for (const merged of consolidated) {
    ctx.problem(
      "consolidated-duplicate",
      `${sdkKindName(merged.payloadKey)} "${merged.name}" (guid ${merged.guid}) appeared ${merged.copies} times in the ` +
        `source; the copies ${merged.metadataOnly ? "differed only in generated editor ids and " : ""}` +
        `were merged into one definition keeping the original guid`,
    );
  }
  for (const conflict of conflicts) {
    ctx.problem("duplicate-source-guid", describeConflict(conflict));
  }

  // BEFORE any file is generated: every documentation token the bundle carries,
  // keyed by the scope that holds it. Collected here rather than during the walk
  // because the sidecar is ONE file covering every scope, and it is written after
  // the tree lands.
  const docTokens = planDocumentationTokens(payload);

  const refs = RefIndex.fromPayload(payload, ctx);

  for (const [section, policy] of Object.entries(UNSUPPORTED_SECTIONS)) {
    const entries = payload[section];
    if (Array.isArray(entries) && entries.length > 0) {
      // Severity comes from the policy's own reason, so the list that decides
      // what is omitted is the list that decides how loudly to say so. Only an
      // `unmodeled` section is a gap in the pull; the rest are correct absences.
      ctx.problem(
        omissionSeverity(policy.reason) === "warning" ? "unsupported-section" : "instance-owned",
        `${policy.label}: ${entries.length} ${
          entries.length === 1 ? "entry is" : "entries are"
        } not carried into the generated tree — ${policy.detail}`,
      );
    }
  }

  // A reference file an older build shipped that is operating-system metadata:
  // not written, because an export skips it — said by name, never dropped silently.
  const knowledgeNames = new Map(
    (Array.isArray(payload.knowledge) ? payload.knowledge : []).map((k) => {
      const { guid, name } = k as { guid?: unknown; name?: unknown };
      return [guid, String(name ?? "")] as const;
    }),
  );
  for (const row of Array.isArray(payload.knowledge_file) ? payload.knowledge_file : []) {
    if (!isOsMetadataRow(row)) continue;
    const { path, knowledge } = row as { path: string; knowledge?: { id?: unknown } };
    ctx.report.add({
      category: "workspace-defect",
      object: reportObjectLabel("knowledge", knowledgeNames.get(knowledge?.id) ?? "?"),
      detail:
        `reference file "${path.replace(/^knowledge-refs\/[^/]+\//, "")}" is binary operating-system metadata a file ` +
        `manager left in the folder — not written to the tree, as an export never ships it`,
    });
  }

  // A key this SDK has never seen is the "anything Xano ships after this release"
  // case. It cannot be modelled, but it must not read as if the tree were
  // complete either — silence here is exactly the failure to prevent.
  for (const [key, value] of Object.entries(payload)) {
    if (KNOWN_PAYLOAD_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    ctx.problem(
      "unsupported-section",
      `payload.${key} is not a payload section this SDK knows; it is not carried into the generated tree`,
    );
  }

  return {
    files: assembleProject(ctx, refs, payload),
    report: ctx.report,
    source: payload,
    env: decodedEnv(payload),
    documentationTokens: docTokens.values,
  };
}

/**
 * The workspace's env vars as a name→value map, for the caller to use in memory.
 *
 * Reads the same two places `workspaceFile` folds together, and in the same
 * order: the export HOISTS env to the top-level `payload.env`, but an engine
 * archive has been seen carrying it on the workspace object instead. Reading
 * only the top level would leave this map empty for such a bundle while the
 * decoded source still declared the names — which fails the round trip and
 * writes an empty `.env.example`, both silently.
 */
function decodedEnv(payload: Record<string, unknown>): Record<string, string> {
  // Null-prototype: an env var named `__proto__` is a key here, not a prototype set.
  const out = Object.create(null) as Record<string, string>;
  for (const entry of rawEnvEntries(payload)) {
    out[entry.name] = typeof entry.value === "string" ? entry.value : "";
  }
  return out;
}
