/**
 * The `knowledge` object kind — the markdown an AI agent reads before it acts.
 *
 * A knowledge item is what seeds the agents in a Xano workspace with standing
 * instructions. Unlike every other kind, its payload is PROSE: the body is a
 * markdown document, and the item may own a folder of reference files the agent
 * searches on demand.
 *
 * ### The body is a file, never a string
 *
 * {@link knowledgeFile} names the body by path, resolved relative to the module
 * that declares the item — the {@link import("./table.js").seedFile} contract,
 * for the same reasons plus one more. A body worth writing is long enough that a
 * template literal makes it unreviewable in a diff, unreachable by markdown
 * tooling, and hostile to the backticks a prose document contains. There is no
 * inline-string form; a second way to say this would buy a second code path in
 * encode, decode, and the round-trip verifier for the strictly worse shape.
 *
 * ### Bytes do not enter `encode`
 *
 * The encoder emits `content: ""` and the path markers are dropped. File reads
 * happen once, in the Node compile path (see `src/workspace/knowledge.ts`), so
 * `export()` stays browser-safe. Every CLI command that produces a bundle runs
 * through that compile path, so a bundle written to disk still carries bodies.
 */
import type { UrlLike } from "../util/web-globals.js";
import { registerKind } from "./kind.js";
import type { ObjectKind } from "./kind.js";
import { encodeTags } from "./common.js";
import { brandDef } from "./def-brand.js";
import type { DiagnosticsFor } from "../workspace/diagnostics.js";

/** Brand for {@link knowledgeFile}'s marker, so the compile path can recognise it structurally. */
export const KNOWLEDGE_FILE: unique symbol = Symbol.for("xanosdk.knowledge.file") as never;

/** Brand for {@link knowledgeDir}'s marker. Distinct from {@link KNOWLEDGE_FILE} so a
 * directory passed where a body belongs fails at the type level, not at deploy. */
export const KNOWLEDGE_DIR: unique symbol = Symbol.for("xanosdk.knowledge.dir") as never;

/**
 * Operating-system metadata a file manager drops into any folder it opens. Not
 * the author's content, so a BINARY one in a reference folder is left out rather
 * than refused — the folder would otherwise fail every build after it was
 * browsed. One rule for both directions: the export skips it, and a decode of a
 * bundle that stored one does not write it.
 */
export function isOsMetadataFile(path: string, binary: boolean): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return binary && /^(?:\.DS_Store|Thumbs\.db|desktop\.ini|\._.*)$/i.test(base);
}

/**
 * {@link isOsMetadataFile} for a stored `knowledge_file` row: its content came
 * back as a string, and the NUL byte is what marks it binary there (a string
 * always re-encodes as valid UTF-8).
 */
export function isOsMetadataRow(row: unknown): boolean {
  const { path, content } = (row ?? {}) as { path?: unknown; content?: unknown };
  return typeof path === "string" && isOsMetadataFile(path, String(content ?? "").includes("\u0000"));
}

/** A markdown body named by PATH — see {@link knowledgeFile}. */
export interface KnowledgeFileSource {
  readonly [KNOWLEDGE_FILE]: { readonly path: string; readonly base: string };
}

/** A reference-file directory named by PATH — see {@link knowledgeDir}. */
export interface KnowledgeDirSource {
  readonly [KNOWLEDGE_DIR]: { readonly path: string; readonly base: string };
}

/**
 * The markdown body of a knowledge item, named by path.
 *
 * ```ts
 * body: knowledgeFile("./deploy-runbook.md", import.meta.url)
 * ```
 *
 * `base` is required and is `import.meta.url` at the call site: `path` resolves
 * relative to the FILE THAT DECLARES THE ITEM — where the author is looking when
 * they write it — not the CLI's working directory and not the workspace entry.
 *
 * A path is a plain string, so there is nothing for a bundler to follow; the file
 * is read with `node:fs` in the compile pipeline only.
 */
export function knowledgeFile(path: string, base: string | UrlLike): KnowledgeFileSource {
  return { [KNOWLEDGE_FILE]: { path, base: typeof base === "string" ? base : base.href } };
}

/**
 * A directory of reference files for a knowledge item, named by path.
 *
 * ```ts
 * refs: knowledgeDir("./deploy-runbook", import.meta.url)
 * ```
 *
 * The whole tree ships, recursively, with POSIX-relative paths preserved. A
 * directory rather than an explicit list because reference files are prose that
 * accrues as the author writes: a list means every new file is one forgotten
 * edit away from an agent that cannot find it. The cost is that the shipped set
 * is not visible in the def, so the compile path reports what it collected.
 *
 * Reference files are never injected into an agent's prompt wholesale — they are
 * searched on demand, which is what makes a large `mode: "auto"` item cheap.
 */
export function knowledgeDir(path: string, base: string | UrlLike): KnowledgeDirSource {
  return { [KNOWLEDGE_DIR]: { path, base: typeof base === "string" ? base : base.href } };
}

/** Whether a value is a {@link knowledgeFile} marker. */
export function isKnowledgeFileSource(v: unknown): v is KnowledgeFileSource {
  return typeof v === "object" && v !== null && KNOWLEDGE_FILE in v;
}

/** Whether a value is a {@link knowledgeDir} marker. */
export function isKnowledgeDirSource(v: unknown): v is KnowledgeDirSource {
  return typeof v === "object" && v !== null && KNOWLEDGE_DIR in v;
}

/**
 * What the item is, which decides how it reaches an agent.
 *
 * - `"agents.md"` — standing workspace instructions. Injected in FULL on every
 *   turn regardless of {@link KnowledgeMode}. At most one per workspace.
 * - `"skill"` — an instruction set the agent follows when it applies.
 * - `"doc"` — reference material. Same injection rules as `"skill"`; the two
 *   differ in how the platform files them, not in what the agent receives.
 */
export type KnowledgeType = "agents.md" | "skill" | "doc";

/**
 * When the body reaches the agent. Ignored for `type: "agents.md"`.
 *
 * - `"always"` — full body, every turn. Costs its whole length on every request.
 * - `"auto"` — name and description only, as a menu; the agent loads the body
 *   when a request matches. The default, and the right choice for anything long.
 * - `"referenced"` — full body, only on turns whose message names the item.
 */
export type KnowledgeMode = "always" | "auto" | "referenced";

/** Authoring shape for a knowledge item. */
export interface KnowledgeDef {
  /**
   * Type-only kind marker — never set at runtime. It makes a def of another kind
   * a compile error in the wrong `register*` call.
   */
  readonly __kind?: "knowledge";
  /** Workspace-unique name. Also how a `mode: "referenced"` item is addressed. */
  name: string;
  /** Accepted export warnings for this def ({@link DiagnosticsFor}). Never emitted. */
  diagnostics?: DiagnosticsFor<"knowledge">;
  /**
   * What the item is for. For `mode: "auto"` this is the ONLY thing the agent
   * sees until it decides to load the body, so write it to be matched against a
   * user's request rather than as a title.
   */
  description?: string;
  /** Defaults to `"skill"`. */
  type?: KnowledgeType;
  /** Defaults to `"auto"`. Ignored when `type` is `"agents.md"`. */
  mode?: KnowledgeMode;
  /** Defaults to `true`. A disabled item is stored and never reaches an agent. */
  enabled?: boolean;
  /** The markdown body. Required — see {@link knowledgeFile}. */
  body: KnowledgeFileSource;
  /** Optional reference files searched on demand — see {@link knowledgeDir}. */
  refs?: KnowledgeDirSource;
  /** Override the derived identity. Normally left to the lock. */
  guid?: string;
  tags?: string[];
}

/** The flattened importable knowledge `xdo`. */
export interface KnowledgeXdo {
  name: string;
  description: string;
  /** Filled from {@link KnowledgeDef.body} in the compile path, not here. */
  content: string;
  scope: "workspace";
  mode: KnowledgeMode;
  knowledge_type: KnowledgeType;
  enabled: boolean;
  locked: boolean;
  references: string[];
  linked_refs: unknown[];
  tag: Array<{ tag: string }>;
  guid?: string;
}

/** Encode a {@link KnowledgeDef} into its flattened importable `xdo`. */
export function encodeKnowledge(def: KnowledgeDef): KnowledgeXdo {
  if (!def.name) {
    throw new Error("knowledge kind: `name` is required.");
  }
  if (!isKnowledgeFileSource(def.body)) {
    throw new Error(
      `knowledge "${def.name}": \`body\` must be a knowledgeFile("./x.md", import.meta.url) ` +
        `marker. A knowledge body is authored as a markdown FILE, not a string.`,
    );
  }
  if (def.refs !== undefined && !isKnowledgeDirSource(def.refs)) {
    throw new Error(
      `knowledge "${def.name}": \`refs\` must be a knowledgeDir("./dir", import.meta.url) marker.`,
    );
  }
  return {
    name: def.name,
    description: def.description ?? "",
    // Bodies are read in the compile path; see the module header.
    content: "",
    // Not authorable: a user-scoped item is private to one UI user and is
    // excluded from branch clone and merge, so it has no meaning in source.
    scope: "workspace",
    mode: def.mode ?? "auto",
    knowledge_type: def.type ?? "skill",
    enabled: def.enabled ?? true,
    // Instance-owned state, gated on a permission this SDK does not model.
    locked: false,
    // Derived by the platform from the stored reference files — never authored.
    references: [],
    // Deferred: linked refs never reach an agent's prompt, and the bulk
    // transport does not carry them.
    linked_refs: [],
    tag: encodeTags(def.tags),
  };
}

/**
 * Identity-ish factory, for `const` inference at the call site.
 *
 * Returns the def unchanged — a knowledge item has no resolvable public address,
 * so unlike `query()` or `mcpServer()` there is no handle to hang accessors on.
 */
export function knowledge(def: KnowledgeDef): KnowledgeDef {
  return brandDef(def, "knowledge");
}

export const knowledgeKind: ObjectKind<KnowledgeDef, KnowledgeXdo> = {
  name: "knowledge",
  payloadKey: "knowledge",
  encode: encodeKnowledge,
};

registerKind(knowledgeKind);
