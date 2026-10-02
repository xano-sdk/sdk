/**
 * The machine's record of which local engine belongs to which project.
 *
 * MACHINE-GLOBAL, keyed by project path. The hosted equivalent
 * (`src/deploy/ephemeral-state.ts`) keys by profile, instance host and
 * workspace id and lives in the project tree; a local engine has none of those
 * three, and a per-project file could not answer `local-engine stop --all`
 * honestly — that command reconciles against an enumeration covering the whole
 * machine, so its state has to cover the whole machine too. One file under the
 * cache root is both the correct scope and the simpler thing.
 *
 * **A record is a hint, never truth.** It holds no token, because the engine's
 * own enumeration re-emits one for every engine it still owns, and it holds no
 * pid, because nothing here ever signals one — a pid is reused after a reboot,
 * and a recorded one answers none of the three ways a local engine goes stale
 * (the process is gone, the port now belongs to something else, the bearer
 * expired while the engine lives). So the file is safe to keep and safe to
 * ignore: reads fall back to empty rather than throwing, exactly as the hosted
 * state does, and a stale row is reconciled away rather than trusted.
 *
 * Node-only, reached by a lazy import from the command layer.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWrite } from "../util/atomic-write.js";
import { localEngineHome } from "./local-engine-config.js";
import { filledAt, withValidFilled, type FilledMarker } from "./keep-data.js";

/** The one file, beside the binary cache under the same relocatable root. */
export const LOCAL_ENGINE_STATE_FILE = "engines.json";

/**
 * What a later command needs to find an engine again — and nothing more.
 *
 * `engineUrl` and `engineDigest` are the engine's IDENTITY, taken straight off
 * the cache entry that was spawned. They are what lets a reuse path and
 * `local-engine list` tell one cached engine from another, and what a version
 * disagreement is reported against, without this module knowing anything about
 * where engines are published.
 */
export interface LocalEngineRecord {
  /** The engine's name — the only handle the enumeration is matched on. */
  name: string;
  /** Where it served when it was recorded. Re-checked against the enumeration. */
  url: string;
  /** The workspace the engine stands up, so a reuse needs no round trip to learn it. */
  workspaceId: number;
  /** The project this engine was started for, absolute and resolved. */
  project: string;
  /** The url the cached executable was fetched from (its cache entry's identity). */
  engineUrl: string;
  /**
   * The digest recorded for those bytes when they were fetched — the engine's
   * identity. A deploy reuses a live engine only when this equals the digest of
   * the binary it just acquired; a record missing it (an older shape) reads as
   * a mismatch.
   */
  engineDigest: string;
  /**
   * The engine's version, for display and for stopping it later through that
   * version's own cached binary. A deploy always writes it when it is known: a
   * release engine's resolved version (`v0.1.5`), or an override binary's own
   * `version` output. Absent on records written before it was kept, and when an
   * override could not report one. Never the reuse test — {@link engineDigest}
   * is, because two binaries can report the same version.
   */
  engineVersion?: string;
  /** Epoch ms this record was written. Orders {@link listEngineRecords}. */
  startedAt: number;
  /**
   * Set only once an import into this engine COMPLETED — see
   * {@link markEngineFilled}. Absent means the engine may be empty, which is
   * what a record written before the import and never followed by one is.
   */
  filled?: FilledMarker;
}

/** The on-disk file: one record per project path. */
export interface LocalEngineState {
  version: 1;
  engines: Record<string, LocalEngineRecord>;
}

/** `<cache root>/engines.json`. */
export function localEngineStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(localEngineHome(env), LOCAL_ENGINE_STATE_FILE);
}

/** The key a project's record lives under: its absolute, resolved path. */
export function projectKey(dir: string): string {
  return resolve(dir);
}

/**
 * The engine name a project uses, derived from its path.
 *
 * Derived rather than stored so a project whose record was lost still asks for
 * the same name, which is what makes a repeat deploy find the engine it started
 * before even when the file is gone. A digest of the path rather than any part
 * of it: the name is printed, appears in the engine's own enumeration, and
 * names a log file, and none of those should spell a developer's directory
 * layout.
 */
export function engineNameForProject(dir: string): string {
  return `xanosdk-${createHash("sha256").update(projectKey(dir)).digest("hex").slice(0, 12)}`;
}

function isRecord(value: unknown): value is LocalEngineRecord {
  if (value === null || typeof value !== "object") return false;
  const raw = value as Partial<LocalEngineRecord>;
  return (
    typeof raw.name === "string" &&
    typeof raw.url === "string" &&
    typeof raw.workspaceId === "number" &&
    typeof raw.project === "string"
  );
}

/**
 * Read the file. A missing, unparseable or invalid one reads as empty, and a
 * row that is not a record is dropped rather than handed out — a bad state file
 * must never block a deploy, and is rewritten on the next write.
 */
export function readLocalEngineState(env: NodeJS.ProcessEnv = process.env): LocalEngineState {
  let text: string;
  try {
    text = readFileSync(localEngineStatePath(env), "utf8");
  } catch {
    return { version: 1, engines: {} };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      const rows = (parsed as LocalEngineState).engines;
      if (rows !== null && typeof rows === "object") {
        const engines: Record<string, LocalEngineRecord> = {};
        for (const [key, value] of Object.entries(rows)) {
          // A malformed marker is dropped rather than trusted: "never filled"
          // is the reading that cannot merge into something unproven.
          if (isRecord(value)) engines[key] = withValidFilled(value);
        }
        return { version: 1, engines };
      }
    }
  } catch {
    /* fall through to empty */
  }
  return { version: 1, engines: {} };
}

/** The record for one project, or `undefined`. */
export function getEngineRecord(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): LocalEngineRecord | undefined {
  return readLocalEngineState(env).engines[projectKey(dir)];
}

/** Every record on this machine, most recently started first. */
export function listEngineRecords(env: NodeJS.ProcessEnv = process.env): LocalEngineRecord[] {
  return Object.values(readLocalEngineState(env).engines).sort(
    (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0),
  );
}

/**
 * Write a project's record.
 *
 * Called the moment the engine reports itself started and BEFORE the first
 * import byte leaves: a crash in between then leaves a stale row that
 * reconciliation already handles, rather than an engine nothing on this machine
 * knows about.
 */
export function setEngineRecord(
  dir: string,
  record: LocalEngineRecord,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const state = readLocalEngineState(env);
  state.engines[projectKey(dir)] = { ...record, project: projectKey(dir) };
  writeState(state, env);
}

/**
 * Record that an import into this project's engine completed at `url`.
 *
 * The post-import write, separate from {@link setEngineRecord} because that one
 * runs BEFORE the import: a marker written there would vouch for rows that may
 * never have landed. No record, nothing to mark — the pre-import write always
 * precedes this one.
 */
export function markEngineFilled(dir: string, url: string, env: NodeJS.ProcessEnv = process.env): void {
  const state = readLocalEngineState(env);
  const record = state.engines[projectKey(dir)];
  if (record === undefined) return;
  state.engines[projectKey(dir)] = { ...record, filled: filledAt(url) };
  writeState(state, env);
}

/** Drop a project's record. Returns whether there was one. */
export function clearEngineRecord(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const state = readLocalEngineState(env);
  const key = projectKey(dir);
  if (!(key in state.engines)) return false;
  delete state.engines[key];
  writeState(state, env);
  return true;
}

/**
 * Drop every project's record for one engine name, returning the projects that
 * held one.
 *
 * Name-keyed rather than project-keyed because stopping is name-keyed: one
 * engine stopped has to leave no row anywhere claiming it is still serving,
 * whichever project's deploy happens to be running.
 */
export function clearEngineRecordsNamed(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const state = readLocalEngineState(env);
  const cleared = Object.entries(state.engines)
    .filter(([, record]) => record.name === name)
    .map(([key]) => key);
  if (cleared.length === 0) return [];
  for (const key of cleared) delete state.engines[key];
  writeState(state, env);
  return cleared;
}

/**
 * Restricted mode on the file as well as the directory. It carries no secrets
 * by construction — but it names every project on this machine that has stood
 * up a backend, which is nobody else's business either.
 */
function writeState(state: LocalEngineState, env: NodeJS.ProcessEnv): void {
  const path = localEngineStatePath(env);
  mkdirSync(localEngineHome(env), { recursive: true, mode: 0o700 });
  atomicWrite(path, JSON.stringify({ version: 1, engines: state.engines }, null, 2) + "\n", {
    mode: 0o600,
  });
}
