/**
 * Where a deploy's bytes come from.
 *
 * Three answers, and they are not variations on each other —
 *
 * - **a local entry** (named, or resolved from the project) — compiled here,
 *   carrying seed content and the lockfile write that goes with it;
 * - **a bundle on disk** — already compiled, `--bundle`;
 * - **a live backend** (`release:<name>`, `ephemeral:<name>`, `tenant:<name>`,
 *   `workspace`, `local[:<name>]`) — fetched, not compiled, and carrying
 *   no seed at all.
 *
 * The third is what makes the iterate loop expressible: take a release, stand
 * it up, look at it — without scaffolding a whole project around a backend you
 * did not author.
 *
 * A fetched source carries **no seed content**. Seed rows are resolved from a
 * local registry at compile time; a backend that already exists has whatever
 * data it has, and inventing an empty seed for it would be a lie the archive
 * then acts on.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { backendDirIn } from "./backend-dir.js";
import { relForwardSlash } from "../util/rel-path.js";
import { UsageError } from "./errors.js";
import { BARE, isKindShaped, parseSource, type SourceKind } from "./source-selector.js";
import { resolveSource, type CredentialProvider, type ResolveDeps } from "./source-resolve.js";
import { exportWorkspaceBundle } from "../deploy/workspace-export.js";
import { encodeWorkspaceArchive, readArchiveEntries } from "../validate/archive.js";
import { calcSignatureJson } from "../workspace/export.js";
import { tarGz, type TarFile } from "../util/tar.js";
import { downloadRelease } from "../deploy/release.js";
import type { SeedContentFile } from "../workspace/seed.js";

/**
 * The kinds a deploy can take bytes FROM. A release is one of them; `file` is a
 * path. A Xano Engine is one too: it is a running workspace like the others,
 * exported through its own bearer rather than a Xano credential.
 */
export const DEPLOY_SOURCE_KINDS = [
  "release",
  "ephemeral",
  "tenant",
  "workspace",
  "local",
] as const satisfies readonly SourceKind[];

/** The entry's filename. The DIRECTORY is resolved, not assumed — see below. */
const ENTRY_FILE = "index.ts";

/**
 * True when `raw` names a backend rather than a path.
 *
 * Deliberately narrow: anything kind-shaped, plus the bare keywords. A path is
 * everything else, which keeps `deploy ./xano/index.ts` meaning exactly what it
 * always did. The parser owns the refusals — this only decides which arm to
 * enter.
 */
export function looksLikeSource(raw: string): boolean {
  return isKindShaped(raw) || BARE.includes(raw as SourceKind);
}

/**
 * The project's entry file, for a bare `xanosdk deploy`.
 *
 * `xano/index.ts` for a scaffolded project, and the discovered backend's entry
 * for one whose backend lives elsewhere — `backendDirIn` prefers `xano/`
 * whenever it exists, so the scaffolded answer cannot move. Before this, a
 * project with its backend in `backend/` got "missing required <file>" from a
 * bare deploy, which reads as "this command takes an argument" rather than
 * "I looked in one place and it was not there".
 *
 * Returns undefined rather than throwing so the caller can raise the usage
 * error that names `<file>`, keeping one message for "you gave me nothing" no
 * matter which branch noticed. The path comes back RELATIVE to `cwd` because it
 * is echoed into messages and into the tracked deploy record, where an absolute
 * temp path would be noise.
 */
export function resolveProjectEntry(cwd: string): string | undefined {
  const entry = join(backendDirIn(cwd), ENTRY_FILE);
  if (!existsSync(entry)) return undefined;
  return `./${relForwardSlash(cwd, entry)}`;
}

/** A backend fetched from somewhere else, ready to import. */
export interface FetchedSource {
  /** A gzipped tar carrying `workspace.json` — what the import route consumes. */
  archive: Uint8Array;
  /** How the source names itself, for the tracked record: `release:main`. */
  provenance: string;
  /** How it names itself to a person. */
  label: string;
  /**
   * What people call it — an ephemeral's or tenant's display name — when its
   * record carries one that differs from the name. Human lines put it beside
   * the handle (`tenant:tdra-… ("Prod")`).
   */
  display?: string;
}

/**
 * Fetch a live source as a bundle.
 *
 * The export route is the same for every kind because they are all workspaces
 * underneath — what differs is which base URL and workspace id address them,
 * and which bearer, which is what the resolver answered. The credential is a
 * provider for that reason: a Xano Engine's export needs none, so it is only
 * read for a hosted kind.
 */
export async function fetchSourceArchive(
  credential: CredentialProvider,
  raw: string,
  cwd: string = process.cwd(),
  deps: Omit<ResolveDeps, "cwd"> = {},
): Promise<FetchedSource> {
  const source = parseSource(raw, DEPLOY_SOURCE_KINDS, { command: "deploy" });
  const resolved = await resolveSource(source, credential, { ...deps, cwd });

  // A release is already an archive — the server stores it as the same gzipped
  // tar carrying `workspace.json` that a compile produces, which is why it can
  // be stood up through the ordinary import rather than a pipeline of its own.
  // Its envelope is signed as a `schema`, though, which the import refuses, so
  // it is re-signed as a `workspace` on the way through.
  if (resolved.kind === "release" && resolved.backend.kind === "hosted") {
    const { auth } = resolved.backend;
    const release = resolved.release;
    if (release?.id === undefined) {
      throw new UsageError(`Release "${raw}" carries no id, so it cannot be deployed.`, {
        helpFor: { command: "deploy" },
      });
    }
    return {
      archive: asWorkspaceArchive(
        await downloadRelease(auth, { workspaceId: auth.workspaceId, id: release.id }),
        release.name,
      ),
      provenance: resolved.provenance,
      label: release.name,
    };
  }

  // Everything else is a running workspace, so it is exported and re-packed.
  // No seed content: rows are resolved from a local registry at compile time,
  // and a backend that already exists has whatever data it has.
  const exported = await exportWorkspaceBundle(resolved.bearer, resolved.target);
  const display = resolved.target.display;
  return {
    archive: encodeWorkspaceArchive(JSON.stringify(exported)),
    provenance: resolved.provenance,
    label: resolved.target.label,
    ...(display !== undefined && display !== "" && display !== resolved.target.label ? { display } : {}),
  };
}

/** The archive member the import reads the bundle from. */
const WORKSPACE_JSON = "workspace.json";

/**
 * The `table.column` of every password column a release archive carries seeded
 * values for.
 *
 * A stored password is a salted HMAC keyed by the key material of the
 * environment that made it — each workspace, ephemeral and tenant has its own —
 * which no archive carries; the import refuses it, by design. So a seeded
 * release lands those hashes byte-for-byte (measured: identical bytes on both
 * sides), the import keeps them as they are, and anywhere but the environment
 * the release was cut from they cannot verify: a login against the row fails
 * as a bad password (measured; landed back on its source, they work). Nothing
 * the SDK can send changes that; the caller says so.
 *
 * Top-level columns only, which is where an auth table keeps its password.
 */
export function passwordSeedColumns(archive: Uint8Array): string[] {
  const entries = readArchiveEntries(archive);
  const raw = entries[WORKSPACE_JSON];
  if (raw === undefined) return [];
  const payload = (JSON.parse(raw.toString("utf8")) as { payload?: { dbo?: unknown } }).payload;
  const tables = Array.isArray(payload?.dbo) ? (payload.dbo as Record<string, unknown>[]) : [];
  const out: string[] = [];
  for (const table of tables) {
    const { guid, name, schema } = table;
    if (typeof guid !== "string" || typeof name !== "string" || !Array.isArray(schema)) continue;
    const columns = (schema as Record<string, unknown>[])
      .filter((c) => c.type === "password" && typeof c.name === "string")
      .map((c) => c.name as string);
    if (columns.length === 0) continue;
    const rows = Object.entries(entries)
      .filter(([file]) => file.startsWith(`content/${guid}-`))
      .flatMap(([, data]) => {
        const rowsIn = (JSON.parse(data.toString("utf8")) as { payload?: unknown }).payload;
        return Array.isArray(rowsIn) ? (rowsIn as Record<string, unknown>[]) : [];
      });
    for (const column of columns) {
      if (rows.some((r) => typeof r[column] === "string" && r[column] !== "")) out.push(`${name}.${column}`);
    }
  }
  return out;
}

/**
 * The seed rows a fetched archive carries, as the `content/` members the
 * compile would have produced — a seeded release is the one source that has
 * any. Read only to tell a `--keep-data` merge which new tables arrive with
 * rows it does not write; the archive itself is uploaded as it was fetched.
 */
export function archiveSeedContent(archive: Uint8Array): SeedContentFile[] {
  return Object.entries(readArchiveEntries(archive))
    .filter(([name]) => name.startsWith("content/") && name.endsWith(".json"))
    .map(([name, data]) => ({ name, content: data.toString("utf8") }));
}

/**
 * The API groups whose documentation stays gated wherever this bundle lands.
 *
 * A group's gate and token are stored ON the group, so they travel inside a
 * release as the group does — unlike the workspace's own documentation block,
 * which a release does not carry. The engine's condition: `swagger` publishes
 * the docs, and `require_token` gates them only beside a non-empty token.
 */
export function gatedApiGroups(bundle: unknown): string[] {
  const rows = (bundle as { payload?: { app?: unknown } } | null)?.payload?.app;
  if (!Array.isArray(rows)) return [];
  const out: string[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const group = row as Record<string, unknown>;
    const doc = group.documentation as Record<string, unknown> | undefined;
    const gated = group.swagger === true && doc?.require_token === true && typeof doc.token === "string" && doc.token !== "";
    if (gated && typeof group.name === "string") out.push(group.name);
  }
  return out;
}

/**
 * A release archive, re-signed so the workspace import accepts it.
 *
 * The server stores a release with its `workspace.json` envelope signed as
 * `type: "schema"`, and the import route decodes only `type: "workspace"` —
 * anything else fails as "Invalid payload." The payload is the same shape
 * either way, so only the type changes and the signature is recomputed over
 * it. Every other member (the `content/` seed pages) is carried byte-for-byte.
 *
 * The stored signature is not re-checked here: the engine signed the text it
 * wrote, where a decimal reads `1.0`, and once parsed that is the number 1, so
 * a hash taken here would refuse a sound release. The new signature is taken
 * over exactly what is written, so the import's own check still holds. An
 * envelope already typed `workspace` goes through untouched.
 */
export function asWorkspaceArchive(archive: Uint8Array, label: string): Uint8Array {
  const entries = readArchiveEntries(archive);
  const raw = entries[WORKSPACE_JSON];
  if (raw === undefined) {
    throw new Error(`Release "${label}" has no ${WORKSPACE_JSON}, so it cannot be deployed.`);
  }
  const envelope = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  if (envelope.type === "workspace") return archive;
  const { sig: _stored, ...unsigned } = envelope;
  const retyped = { ...unsigned, type: "workspace" };
  const files: TarFile[] = [
    { name: WORKSPACE_JSON, data: Buffer.from(JSON.stringify({ ...retyped, sig: calcSignatureJson(retyped) }), "utf8") },
  ];
  for (const [name, data] of Object.entries(entries)) {
    if (name !== WORKSPACE_JSON) files.push({ name, data });
  }
  return tarGz(files);
}
