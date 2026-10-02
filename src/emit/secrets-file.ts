/**
 * `xano/.secrets.json` — the secrets a PULL brought down and a PUSH sends back.
 *
 * A project has two secret files, and which one a value belongs in is decided by
 * how that value is ADDRESSED, not by which file came first:
 *
 * - a backend env var is addressed by NAME — `env("NAME")` is how a stack reads
 *   it, so the name is its identity, and `xano/.env` is the right shape. That
 *   file is hand-edited, and nothing writes it as a side effect;
 * - a documentation token is addressed by the OBJECT that holds it — this
 *   workspace, that API group. It has no name of its own, and inventing one is
 *   what forced the derive/sanitize/uniquify layer this file replaces. So it is
 *   keyed by identity here instead.
 *
 * That split also decides who owns each file. This one is written by the SDK, so
 * nobody hand-edits it and it can carry structure and provenance rather than
 * `KEY=VALUE` lines. A pull that finds tokens replaces it wholesale; a pull that
 * finds NONE leaves it alone rather than deleting values it cannot re-fetch, so
 * a stale entry is reported by the build's orphan check rather than silently
 * dropped. Provenance is not
 * decoration: one project reads one secrets file regardless of which environment
 * it deploys to, and "which instance did these come from" has no other answer
 * once the terminal scrollback is gone.
 *
 * The file is gitignored, so a teammate's clone has none and CI has none. That
 * is deliberate — this is a round-trip store, not a distribution mechanism, and
 * `--secrets-file` / `--doc-token` are how those two supply values instead.
 *
 * Node-only (`node:fs`), imported lazily by the command modules so the
 * browser-safe authoring bundle never pulls it in.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { displayPath, relForwardSlash } from "../util/rel-path.js";
import { shellQuote } from "../util/shell-quote.js";
import { LocalFileNotFoundError } from "./errors.js";
import { contextFlags } from "./context-flags.js";

import { backendDirFor, backendDirIn, projectRootFrom } from "./backend-dir.js";
import { atomicWrite } from "../util/atomic-write.js";

/**
 * `xano/.secrets.json` — the ignored file holding the values, project-relative.
 *
 * Re-exported from `workspace/documentation-token.ts` rather than composed from
 * `XANO_DIR` here: the build-time guards name this file in their errors
 * and run on the browser-safe authoring path, so they cannot reach a module that
 * imports `node:fs`. One spelling, on the side that can see it from everywhere.
 */
export { WORKSPACE_SECRETS_FILE } from "../workspace/documentation-token.js";
import { normalizeDocumentationScopeKey } from "../workspace/documentation-token.js";

/**
 * The shape version, bumped when a reader could misread an older file.
 *
 * Refused rather than migrated: this file can always be rebuilt by pulling
 * again, so guessing at an unfamiliar shape buys nothing and risks sending the
 * wrong token to a live doc site.
 */
export const SECRETS_FILE_VERSION = 1;

/** Which pull produced this file. Data, not a comment, so a build can read it. */
export interface SecretsProvenance {
  /** The instance the values came from. */
  readonly instance: string;
  /** The workspace id, as the meta API reports it. */
  readonly workspace?: number | string;
  /** The branch, when the pull named one. */
  readonly branch?: string;
  /** ISO 8601. */
  readonly at: string;
}

/** One stored token: the value, plus the human name anything reporting it uses. */
export interface SecretsTokenEntry {
  readonly value: string;
  /**
   * What a message calls this scope — `the workspace`, or the API group's name.
   *
   * Stored rather than re-derived because the orphan report's whole job is to
   * name an entry whose scope is GONE from the source, so there is nothing left
   * to derive it from. It is also what `--allow-empty-doc-token` and
   * `--doc-token` accept, since a guid is not something a user can type from
   * what they can see.
   */
  readonly label: string;
}

/** The whole file. */
export interface SecretsFile {
  readonly version: number;
  readonly pulledFrom: SecretsProvenance;
  /**
   * Scope key (`workspace`, `apiGroup:<guid>`) → the token stored for it. A file
   * an earlier build wrote keys a group `app:<guid>`; it reads as `apiGroup:`.
   */
  readonly documentationTokens: Readonly<Record<string, SecretsTokenEntry>>;
}

/**
 * How many random bytes a minted documentation token carries.
 *
 * Twenty, base64url-encoded with the padding dropped, is the shape a token
 * MINTED BY XANO has — 27 characters from `A-Za-z0-9-_`, safe to carry in the
 * `?token=` query string a doc-site link is handed around as. Matching that
 * shape is not cosmetic: a value this SDK generates is indistinguishable from
 * one the platform generated, so nothing downstream — a link, a bookmark, a
 * support screenshot — can tell which command produced the gate it is opening.
 *
 * 160 bits, and the token is a bearer credential with no rate limit in front of
 * it, so the margin over a guessable value is the whole point.
 */
const DOCUMENTATION_TOKEN_BYTES = 20;

/**
 * Mint one documentation token.
 *
 * `node:crypto`, never `Math.random()`: this value is the only thing standing
 * between a Private doc site and anyone who has its URL, and a predictable one
 * reads as a gate while being none.
 */
export function generateDocumentationToken(): string {
  return randomBytes(DOCUMENTATION_TOKEN_BYTES).toString("base64url");
}

/**
 * The sidecar's path for a command running in `cwd` — `xano/.secrets.json` in a
 * scaffolded project, and beside the backend wherever else it lives.
 *
 * Resolved through the same two helpers `xano/.env` uses, which is the whole
 * point: the two files have to land in the same directory or one of them is
 * ignored while the other is not.
 */
export function workspaceSecretsPathIn(cwd: string): string {
  return join(backendDirIn(projectRootFrom(cwd)), ".secrets.json");
}

/** The same file for a build, resolved from the entry it is compiling. */
export function defaultWorkspaceSecretsPath(file: string): string {
  return join(backendDirFor(file), ".secrets.json");
}

/**
 * Render the file. The ONE function in this module that may receive a value.
 *
 * Pretty-printed because a human will occasionally open it to confirm what a
 * pull picked up, and because a one-line JSON blob makes an accidental paste
 * into a terminal far worse than it needs to be.
 */
export function renderSecretsFile(file: SecretsFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}

/** Write it atomically. The staging file is gitignored — see `gitignore.ts`. */
export function writeSecretsFile(path: string, file: SecretsFile): void {
  atomicWrite(path, renderSecretsFile(file), { mode: 0o600 });
}

/**
 * ` <entry>` for a command that fills `path`, when the backend beside it is not
 * the one this directory's bare command finds (a nested `suites/alpha/xano/`
 * from the repo root) — empty when the bare command already reaches it, or no
 * entry sits beside it.
 */
function entryWordFor(path: string): string {
  const entry = join(dirname(resolve(path)), "index.ts");
  return existsSync(entry) ? entryWordOf(entry) : "";
}

/**
 * ` <entry>` for a printed command acting on `entry` — empty when a bare command
 * run from the working directory resolves that same entry, so a remedy for the
 * project's own backend stays short and one for a nested backend names it (a
 * bare `xanosdk deploy` there compiles `./xano/index.ts` instead).
 */
export function entryWordOf(entry: string): string {
  // Through real paths: a symlinked home or temp directory otherwise reads as
  // another place than the working directory it is.
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const cwd = real(process.cwd());
  const target = real(resolve(entry));
  if (real(join(backendDirIn(cwd), "index.ts")) === target) return "";
  const rel = relForwardSlash(cwd, target);
  return ` ${shellQuote(rel === "" ? target : `./${rel}`)}`;
}

/**
 * Read it, or `undefined` when there is none.
 *
 * A malformed file is a REFUSAL, never an empty read. Reading a broken file as
 * "no tokens" would turn a typo into a deploy that refuses for the wrong reason
 * on the workspace, and into a cleared doc-site gate on a group.
 *
 * `label` turns an ABSENT file into a refusal too, and exists for the same
 * reason `parseEnvFile` takes one: a path the user asked for on the command line
 * must exist, where the default simply may not — that is the ordinary state of a
 * fresh clone. Pass the flag's name, and the message matches the one
 * `--backend-env-file` gives for the same mistake.
 *
 * No error here ever quotes the file's bytes. They are token material, and a
 * parse failure is exactly when a reader is most tempted to print the
 * surrounding context — into a terminal, and from there into a CI log.
 */
export function readSecretsFile(path: string, label?: string): SecretsFile | undefined {
  const where = displayPath(path);
  if (!existsSync(path)) {
    if (label === undefined) return undefined;
    // The flag's path: a mistake in the command line, and — like `--bundle` —
    // a missing local input, exit 1.
    throw new LocalFileNotFoundError(
      `${label}: could not read ${where}. Check the path, and make sure the file is present ` +
        `wherever this runs (a CI secret mounted at deploy time, not a file committed to the ` +
        `repo).`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(
      `${where} is not valid JSON. It is written by \`xanosdk pull\` and is not meant to be ` +
        `hand-edited — delete it and pull again to rebuild it.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${where} must be a JSON object. Delete it and pull again to rebuild it.`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== SECRETS_FILE_VERSION) {
    // Said as what is there: a file with no `version` is not "version
    // undefined". The rebuild deletes it first — `secrets fill` reads this file
    // and would refuse it the same way — then mints or pulls the tokens back.
    const what =
      record.version === undefined
        ? `${where} has no \`version\` field, so it is not a file this SDK wrote`
        : `${where} is version ${JSON.stringify(record.version)}, and this SDK reads version ${SECRETS_FILE_VERSION}`;
    throw new Error(
      `${what}. Delete it, then run \`xanosdk secrets fill${entryWordFor(path)}\` to mint the tokens your source's gates ` +
        `declare, or \`xanosdk pull${contextFlags()}\` to store the target's existing ones.`,
    );
  }
  const tokens = record.documentationTokens;
  if (tokens === undefined || tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) {
    throw new Error(
      `${where} has no \`documentationTokens\` object. Delete it and pull again to rebuild it.`,
    );
  }
  // Null-prototype: a scope keyed `__proto__` is stored, not a prototype set.
  const out = Object.create(null) as Record<string, SecretsTokenEntry>;
  for (const [key, entry] of Object.entries(tokens as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `${where}: the entry for ${JSON.stringify(key)} is not an object. Delete the file and ` +
          `pull again to rebuild it.`,
      );
    }
    const { value, label } = entry as { value?: unknown; label?: unknown };
    if (typeof value !== "string") {
      throw new Error(
        `${where}: the entry for ${JSON.stringify(key)} has no string \`value\`. Delete the file ` +
          `and pull again to rebuild it.`,
      );
    }
    out[normalizeDocumentationScopeKey(key)] = { value, label: typeof label === "string" && label !== "" ? label : key };
  }
  const provenance = record.pulledFrom;
  return {
    version: SECRETS_FILE_VERSION,
    pulledFrom:
      provenance !== null && typeof provenance === "object" && !Array.isArray(provenance)
        ? (provenance as SecretsProvenance)
        : { instance: "(unrecorded)", at: "(unrecorded)" },
    documentationTokens: out,
  };
}
