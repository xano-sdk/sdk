/**
 * The two fields a `--json` reader acts on next, added to every document that
 * names a backend: `selector`, the spelling any command's backend slot takes
 * (`ephemeral:e4f2-9ab1`, `tenant:acme`, `local:<name>`, `workspace`),
 * and `workspaceId`, the numeric workspace it acts on — for an ephemeral or a
 * tenant, the workspace it lives under.
 *
 * Read off the fields the documents already carry — a write's `destination`,
 * a read's `kind` + `name` (`tables`, `test`), `status`'s tracked backend and
 * `workspace` — so each command keeps one shape and the agent-facing pair is
 * spelled the same everywhere. A document that already sets a field keeps it.
 */

type Doc = Record<string, unknown>;

const BACKEND_KINDS: ReadonlySet<string> = new Set(["workspace", "ephemeral", "tenant", "local"]);

const isObject = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The selector for a backend of `kind` named `name` — undefined for a kind no slot takes. */
export function backendSelector(kind: unknown, name: unknown): string | undefined {
  if (typeof kind !== "string" || !BACKEND_KINDS.has(kind)) return undefined;
  if (kind === "workspace") return "workspace";
  const n = text(name);
  // A name already spelled as this kind's selector is that selector, never `ephemeral:ephemeral:…`.
  if (n !== undefined) return n.startsWith(`${kind}:`) ? n : `${kind}:${n}`;
  // A bare ephemeral or engine is the one this project tracks; a tenant needs its name.
  return kind === "tenant" ? undefined : kind;
}

function derive(doc: Doc): { selector?: string; workspaceId?: number } {
  const out: { selector?: string; workspaceId?: number } = {};
  const destination = doc.destination;
  if (isObject(destination)) {
    out.selector = backendSelector(destination.kind, destination.label);
    if (typeof destination.workspaceId === "number") out.workspaceId = destination.workspaceId;
  } else if (typeof doc.kind === "string" && BACKEND_KINDS.has(doc.kind) && "name" in doc) {
    out.selector = backendSelector(doc.kind, doc.name);
  } else if (isObject(doc.deployed) && "environment" in doc) {
    // `status`: the backend a bare command defaults to.
    const kind = doc.deployed.kind;
    const env = isObject(doc.environment) ? doc.environment.name : undefined;
    if (kind === "ephemeral" && text(env) !== undefined) out.selector = `ephemeral:${env as string}`;
    else if (kind === "local") out.selector = "local";
  }
  if (out.workspaceId === undefined && isObject(doc.workspace) && typeof doc.workspace.id === "number") {
    out.workspaceId = doc.workspace.id;
  }
  return out;
}

/** `doc` with `selector` and `workspaceId` added where it names a backend and lacks them. */
export function withBackendFields(value: unknown): unknown {
  if (!isObject(value) || "error" in value) return value;
  const { selector, workspaceId } = derive(value);
  return {
    ...value,
    ...(selector !== undefined && !("selector" in value) ? { selector } : {}),
    ...(workspaceId !== undefined && !("workspaceId" in value) ? { workspaceId } : {}),
  };
}
