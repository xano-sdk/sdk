/**
 * How the decode paths (`init --from`, `pull`, `generate`) name what they
 * decoded, in the SDK's vocabulary rather than the bundle's storage keys.
 *
 * A reader authored `table()`, `apiGroup()` and `workflowTest()`; the summary
 * line, the generated README and the verification notes are read by that same
 * person, so none of them says `dbo`, `app` or `workflow_test`, and a workspace
 * setting the tree leaves out is named by what it is, never by its stored field.
 */
import { sdkKindName } from "../util/sdk-kind.js";
import { sectionOmission, workspaceKeyOmission } from "./omissions.js";
import { identityNamesByGuid, lockNameForObject } from "../lock/lock.js";

/** Singular/plural nouns for the sections whose SDK kind name does not pluralize by `+s`. */
const NOUNS: Readonly<Record<string, readonly [string, string]>> = {
  query: ["query", "queries"],
  env: ["env var", "env vars"],
  knowledge: ["knowledge item", "knowledge items"],
  knowledge_file: ["knowledge file", "knowledge files"],
  addon: ["addon", "addons"],
};

/** `n` objects of one SDK kind, as a count phrase (`2 queries`, `1 apiGroup`). */
function countOf(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Per-kind counts for a payload, as the phrases the summary line joins. A
 * section this SDK deliberately does not carry is counted under its own label,
 * and `toolset` is split into its two SDK kinds by each row's type.
 */
export function decodedCounts(payload: Readonly<Record<string, unknown>>): string[] {
  const out: Array<[string, string]> = [];
  for (const [key, section] of Object.entries(payload)) {
    if (!Array.isArray(section) || section.length === 0) continue;
    if (key === "toolset") {
      const agents = section.filter((r) => (r as { type?: unknown } | null)?.type === "agent").length;
      if (agents > 0) out.push(["agent", countOf(agents, "agent")]);
      if (section.length - agents > 0) out.push(["mcpServer", countOf(section.length - agents, "mcpServer")]);
      continue;
    }
    const policy = sectionOmission(key);
    if (policy !== undefined) {
      out.push([policy.label, `${section.length} ${policy.label}`]);
      continue;
    }
    const noun = (Object.hasOwn(NOUNS, key) ? NOUNS[key] : undefined);
    const kind = sdkKindName(key);
    out.push([kind, noun !== undefined ? countOf(section.length, noun[0], noun[1]) : countOf(section.length, kind)]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, phrase]) => phrase);
}

const repeatedNames = new WeakMap<object, Map<string, Set<string>>>();

/**
 * How a finding names one stored object: its `name`, or — when that name repeats
 * in its section — its composed identity, as the lock spells it
 * (`public|lobby|say`, `api|GET|items`). Two `say` messages on two channels are
 * two objects, and a finding keyed by the bare name reported both at one file.
 */
export function identityName(payload: Readonly<Record<string, unknown>>, payloadKey: string, stored: unknown): string {
  // A reference file has no name: it is its item's name and its path in the folder.
  if (payloadKey === "knowledge_file") return knowledgeFileName(payload, stored);
  const name = String((stored as { name?: unknown } | null)?.name ?? "");
  let repeats = repeatedNames.get(payload);
  if (repeats === undefined) {
    repeats = new Map();
    for (const [key, section] of Object.entries(payload)) {
      if (!Array.isArray(section)) continue;
      const seen = new Set<string>();
      const twice = new Set<string>();
      for (const row of section) {
        const n = String((row as { name?: unknown } | null)?.name ?? "");
        if (seen.has(n)) twice.add(n);
        seen.add(n);
      }
      repeats.set(key, twice);
    }
    repeatedNames.set(payload, repeats);
  }
  if (!repeats.get(payloadKey)?.has(name)) return name;
  return lockNameForObject(payloadKey, stored as { name: string }, identityNamesByGuid(payload as Record<string, unknown>));
}

/** `<item>/<path>` for a `knowledge_file` row, its storage prefix removed. */
function knowledgeFileName(payload: Readonly<Record<string, unknown>>, stored: unknown): string {
  const { path, knowledge } = (stored ?? {}) as { path?: unknown; knowledge?: { id?: unknown } };
  const items = Array.isArray(payload.knowledge) ? payload.knowledge : [];
  const item = items.find((k) => (k as { guid?: unknown } | null)?.guid === knowledge?.id) as { name?: unknown } | undefined;
  const rel = String(path ?? "").replace(/^knowledge-refs\/[^/]+\//, "");
  return item?.name === undefined ? rel : `${String(item.name)}/${rel}`;
}

/** The workspace settings object, as a report names it. */
const WORKSPACE_SETTINGS = "workspace settings";

/**
 * How a verification note names one object or workspace setting: `table:users`,
 * `apiGroup:billing`, `workspace settings (integration API keys)`. A workspace
 * key with no policy is a genuine gap, named by its key so it can be triaged.
 */
export function reportObjectLabel(payloadKey: string, name: string): string {
  if (payloadKey === "workspace") {
    const policy = workspaceKeyOmission(name);
    return `${WORKSPACE_SETTINGS} (${policy?.label ?? name})`;
  }
  const section = sectionOmission(payloadKey);
  if (section !== undefined) return `${section.label}: ${name}`;
  return `${sdkKindName(payloadKey)}:${name}`;
}
