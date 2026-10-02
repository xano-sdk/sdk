/**
 * Where a knowledge item's markdown lives in a project tree.
 *
 * One module so the two directions cannot drift: codegen WRITES these paths when
 * it pulls a workspace, and an author READS them when they point a
 * {@link import("./knowledge.js").knowledgeFile} at one. A layout that disagreed
 * across the two would produce a tree that pulls cleanly and re-exports empty.
 *
 * The shape mirrors how the platform itself files knowledge, so a tree pulled
 * here reads the same as one seen in the Xano UI:
 *
 * ```text
 * knowledge/agents.md                      type "agents.md"
 * knowledge/skills/<name>/SKILL.md         type "skill"
 * knowledge/docs/<name>.md                 type "doc"
 * ```
 *
 * Reference files nest under a `refs/` subdirectory of the item's own folder
 * rather than sitting flat beside the body. Flat is what the platform stores,
 * but a `knowledgeDir` ships its WHOLE tree — so a flat layout would collect the
 * body as one of its own reference files. The subdirectory is what keeps
 * "the directory is the ref set" true.
 */
import type { KnowledgeType } from "./knowledge.js";

/** A name reduced to one path segment: lowercase, non-alphanumerics folded to `_`. */
export function knowledgePathSegment(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  // A name of only punctuation would otherwise yield "", and an empty segment
  // silently collapses the path into its parent directory.
  return slug === "" ? "item" : slug;
}

/**
 * The item's directory, relative to the `knowledge/` root — the folder its
 * reference files live under. `null` for `agents.md`, which is a single file at
 * the root and owns no folder.
 */
export function knowledgeItemDir(type: KnowledgeType, name: string): string | null {
  const seg = knowledgePathSegment(name);
  switch (type) {
    case "agents.md":
      return null;
    case "skill":
      return `skills/${seg}`;
    case "doc":
      return `docs/${seg}`;
  }
}

/** The markdown body's path, relative to the `knowledge/` root. */
export function knowledgeBodyPath(type: KnowledgeType, name: string): string {
  switch (type) {
    case "agents.md":
      return "agents.md";
    case "skill":
      return `${knowledgeItemDir(type, name)}/SKILL.md`;
    case "doc":
      return `${knowledgeItemDir(type, name)}.md`;
  }
}

/**
 * The reference-file directory, relative to the `knowledge/` root, or `null` for
 * a type that owns no folder.
 */
export function knowledgeRefsDir(type: KnowledgeType, name: string): string | null {
  const dir = knowledgeItemDir(type, name);
  return dir === null ? null : `${dir}/refs`;
}
