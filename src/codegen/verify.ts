/**
 * Runtime round-trip verification — on by default, not a test-only claim.
 *
 * Every decoder is proof-carrying, so a *statement* cannot decode wrongly without
 * falling back to `raw()`. What that does not cover is everything outside a
 * statement: a def key elided because the encoder appeared to reproduce it, a
 * kind-level default read one way, a field descriptor that re-encodes close
 * enough to pass its own check. Those show up only when the whole generated tree
 * is loaded and exported again.
 *
 * The corpus cannot reach a user's real workspace, so this runs there instead:
 * load the tree that was just written, export it, and diff against the bundle it
 * came from under `normalize()`. A clean run is then a property the user
 * actually has, rather than something the test suite asserted about other data.
 *
 * Node-only (it imports the generated tree); reached through the CLI, never from
 * the browser-safe authoring entry.
 */
import { identityName, reportObjectLabel } from "./labels.js";
import { normalize } from "../validate/normalize.js";
import { diffKeyPaths } from "./prove-diff.js";
import type { DecodeReport } from "./report.js";
import {
  isWorkspaceKeyAtDefault,
  sectionOmission,
  workspaceKeyOmission,
  type OmissionReason,
} from "./omissions.js";
import { unboundPathParams } from "../kinds/path-params.js";
import { isOsMetadataRow } from "../kinds/knowledge.js";

/** One object whose re-export does not match the bundle it was decoded from. */
export interface VerifyMismatch {
  /** The payload section it lives in, e.g. `function`. */
  readonly payloadKey: string;
  readonly name: string;
  /** What differs, in one line. */
  readonly detail: string;
  /**
   * The key paths inside the object that disagree, as `diffKeyPaths` spells them.
   *
   * Empty when the object is present on only one side — there is no key-level
   * disagreement to name, and the absence is itself the whole finding.
   */
  readonly paths: readonly string[];
}

/**
 * One thing the generated tree left behind **on purpose** (see `omissions.ts`).
 *
 * Kept separate from {@link VerifyMismatch} because it means something opposite:
 * a mismatch says the round trip is broken, an omission says the round trip
 * worked and the SDK declined to carry a secret or a server-assigned value.
 * Folding the two together is what made a real-workspace pull look like it had
 * failed when it had not.
 */
export interface VerifyOmission {
  readonly payloadKey: string;
  /** The workspace key, or `(section)` for a whole payload section. */
  readonly name: string;
  readonly reason: OmissionReason;
  readonly detail: string;
}

/** The outcome of a runtime verification pass. */
export interface VerifyResult {
  /** True when nothing was *lost*. Deliberate omissions do not fail a run. */
  readonly ok: boolean;
  readonly mismatches: readonly VerifyMismatch[];
  readonly omissions: readonly VerifyOmission[];
}

/** One section object, under the key that identifies it, keeping its display name. */
interface SectionEntry {
  /** What the report calls it. */
  readonly name: string;
  readonly value: unknown;
}

/**
 * Objects in a payload section, keyed by identity.
 *
 * Name alone is not an identity: agents and MCP servers share the `toolset`
 * payload key, so a workspace can hold two objects of different kinds with the
 * same name — and one real workspace does. Keying by name collapsed the pair to
 * a single entry, which then compared the agent against the MCP server and
 * reported a `type`/`canonical` mismatch on two objects that each round-tripped
 * perfectly. The dropped twin was invisible, which is the worse half.
 *
 * A repeated name falls back to the object's guid, which `codegen` preserves
 * verbatim precisely so references stay consistent. Names that do not repeat
 * key exactly as before, so nothing else in the comparison shifts.
 */
function sectionByName(
  payload: Record<string, unknown>,
  key: string,
  ambiguous: ReadonlySet<string>,
): Map<string, SectionEntry> {
  const section = payload[key];
  if (!Array.isArray(section)) return new Map();
  const out = new Map<string, SectionEntry>();
  for (const o of section) {
    const name = String((o as { name?: unknown }).name ?? "");
    const guid = (o as { guid?: unknown }).guid;
    const keyed =
      key === "knowledge_file"
        ? knowledgeFileKey(o)
        : ambiguous.has(name) && typeof guid === "string" && guid !== ""
          ? `${name} ${guid}`
          : name;
    // Named as the decode names it: a repeated name by its composed identity.
    out.set(keyed, { name: identityName(payload, key, o), value: o });
  }
  return out;
}

/**
 * A reference file's identity: its item's guid and its path in the folder. It
 * has no name, and its own guid is not stable across a decode and re-export.
 */
function knowledgeFileKey(row: unknown): string {
  const { path, knowledge } = (row ?? {}) as { path?: unknown; knowledge?: { id?: unknown } };
  return `${String(knowledge?.id ?? "")}|${String(path ?? "").replace(/^knowledge-refs\/[^/]+\//, "")}`;
}

/**
 * Names that repeat within a section on EITHER side.
 *
 * Computed across both bundles on purpose: if one side lost a twin, that name is
 * no longer repeated there, and keying the two sides by different rules would
 * turn one dropped object into a missing-plus-invented pair naming neither.
 */
function ambiguousNames(...sections: unknown[]): ReadonlySet<string> {
  const ambiguous = new Set<string>();
  for (const section of sections) {
    if (!Array.isArray(section)) continue;
    const seen = new Set<string>();
    for (const o of section) {
      const name = String((o as { name?: unknown }).name ?? "");
      if (seen.has(name)) ambiguous.add(name);
      seen.add(name);
    }
  }
  return ambiguous;
}

/** Deep structural equality over normalized payload objects. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!deepEqual(left[key], right[key])) return false;
  return true;
}

/**
 * The key paths where a regenerated object disagrees with its source.
 *
 * Diffed **after** `normalize()`, deliberately: the paths have to agree with the
 * verdict that produced them. A raw diff would list every server column the
 * comparison already elides — `id` on every object — and bury the key that
 * actually failed.
 */
function mismatchPaths(source: unknown, regenerated: unknown, payloadKey?: string): string[] {
  const paths = diffKeyPaths(normalize(regenerated), normalize(source));
  // `env` carries a secret in every value, so the whole line is redacted.
  if (payloadKey === "env") return paths.map(redactSecretValues);
  // `workspace` and `app` carry one secret-bearing key each, so only the lines
  // naming it are redacted. Redacting these sections wholesale was the first
  // shape of this rule, and it cost the corpus sweep its triage detail: every
  // ordinary `preferences`/`settings`/`cors` mismatch came back `<redacted>`
  // on both sides, which is the report the sweep exists to read.
  if (payloadKey === "workspace" || payloadKey === "app") {
    return paths.map((path) => (mentionsDocumentationToken(path) ? redactSecretValues(path) : path));
  }
  return paths;
}

/**
 * Does this mismatch line name the documentation token?
 *
 * Matched on the rendered PATH rather than the value, so the test is about which
 * key disagreed — the one thing about a secret-bearing mismatch that is safe to
 * read. Deliberately loose on the path's shape: `diffKeyPaths` renders nesting
 * differently per section, and the cost of matching one line too many is a less
 * specific report, where the cost of missing one is a live token committed into
 * `xano/README.md` by the failed-verify path.
 */
function mentionsDocumentationToken(path: string): boolean {
  return path.includes("documentation") || /\btoken\b/.test(path);
}

/**
 * Strip the VALUES out of a secret-bearing mismatch line, keeping the shape.
 *
 * `diffKeyPaths` renders both sides of a disagreement verbatim, which is what
 * makes it worth reading for every other section — and catastrophic for these.
 * A mismatch report is not just printed: `rewriteReadmeWithReport` writes it
 * into `xano/README.md`, a COMMITTED file. A round trip that disagreed would
 * therefore commit a live secret to git, which is the exact outcome the
 * mechanisms being verified exist to prevent.
 *
 * Applied to `env` (backend values), and to `workspace` and `app` (the two
 * scopes that hold a documentation token). Scoped to the whole line rather than
 * to the token key alone because the renderer does not label which key a rendered
 * value belongs to, so a token-only rule would depend on parsing its output —
 * and the cost of over-redacting is a less specific report, where the cost of
 * under-redacting is a secret in git.
 *
 * The fact worth reporting survives: which key disagreed, and that it did. A
 * reader who needs the values has them in the workspace and in `xano/.env`.
 */
function redactSecretValues(path: string): string {
  return path.replace(/((?:encoded|stored)=)(?!<redacted>)\S.*?(?=(?: (?:encoded|stored)=)|$)/g, "$1<redacted>");
}

/**
 * One line naming both what happened and where.
 *
 * "re-exports differently than the source bundle" was true and useless at scale:
 * a full sweep produced 1,716 rows carrying that sentence and nothing else, so
 * the largest remaining category was also the only one that could not be
 * clustered. The paths are what make a row actionable — the same argument that
 * already split the workspace section into per-key rows.
 */
function withPaths(detail: string, paths: readonly string[]): string {
  return paths.length === 0 ? detail : `${detail}: ${paths.join("; ")}`;
}

/** A plain object (not an array, not null) — the shape worth comparing per key. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Blank in the sense an `emptied` policy means: nothing was written here. */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return isPlainObject(value) && Object.keys(value).length === 0;
}

/**
 * Drop the presence-gated workspace keys sitting at the value the engine writes
 * for an untouched workspace, on BOTH sides of the comparison.
 *
 * The generated tree deliberately does not carry them (see
 * `WORKSPACE_DEFAULTED_KEYS`), and the encoder emits them only when an author
 * asks — so absent here is not a loss and not an omission worth a report line.
 * Applied to both sides rather than special-casing the generated one, so a tree
 * that DOES carry an explicit default still compares equal to a bundle that
 * stores it.
 */
function dropDefaultedWorkspaceKeys(section: unknown): unknown {
  if (!isPlainObject(section)) return section;
  // Null-prototype: a key spelled `__proto__` (a column, a stored JSON member) is
  // stored here, where assigning it on a plain `{}` sets a prototype instead.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(section)) {
    if (!isWorkspaceKeyAtDefault(key, value)) out[key] = value;
  }
  return out;
}

/**
 * Compare a non-array section (`workspace`, `partial`) key by key.
 *
 * "`workspace:(section)` does not match the source bundle" was true but useless
 * — a workspace object carries ~35 keys and the message named none of them. Per
 * key, the same run instead says which four differ and which of those were left
 * behind on purpose.
 */
function verifySection(
  key: string,
  before: unknown,
  after: unknown,
  mismatches: VerifyMismatch[],
  omissions: VerifyOmission[],
): void {
  if (key === "workspace") {
    before = dropDefaultedWorkspaceKeys(before);
    after = dropDefaultedWorkspaceKeys(after);
  }
  if (deepEqual(normalize(before), normalize(after))) return;

  // A scalar (`partial`) has no keys to report against — compare it whole.
  if (!isPlainObject(before) || !isPlainObject(after)) {
    const paths = mismatchPaths(before, after, key);
    mismatches.push({
      payloadKey: key,
      name: "(section)",
      detail: withPaths("section does not match the source bundle", paths),
      paths,
    });
    return;
  }

  const omissionFor = key === "workspace" ? workspaceKeyOmission : () => undefined;
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const left = before[name];
    const right = after[name];
    if (deepEqual(normalize(left), normalize(right))) continue;

    // Only an *absence* can be a deliberate omission — or, for the key marked
    // `emptied`, a value the generated tree deliberately blanks, or for the one
    // marked `derived`, a value it deliberately re-derives. Any other key emitted
    // with a differing value is a real divergence no policy excuses.
    // A documentation token the tree declined to carry — a FIELD-level omission,
    // where every other declaration here is whole-key. Checked before the
    // whole-key table because `documentation` is not in it: the key IS carried,
    // one member of it is not.
    if (
      key === "workspace" &&
      name === "documentation" &&
      isUncarriedDocumentationToken({ documentation: left }, { documentation: right })
    ) {
      omissions.push({ payloadKey: key, name, ...UNCARRIED_TOKEN_OMISSION });
      continue;
    }
    const candidate = omissionFor(name);
    const policy =
      candidate &&
      (right === undefined ||
        (candidate.emptied === true && isEmpty(right)) ||
        candidate.derived === true)
        ? candidate
        : undefined;
    if (policy) {
      omissions.push({ payloadKey: key, name, reason: policy.reason, detail: policy.detail });
      continue;
    }
    // Only a key present on BOTH sides has paths to name; a one-sided key is
    // reported whole, exactly like a one-sided object.
    const paths =
      right === undefined || left === undefined ? [] : mismatchPaths(left, right, key);
    mismatches.push({
      payloadKey: key,
      name,
      detail: withPaths(
        right === undefined
          ? "present in the source bundle but not in the generated tree"
          : left === undefined
            ? "present in the generated tree but not in the source bundle"
            : "re-exports differently than the source bundle",
        paths,
      ),
      paths,
    });
  }
}

/**
 * The documentation token this SDK declined to carry, declared to verification.
 *
 * A token the tree deliberately does not carry has to be declared here, or a
 * re-export of the generated tree cannot reproduce the source bundle and the
 * pull hard-fails on exactly the workspaces this feature targets.
 *
 * Narrow on purpose, and narrower than the whole-key declarations beside it
 * (the relocated env set, the re-derived workspace guid): this is a FIELD nested
 * inside a block the tree still carries, and it only excuses the case where the
 * source holds a non-empty token and the regenerated side holds none. The
 * ORDINARY path does not reach here at all — a pull hands the token's value back
 * to the re-export in memory, so the block matches exactly. What reaches here is
 * the scope whose identity produced no representable `xano/.env` name, where the
 * token is genuinely not carried and the decode report already said so.
 *
 * Any other difference in the block still fails. The token is set aside, not the
 * comparison.
 */
function isUncarriedDocumentationToken(source: unknown, regenerated: unknown): boolean {
  const from = documentationOf(source);
  if (from === undefined || typeof from.token !== "string" || from.token === "") return false;
  const into = documentationOf(regenerated);
  if (into !== undefined && typeof into.token === "string" && into.token !== "") return false;
  const blanked = withBlankDocumentationToken(source);
  const target = withBlankDocumentationToken(regenerated);
  return deepEqual(normalize(blanked), normalize(target));
}

/** The `documentation` block of an object, or of the block itself. */
function documentationOf(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const doc = value.documentation;
  return isPlainObject(doc) ? doc : undefined;
}

/** `value` with its documentation token set aside, so the rest still compares. */
function withBlankDocumentationToken(value: unknown): unknown {
  const doc = documentationOf(value);
  if (doc === undefined) return value;
  const { token: _token, ...rest } = doc;
  return { ...(value as Record<string, unknown>), documentation: rest };
}

/** The line a set-aside token is reported under. */
const UNCARRIED_TOKEN_OMISSION = {
  reason: "secret" as OmissionReason,
  detail:
    "the documentation token is a secret and is not carried into the generated tree; the source declares the gate and the value is written to `xano/.secrets.json`, which is gitignored and read back by every command that builds a bundle",
};

/**
 * The regenerated object with codegen's synthesized path-param inputs removed,
 * so the one difference the decoder DELIBERATELY introduces is not also counted
 * as a round-trip failure.
 *
 * Xano serves an endpoint whose `{param}` binds to no input — the segment is
 * inert route text — but Xano SDK refuses to author one, so `pathAwareInputs`
 * declares an `input.text()` for it and reports `path-param-bound`. That is a
 * warning the user is meant to act on; re-reporting it here as an error made the
 * sweep's most severe category (30 rows across 6 workspaces) consist entirely of
 * a thing already reported, which is invariant 8 — an omission and a mismatch
 * must never both fire for one thing.
 *
 * Scoped exactly: only entries whose names the SOURCE object's own path leaves
 * unbound are dropped, using the same {@link unboundPathParams} rule that added
 * them. Any other difference — including a different field for one of those very
 * names — still fails, because the entry is removed rather than excused.
 */
function withoutSynthesizedPathParams(source: unknown, regenerated: unknown): unknown {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return regenerated;
  if (regenerated === null || typeof regenerated !== "object" || Array.isArray(regenerated)) {
    return regenerated;
  }
  const from = source as { name?: unknown; input?: unknown };
  if (typeof from.name !== "string" || !from.name.includes("{")) return regenerated;
  const synthesized = new Set(unboundPathParams(from.name, from.input));
  if (synthesized.size === 0) return regenerated;
  const into = regenerated as { input?: unknown };
  if (!Array.isArray(into.input)) return regenerated;
  const kept = into.input.filter(
    (entry) =>
      !(
        entry !== null &&
        typeof entry === "object" &&
        synthesized.has((entry as { name?: unknown }).name as string)
      ),
  );
  return kept.length === into.input.length ? regenerated : { ...into, input: kept };
}

/** How {@link verifyBundles} reads its source. */
export interface VerifyOptions {
  /** What the source bundle was read from; a `"release"` carries no workspace settings. */
  readonly source?: string;
}

/** The workspace settings a workspace export always states and a release never does. */
const WORKSPACE_SETTING_KEYS = ["canonical", "description", "swagger", "settings"] as const;

/**
 * Compare a regenerated bundle against its source, per object.
 *
 * Reported per object rather than as one payload-wide diff: a whole-bundle
 * inequality tells a user nothing they can act on, whereas "`function
 * signup` differs" points at the file to look at.
 *
 * Objects in a section this SDK deliberately does not model are reported as
 * omissions rather than mismatches, so a real workspace carrying (say)
 * `knowledge` verifies clean while still saying out loud what was left behind.
 */
export function verifyBundles(
  source: unknown,
  regenerated: unknown,
  options: VerifyOptions = {},
): VerifyResult {
  const sourcePayload = ((source as { payload?: unknown })?.payload ?? {}) as Record<string, unknown>;
  const regeneratedPayload = ((regenerated as { payload?: unknown })?.payload ?? {}) as Record<
    string,
    unknown
  >;
  const mismatches: VerifyMismatch[] = [];
  const omissions: VerifyOmission[] = [];

  const keys = new Set([...Object.keys(sourcePayload), ...Object.keys(regeneratedPayload)]);
  for (const key of [...keys].sort()) {
    const before = sourcePayload[key];
    let after = regeneratedPayload[key];
    // A release archive's record of itself, which no tree carries; and the
    // workspace name a release does not carry, which the tree has only because
    // every tree must (`workspace("…")`). Neither is a difference in content.
    if (key === "metadata" || (key === "workspace" && before === undefined)) continue;
    // A release carries no workspace SETTINGS either — no canonical, swagger,
    // description or settings block — while every tree states them
    // (`workspaceConfig` exports its defaults). A key only the tree has is the
    // tree's own, not a difference; a key both carry is still compared (E2E
    // pass 25). Keyed on the source KIND — or, for an archive read from a file,
    // on a block carrying none of those settings — not only on a missing name:
    // a real release's block is named after the release (E2E pass 26).
    if (
      key === "workspace" &&
      isPlainObject(before) &&
      isPlainObject(after) &&
      (options.source === "release" ||
        before.name === undefined ||
        !WORKSPACE_SETTING_KEYS.some((k) => k in before))
    ) {
      const carried = before;
      after = Object.fromEntries(Object.entries(after).filter(([k]) => k in carried));
    }
    if (!Array.isArray(before) && !Array.isArray(after)) {
      verifySection(key, before, after, mismatches, omissions);
      continue;
    }
    const policy = sectionOmission(key);
    const ambiguous = ambiguousNames(before, after);
    const beforeByName = sectionByName(sourcePayload, key, ambiguous);
    const afterByName = sectionByName(regeneratedPayload, key, ambiguous);
    for (const [identity, entry] of beforeByName) {
      const counterpart = afterByName.get(identity);
      if (counterpart === undefined) {
        // Written by no decode and shipped by no export; the decode named it.
        if (key === "knowledge_file" && isOsMetadataRow(entry.value)) continue;
        if (policy) {
          omissions.push({ payloadKey: key, name: entry.name, reason: policy.reason, detail: policy.detail });
          continue;
        }
        mismatches.push({ payloadKey: key, name: entry.name, detail: "missing from the generated tree", paths: [] });
        continue;
      }
      const regenerated = withoutSynthesizedPathParams(entry.value, counterpart.value);
      // The API-group half of the same field-level declaration. This section has
      // no omission hook of its own — `sectionOmission` answers for a whole
      // MISSING section, not for a field inside a present object.
      if (key === "app" && isUncarriedDocumentationToken(entry.value, regenerated)) {
        omissions.push({ payloadKey: key, name: entry.name, ...UNCARRIED_TOKEN_OMISSION });
        continue;
      }
      if (!deepEqual(normalize(entry.value), normalize(regenerated))) {
        const paths = mismatchPaths(entry.value, regenerated, key);
        mismatches.push({
          payloadKey: key,
          name: entry.name,
          detail: withPaths("re-exports differently than the source bundle", paths),
          paths,
        });
      }
    }
    for (const [identity, entry] of afterByName) {
      if (!beforeByName.has(identity)) {
        mismatches.push({
          payloadKey: key,
          name: entry.name,
          detail: "present in the generated tree but not in the source bundle",
          paths: [],
        });
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches, omissions };
}

/** Fold a verification result into the decode report so every sink shows it. */
export function reportMismatches(report: DecodeReport, result: VerifyResult): void {
  for (const mismatch of result.mismatches) {
    report.add({
      category: "verify-mismatch",
      object: reportObjectLabel(mismatch.payloadKey, mismatch.name),
      detail: mismatch.detail,
    });
  }
  for (const omission of result.omissions) {
    report.add({
      category: "expected-omission",
      object: reportObjectLabel(omission.payloadKey, omission.name),
      detail: `${omission.detail} (${omission.reason})`,
    });
  }
}
