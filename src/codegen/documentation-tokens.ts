/**
 * The documentation tokens a bundle carries, collected once before any file is
 * generated so the pull can write them to `xano/.secrets.json`.
 *
 * A PRE-PASS rather than a decision made inside each kind's decoder, because a
 * decoder looking at one API group cannot see the set: the sidecar is one file
 * covering every scope, and it is written after the tree lands rather than
 * during the walk that builds it.
 *
 * It never invents a name. Keying by the scope's own identity means no
 * derivation, no sanitizing, no uniquifying against sibling groups or the
 * workspace's backend env names, and no unrepresentable-name failure path — all
 * of which a flat namespace would need to hold an object-scoped secret.
 */
import {
  apiGroupScope,
  documentationScopeKey,
  documentationScopeFlagLabel,
  documentationTokenLiteral,
  type DocumentationScope,
} from "../workspace/documentation-token.js";

/** What the pre-pass found, for the CLI to write and to verify against. */
export interface DocumentationTokenPlan {
  /**
   * Scope key → the token the bundle carried, with the label a report names it
   * by.
   *
   * RETURNED, never written here — the same contract `GeneratedProject.env` has.
   * The CLI uses it for exactly two things: writing the sidecar, and feeding the
   * values back into the round-trip check IN MEMORY, which would otherwise fail
   * against a bundle whose blocks carry a token the generated source deliberately
   * does not.
   */
  readonly values: Readonly<Record<string, DocumentationTokenEntry>>;
}

/**
 * One scope's stored token. `gated` is the block's own `require_token`: a fresh
 * workspace stores a token with the gate OFF, and a deploy counts only gated
 * scopes as needing a value — so a report must not say a deploy refuses for one
 * that is not.
 */
export interface DocumentationTokenEntry {
  readonly value: string;
  readonly label: string;
  readonly gated: boolean;
}

/** Whether an object's documentation block declares `require_token: true`. */
function gatedBlock(object: unknown): boolean {
  if (object === null || typeof object !== "object" || Array.isArray(object)) return false;
  const doc = (object as Record<string, unknown>).documentation;
  return doc !== null && typeof doc === "object" && (doc as Record<string, unknown>).require_token === true;
}

/** A non-empty documentation token stored on an object, if it has one. */
function storedToken(object: unknown): string | undefined {
  if (object === null || typeof object !== "object" || Array.isArray(object)) return undefined;
  return documentationTokenLiteral((object as Record<string, unknown>).documentation);
}

/**
 * The env var entries a payload declares, from whichever of the two places the
 * archive happens to carry them.
 *
 * Non-empty top-level `payload.env` wins, else the workspace object's own. The
 * guard is on NON-EMPTY rather than on presence: a bundle carrying
 * `payload.env: []` beside a populated `workspace.env` made the two readers
 * disagree — the decoded source declared every name while the value map came
 * back empty, so `.env.example` rendered "declares no env vars", the round-trip
 * check got no values to feed back and reported a mismatch the tree did not
 * have, and a later `pull` reported every still-declared name as dropped.
 *
 * Shared rather than spelled twice, because two readers of one rule is exactly
 * how that defect happened: the fix has to land for every reader at once.
 */
export function rawEnvEntries(
  payload: Record<string, unknown>,
): Array<{ name: string; value?: unknown }> {
  const workspace = payload.workspace;
  const onWorkspace =
    workspace !== null && typeof workspace === "object" && !Array.isArray(workspace)
      ? (workspace as Record<string, unknown>).env
      : undefined;
  const env = Array.isArray(payload.env) && payload.env.length > 0 ? payload.env : onWorkspace;
  if (!Array.isArray(env)) return [];
  return (env as Array<{ name?: unknown; value?: unknown }>)
    .filter((e): e is { name: string; value?: unknown } => typeof e?.name === "string" && e.name !== "");
}

/**
 * Collect every documentation token in `payload`, keyed by its scope.
 *
 * Scopes with no token contribute nothing: a workspace that never gated its docs
 * should not gain an entry to fill in.
 */
export function planDocumentationTokens(
  payload: Record<string, unknown>,
): DocumentationTokenPlan {
  const values: Record<string, DocumentationTokenEntry> = {};

  const record = (scope: DocumentationScope, value: string, gated: boolean): void => {
    values[documentationScopeKey(scope)] = { value, label: documentationScopeFlagLabel(scope), gated };
  };

  const workspaceToken = storedToken(payload.workspace);
  if (workspaceToken !== undefined) record({ kind: "workspace" }, workspaceToken, gatedBlock(payload.workspace));

  if (Array.isArray(payload.app)) {
    for (const group of payload.app) {
      const token = storedToken(group);
      if (token === undefined) continue;
      record(apiGroupScope(group as Record<string, unknown>), token, gatedBlock(group));
    }
  }
  return { values };
}
