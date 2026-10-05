/**
 * Node-only project state for WHICH KIND of backend this project last deployed
 * to — the one fact every bare command reads first. Stored at
 * `./.xano/deployed.json`, beside the ephemeral record.
 *
 * ## Why a separate file
 *
 * The kind could have been a key in `.xano/ephemeral.json`, but two readers walk
 * that file's `environments` keys as credential scopes, and a Xano Engine has
 * no scope — it would either satisfy one it does not belong to or break the
 * walk. A newest-timestamp rule across the ephemeral record and the engine
 * record was the other option; it is ambiguous when both exist, and the engine
 * record is machine-global, so one project's timestamp would steer another's.
 * One small file that says only "ephemeral" or "local" answers the
 * question directly, and each kind's own store still answers "which one".
 *
 * ## Written by exactly two places
 *
 * The ephemeral deploy arm, immediately after it records the environment, and
 * the local deploy arm, immediately after it records the engine. NOT the
 * shared engine-record writer: `local update` reaches that too, and a
 * restart is not a deploy — it must not steer the next bare command at the
 * engine. A deploy to a workspace or a tenant never writes it either: that is a
 * real deployment, and a bare write that followed one would be a production
 * write nobody named. {@link recordDeployed} consults {@link isRealDeployment}
 * so the rule holds even for a caller that forgets it.
 *
 * Like the records, it is left in place when the import then fails: the
 * environment or engine still exists and is still where the next bare command
 * should go.
 *
 * ## Read without a credential
 *
 * A hint, never truth: a missing, unparseable or unrecognised file reads as
 * absent — and an absent pointer is not an error, it just sends the reader to
 * the fallback. The file carries no secrets. The write mirrors
 * `ephemeral-state.ts`: temp-file + rename via `atomicWrite`, recursive mkdir,
 * and a `.xano/` gitignore entry.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWrite } from "../util/atomic-write.js";
import { ensureGitignored } from "../auth/store.js";
import type { SourceKind } from "../emit/source-selector.js";

/** The two kinds a deploy records: the throwaway ones. */
export type DeployedKind = "ephemeral" | "local";

const DEPLOYED_KINDS: readonly DeployedKind[] = ["ephemeral", "local"];

/** The on-disk pointer. */
export interface DeployedPointer {
  version: 1;
  kind: DeployedKind;
  /** ISO-8601, when the deploy that wrote it recorded its backend. For people and bug reports. */
  deployedAt: string;
}

/**
 * Is `kind` a real deployment — somebody's workspace or tenant — rather than a
 * throwaway backend?
 *
 * THE one predicate: it decides whether a write confirms (or needs `--yes` off
 * a terminal) and whether a deploy is ever recorded as the tracked default.
 * Two copies of "is this real" is how a new throwaway kind ends up prompting on
 * one verb and not another. Exported to handlers from `emit/tracked-backend.ts`;
 * defined here so the pointer writer — reached from a lazily loaded deploy
 * module — can consult it without loading the command registry.
 *
 * `release` and `file` are not places a write lands, so they are not real
 * deployments either; nothing asks about them.
 */
export function isRealDeployment(kind: SourceKind): boolean {
  return kind === "workspace" || kind === "tenant";
}

/** `./.xano/deployed.json` resolved against a project directory. */
export function deployedStatePath(dir: string): string {
  return join(resolve(dir), ".xano", "deployed.json");
}

/**
 * The pointer, or `undefined` when there is none usable. Never throws: a
 * malformed file, an unknown kind, or a kind nothing records (a real
 * deployment) all read as absent — a file this CLI did not write must not
 * steer a bare write anywhere.
 */
export function readDeployed(dir: string): DeployedPointer | undefined {
  let text: string;
  try {
    text = readFileSync(deployedStatePath(dir), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const kind = (parsed as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !DEPLOYED_KINDS.includes(kind as DeployedKind)) return undefined;
  const at = (parsed as { deployedAt?: unknown }).deployedAt;
  return { version: 1, kind: kind as DeployedKind, deployedAt: typeof at === "string" ? at : "" };
}

/**
 * Record that this project just deployed to `kind`. Returns whether anything
 * was written.
 *
 * A real deployment is a no-op, by the rule in the module header — the pointer
 * keeps naming the throwaway backend the project was last iterating on. A kind
 * that is not a deploy destination at all is a caller bug, and throws.
 */
export function recordDeployed(dir: string, kind: SourceKind, now: Date = new Date()): boolean {
  if (isRealDeployment(kind)) return false;
  if (!DEPLOYED_KINDS.includes(kind as DeployedKind)) {
    throw new Error(`Internal: "${kind}" is not a backend a deploy records as the tracked default.`);
  }
  const path = deployedStatePath(dir);
  mkdirSync(dirname(path), { recursive: true });
  const pointer: DeployedPointer = { version: 1, kind: kind as DeployedKind, deployedAt: now.toISOString() };
  atomicWrite(path, JSON.stringify(pointer, null, 2) + "\n");
  ensureGitignored(path);
  return true;
}

/** Remove the pointer. Returns whether there was one. */
export function clearDeployed(dir: string): boolean {
  const path = deployedStatePath(dir);
  try {
    readFileSync(path);
  } catch {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}
