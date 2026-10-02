/**
 * The documentation token: declared in source by the GATE it sets, and resolved
 * from `xano/.secrets.json` when a bundle is built.
 *
 * A workspace and each API group can gate their hosted documentation behind a
 * token. That token is a secret, so it must not ride into committed source on a
 * pull. The approach is the one `workspaceConfig({ env })` applies to backend
 * env values, with one difference that decides everything else here: a
 * backend env var is addressed by NAME, and a documentation token is addressed
 * by the OBJECT that holds it. It has no name of its own.
 *
 * So the source says only that a gate exists — `require_token: true`, with no
 * token — and the value is stored under the scope's identity in the sidecar.
 * There is no derived variable name: a name derived from an object exists solely
 * to squeeze that object through a flat namespace, and every mechanism guarding
 * such a derivation (sanitizing into the dotenv charset, uniquifying against
 * siblings and the backend names, an unrepresentable-name failure path, and a
 * filter keeping all of them out of `payload.env`) is unnecessary once the
 * object is addressed directly.
 *
 * One module owns three facts so the encoders, the build, the pull and the CLI
 * cannot disagree about any of them:
 *
 * - what DECLARES a gate, and the scope KEY that gate's value is stored under;
 * - what happens when a declared gate resolves to nothing — no `documentation`
 *   key at all, never an empty token;
 * - that a resolved token is substituted into the documentation block and
 *   nowhere else. It is not a backend variable and must never reach the bundle's
 *   top-level `env`, which is the workspace's own environment, readable from
 *   every stack with `env("NAME")`.
 */

/**
 * The sidecar's filename, without a directory.
 *
 * Separate from the prefixed spelling below because the prefix is not a
 * constant: a project keeps this file beside its backend, which is `xano/` for a
 * scaffolded one and whatever directory the project chose otherwise. A caller
 * composing a path for a REAL project joins this onto the resolved directory.
 */
export const WORKSPACE_SECRETS_BASENAME = ".secrets.json";

/**
 * `xano/.secrets.json`, project-relative — the scaffold's spelling, and the
 * label used when no real path has been resolved.
 *
 * Spelled here rather than imported from `emit/secrets-file.ts`, which owns the
 * file, because the guards that name it in an error run on the browser-safe
 * authoring path and must stay free of `node:fs`. The owning module imports this
 * constant back, so there is still exactly one spelling and nothing to drift.
 */
export const WORKSPACE_SECRETS_FILE = `xano/${WORKSPACE_SECRETS_BASENAME}`;

/**
 * How a documentation-token remedy names the secrets file and the command that
 * mints into it. `export()` cannot see the filesystem, so it defaults to the
 * scaffold's layout; a compile from an entry file passes the file that entry
 * actually reads and `xanosdk secrets fill <entry>`, which works outside a
 * scaffold where the bare command finds no entry.
 */
export interface SecretsRemedy {
  /** The secrets file, as the reader names it (`xano/.secrets.json`, `cases/.secrets.json`). */
  readonly file: string;
  /** The command that mints the missing tokens into it. */
  readonly fill: string;
  /** How this caller supplies a scope's token by hand. Default: the `--doc-token` flag. */
  readonly supply?: (scope: string) => string;
  /** How this caller sends a scope's token empty on purpose. Default: the `--allow-empty-doc-token` flag. */
  readonly allowEmpty?: (scope: string) => string;
}

/** `--doc-token "<scope>=<value>"`, or what `remedy` says instead. */
export function supplyTokenRemedy(remedy: SecretsRemedy, scope: string): string {
  return remedy.supply?.(scope) ?? `--doc-token "${scope}=<value>"`;
}

/** `--allow-empty-doc-token="<scope>"`, or what `remedy` says instead. */
export function allowEmptyTokenRemedy(remedy: SecretsRemedy, scope: string): string {
  return remedy.allowEmpty?.(scope) ?? `--allow-empty-doc-token="${scope}"`;
}

/** The scaffold's answer, for a caller that did not say. */
export const SCAFFOLD_SECRETS_REMEDY: SecretsRemedy = { file: WORKSPACE_SECRETS_FILE, fill: "xanosdk secrets fill" };

/** Which documentation block a token belongs to. */
export type DocumentationScope =
  | { readonly kind: "workspace" }
  | {
      readonly kind: "api_group";
      readonly name: string;
      /**
       * The group's stored guid — its IDENTITY, which the name is not: two
       * groups may share a name, and a rename changes the name.
       *
       * Stamped at registration rather than at export (see `Xano#encodeOne`), so
       * it is readable everywhere this scope is, including the deploy path that
       * has to refuse an unsupplied token before a bundle exists.
       */
      readonly guid?: string;
    };

/** The scope, as a line of a report or an error names it. */
export function documentationScopeLabel(scope: DocumentationScope): string {
  return scope.kind === "workspace" ? "the workspace" : `API group "${scope.name}"`;
}

/**
 * The scope, as a user TYPES it: `workspace`, or the group's name.
 *
 * What `--doc-token` and `--allow-empty-doc-token` accept, and what the sidecar
 * stores beside each value. Distinct from {@link documentationScopeLabel},
 * which is prose — a flag value has to be copy-pasteable, and `API group "Public
 * API"` is not.
 *
 * The guid is deliberately not this. It is the storage key precisely because it
 * is stable, and a user cannot type it from anything they can see.
 */
export function documentationScopeFlagLabel(scope: DocumentationScope): string {
  return scope.kind === "workspace" ? "workspace" : scope.name;
}

/**
 * The key this scope's token is stored under in `xano/.secrets.json`.
 *
 * Keyed by GUID for an API group, never by name. Two groups may legitimately
 * share a stored name — same-name siblings are a warning, not a refusal — so a
 * name-keyed store would collapse the pair to one entry and gate one group's doc
 * site with the other's token.
 *
 * A guid survives a rename when the lock pins it, which is the ordinary case;
 * without a lock it is derived from the name, so a rename orphans the entry.
 * That is what the orphan report exists to make visible rather than silent.
 */
export function documentationScopeKey(scope: DocumentationScope): string {
  return scope.kind === "workspace" ? "workspace" : `${API_GROUP_SCOPE_PREFIX}${scope.guid ?? scope.name}`;
}

/**
 * An API group's scope keys as `apiGroup:<guid>` — the SDK's name for the kind,
 * like every other key the CLI prints. Earlier builds wrote the engine's section
 * name (`app:<guid>`); {@link normalizeDocumentationScopeKey} reads that too.
 */
const API_GROUP_SCOPE_PREFIX = "apiGroup:";

/** A scope key in the current spelling — `app:<guid>` (the earlier one) reads as `apiGroup:<guid>`. */
export function normalizeDocumentationScopeKey(key: string): string {
  return key.startsWith("app:") ? `${API_GROUP_SCOPE_PREFIX}${key.slice("app:".length)}` : key;
}

/**
 * The scope one ENCODED API-group object stands for.
 *
 * One constructor because four readers ask the same question — the declaration
 * scan, the resolver, the pull's pre-pass and the decoder — and a scope is an
 * IDENTITY. Two of them disagreeing about whether an empty-string guid counts
 * would not fail anything: it would key one group's token under its name and
 * another's under its guid, so a value written by one reader is invisible to
 * the next, which is the failure this module exists to prevent.
 */
export function apiGroupScope(record: {
  readonly name?: unknown;
  readonly guid?: unknown;
}): Extract<DocumentationScope, { kind: "api_group" }> {
  const guid = typeof record.guid === "string" && record.guid !== "" ? record.guid : undefined;
  return {
    kind: "api_group",
    name: typeof record.name === "string" ? record.name : "(unnamed)",
    ...(guid !== undefined ? { guid } : {}),
  };
}

/** A literal, non-empty token an ENCODED `documentation` block spells out. */
export function documentationTokenLiteral(block: unknown): string | undefined {
  if (block === null || typeof block !== "object" || Array.isArray(block)) return undefined;
  const token = (block as Record<string, unknown>).token;
  return typeof token === "string" && token !== "" ? token : undefined;
}

/**
 * Does this ENCODED block name NO token, so a stored one may be substituted?
 *
 * Key ABSENCE, and that distinction is load-bearing in three places. A block
 * that has been resolved carries a `token` and must not be re-read as
 * unresolved — `export()` sweeps twice, once for the guards and once after the
 * lock, and `buildBundle` sweeps again for callers that reach it directly, so a
 * resolved block that still answered `true` here would be dropped by the next
 * pass. An opt-out resolves to `token: ""`, which is a deliberately cleared gate
 * and equally must survive. And a block carrying a literal token answers `false`
 * here too — it is refused at export by `checkDocumentationTokens`, where every
 * finding in a build lands in one bag.
 *
 * Deliberately NOT "declares a gate". A token and the gate over it are
 * independent fields, and a workspace may store a value with `require_token:
 * false` — which the engine reads as not gated. Keying substitution off the
 * gate left that value unreachable: the pull wrote it to the sidecar and no
 * export ever looked it up, so the bytes shipped `token: ""` and cleared it.
 * Whether the block is GATED decides something else entirely — what an
 * unsupplied value means — and {@link declaresDocumentationGate} answers that.
 */
export function awaitsDocumentationToken(block: unknown): boolean {
  if (block === null || typeof block !== "object" || Array.isArray(block)) return false;
  return !Object.hasOwn(block as Record<string, unknown>, "token");
}

/**
 * Does this ENCODED block declare a GATE whose token is still to be supplied?
 *
 * `require_token: true` with no `token` key. The narrower of the two questions,
 * and the one that decides whether an unsupplied value is a refusal: a gate
 * nobody supplied must never ship, where an ungated block with no stored value
 * is simply a scope that has no token, which is an ordinary thing to be.
 */
export function declaresDocumentationGate(block: unknown): boolean {
  if (!awaitsDocumentationToken(block)) return false;
  return (block as Record<string, unknown>).require_token === true;
}

/** One scope awaiting a stored token, with the key that value lives under. */
export interface DocumentationTokenDeclaration {
  readonly scope: DocumentationScope;
  /** {@link documentationScopeKey} of `scope`. Carried so callers need not recompute it. */
  readonly key: string;
  /**
   * Whether the scope also declares a GATE (`require_token: true`).
   *
   * Carried rather than re-derived because the two audiences want different
   * halves of this list. Anything asking "could a sidecar entry belong to this
   * scope" — the orphan report, the label map — wants every entry, or it calls a
   * value that IS being substituted an orphan. Anything acting on the gate
   * specifically — `secrets fill`, which mints a token for a gate that has no
   * live value to pull — wants only the flagged ones, because minting a token
   * for a scope that is not gated invents a secret nothing reads.
   */
  readonly gated: boolean;
  /**
   * Whether the scope PUBLISHES its docs — an API group's `swagger: true`.
   * Always false for the workspace. An unsupplied group gate means different
   * things either way: published, the export fails for it (the bytes would
   * expose the group); unpublished, it warns and completes.
   */
  readonly published: boolean;
}

/**
 * Every scope in a workspace object plus its API groups that names no token, in
 * workspace-then-group order — each flagged with whether it is also gated.
 *
 * Read off the ENCODED shapes rather than the defs, so the CLI, the guards and
 * the build all answer this question from the same bytes — and so a decoded
 * workspace is covered exactly like a hand-authored one.
 */
export function documentationTokenDeclarations(args: {
  readonly workspace?: unknown;
  readonly apiGroups?: readonly unknown[];
}): DocumentationTokenDeclaration[] {
  const out: DocumentationTokenDeclaration[] = [];
  const ws = args.workspace;
  if (ws !== null && typeof ws === "object" && !Array.isArray(ws)) {
    const block = (ws as Record<string, unknown>).documentation;
    if (awaitsDocumentationToken(block)) {
      const scope = { kind: "workspace" } as const;
      out.push({
        scope,
        key: documentationScopeKey(scope),
        gated: declaresDocumentationGate(block),
        published: false,
      });
    }
  }
  for (const group of args.apiGroups ?? []) {
    if (group === null || typeof group !== "object" || Array.isArray(group)) continue;
    const record = group as Record<string, unknown>;
    if (!awaitsDocumentationToken(record.documentation)) continue;
    const scope = apiGroupScope(record);
    out.push({
      scope,
      key: documentationScopeKey(scope),
      gated: declaresDocumentationGate(record.documentation),
      published: record.swagger === true,
    });
  }
  return out;
}

/**
 * Substitute a resolved value into one encoded `documentation` block, or say the
 * block must not be emitted at all.
 *
 * `undefined` means DROP THE KEY, and that is the whole rule: a declared gate
 * nobody supplied must never become `token: ""`. Without it, an `export` that
 * warned and completed would write the emptying payload into a bundle file, and
 * a later `deploy --bundle` on that artifact has no source left to classify — so
 * the refusal cannot fire and the two-step pipeline clears the live gate.
 *
 * An OPT-OUT is the one way an unresolved gate becomes an empty token, and it is
 * the author saying they meant to clear it.
 */
export function resolveDocumentationBlock(
  block: unknown,
  key: string,
  values: Readonly<Record<string, string>>,
  allowEmpty: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (block === null || typeof block !== "object" || Array.isArray(block)) return undefined;
  const record = { ...(block as Record<string, unknown>) };
  if (!awaitsDocumentationToken(record)) return record;
  // OWN-property read. A plain bracket read on an object literal resolves
  // `toString`, `constructor` and `valueOf` to inherited FUNCTIONS, so a key
  // shaped like one would read as supplied, skip the refusal, and write a
  // function into `token` — signing bytes the engine then rejects, on a
  // gate-bearing block, instead of giving the clear unsupplied error.
  if (Object.hasOwn(values, key)) return { ...record, token: values[key]! };
  if (allowEmpty.has(key)) return { ...record, token: "" };
  // Nothing stored. Only a declared GATE is a refusal — shipping it ungated
  // would publish a doc site the author asked to close. An UNGATED block with
  // no stored value is a scope that simply has no token, and is emitted as
  // authored, exactly as it was before any of this existed.
  return declaresDocumentationGate(record) ? undefined : record;
}

/**
 * Resolve every `documentation` block in a payload, in place on a shallow copy.
 *
 * Applied to the workspace object and to each API group, which is every scope
 * that has one. The `app` section is mutated through fresh copies rather than in
 * place, because a registry's encoded objects outlive one `export()` call and a
 * second build must see the declaration, not a resolved value from the first.
 */
export function resolveDocumentationTokens(args: {
  readonly workspace: Record<string, unknown>;
  readonly apiGroups: unknown[] | undefined;
  /** Scope key → the token stored for it. */
  readonly values: Readonly<Record<string, string>>;
  /** Scope keys the author has said may ship with the gate cleared. */
  readonly allowEmpty?: ReadonlySet<string>;
}): {
  workspace: Record<string, unknown>;
  apiGroups: unknown[] | undefined;
  /**
   * Groups that DECLARED a gate and got no value, by name.
   *
   * Reported separately because dropping the key means opposite things in the
   * two scopes: on the workspace it leaves the target alone, on a group it is
   * written as the engine default and CLEARS the gate. The guard needs to tell
   * "this group ships ungated because nobody asked for a gate" from "this group
   * ships ungated although the author asked for one".
   *
   * By NAME rather than by scope key, because its one consumer reports to a
   * human about which doc sites are about to be public, and a guid is not
   * something a reader can match to anything they can see.
   */
  unresolvedGroups: string[];
} {
  // Either spelling of a group's key resolves (see normalizeDocumentationScopeKey).
  const allowEmpty = new Set([...(args.allowEmpty ?? [])].map(normalizeDocumentationScopeKey));
  const values = Object.fromEntries(
    Object.entries(args.values).map(([key, value]) => [normalizeDocumentationScopeKey(key), value]),
  );
  args = { ...args, values, allowEmpty };
  const workspace = { ...args.workspace };
  if (Object.hasOwn(workspace, "documentation")) {
    const resolved = resolveDocumentationBlock(
      workspace.documentation,
      documentationScopeKey({ kind: "workspace" }),
      args.values,
      allowEmpty,
    );
    if (resolved === undefined) delete workspace.documentation;
    else workspace.documentation = resolved;
  }
  const unresolvedGroups: string[] = [];
  const apiGroups = args.apiGroups?.map((group) => {
    if (group === null || typeof group !== "object" || Array.isArray(group)) return group;
    const record = group as Record<string, unknown>;
    if (!Object.hasOwn(record, "documentation")) return group;
    const scope = apiGroupScope(record);
    const declared = declaresDocumentationGate(record.documentation);
    const resolved = resolveDocumentationBlock(
      record.documentation,
      documentationScopeKey(scope),
      args.values,
      allowEmpty,
    );
    const copy = { ...record };
    if (resolved === undefined) {
      delete copy.documentation;
      if (declared) unresolvedGroups.push(scope.name);
    } else copy.documentation = resolved;
    return copy;
  });
  return { workspace, apiGroups, unresolvedGroups };
}
