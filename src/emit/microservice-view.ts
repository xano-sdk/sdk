/**
 * Shared rendering for a workspace's microservices, used by `deploy` (as a
 * post-import readiness report) and by the three read commands — `ephemeral
 * get` and `workspace details`.
 *
 * One place so the same microservice reads identically wherever it shows up:
 * the disposition wording is the user's mental model of this surface, and it
 * would be worth little if `deploy` and `ephemeral get` described the same row
 * two different ways.
 */
import { listMicroservices, type MicroserviceSummary } from "../deploy/microservice-status.js";
import type { ResolvedAuth } from "../auth/token.js";
import { detail, info, warn } from "./ui.js";

/**
 * Read a workspace's microservices for a command whose PRIMARY job is something
 * else. Degrades to `null` — unknown, never `[]`, which a `--json` reader takes
 * for "none" — with a warning rather than throwing: `ephemeral get` exists to
 * report the env, and losing that answer because a secondary read failed would
 * be a worse outcome than an incomplete one.
 */
export async function readMicroservices(
  auth: ResolvedAuth,
  baseUrl: string,
  workspaceId = 1,
): Promise<MicroserviceSummary[] | null> {
  try {
    return await listMicroservices(auth, { baseUrl, workspaceId });
  } catch (err) {
    warn(`Could not read microservices: ${err instanceof Error ? err.message : String(err)}`, "microservice.status-unreadable");
    return null;
  }
}

/** Icon and default wording per disposition. The engine's own detail wins when it set one. */
const DISPOSITION_LABEL: Record<MicroserviceSummary["disposition"], { icon: string; why: string }> = {
  ready: { icon: "✓", why: "ready" },
  inFlight: { icon: "…", why: "starting" },
  failed: { icon: "✗", why: "failed" },
  manual: { icon: "–", why: "not started — set to deploy manually" },
  disabled: { icon: "–", why: "disabled" },
  unknown: { icon: "–", why: "unrecognized state" },
};

/** One rendered line per microservice: an icon, its name, and why it's in that state. */
export function microserviceLine(m: MicroserviceSummary): string {
  const { icon, why } = DISPOSITION_LABEL[m.disposition];
  // A `manual`/`disabled` row's stored detail describes a workload that was
  // never started, so it would only mislead — use our own wording for those.
  const useDetail = m.disposition !== "manual" && m.disposition !== "disabled";
  const reason = (useDetail ? m.statusDetail : undefined) ?? why;
  // An unmodelled status is worth spelling out verbatim so it can be reported.
  return `${icon} ${m.name} — ${m.disposition === "unknown" ? `${why} (${m.status})` : reason}`;
}

/** How many microservices are ready, out of the ones the engine was going to start. */
export function readyRatio(microservices: MicroserviceSummary[]): { ready: number; startable: number } {
  return {
    ready: microservices.filter((m) => m.disposition === "ready").length,
    // Rows the engine was never going to start don't belong in a readiness ratio.
    startable: microservices.filter((m) => m.disposition !== "manual" && m.disposition !== "disabled").length,
  };
}

/**
 * Print a microservice section for the read commands. Silent when there are
 * none, so a workspace without microservices sees no change in its output —
 * and when they could not be read (`null`), which the read already warned.
 */
export function printMicroserviceSection(microservices: MicroserviceSummary[] | null): void {
  if (microservices === null || microservices.length === 0) return;
  const { ready, startable } = readyRatio(microservices);
  info(startable === 0 ? "Microservices (none set to start):" : `Microservices (${ready}/${startable} ready):`);
  for (const m of microservices) detail(microserviceLine(m));
}
