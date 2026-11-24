/**
 * Which build of each site this project's frontend last came from: the record
 * a site pull leaves at `./.xano/sites.json`, so a later `pull` can tell a live
 * build the frontend already holds from one it does not (DEV-10113).
 *
 *     { "version": 1, "sites": { "shop": { "buildId": 136, "env": "dev", "pulledAt": "…" } } }
 *
 * Beside `deployed.json` and `ephemeral.json`, and like them a hint, never
 * truth: a missing, unparseable or unrecognised file reads as empty, and a
 * site without an entry reads as "not pulled here". It carries no secrets.
 * `.xano/` is this checkout's own state, so the record is too: a fresh clone
 * has none, and there a build's commit (when its description names one) is
 * what `pull` checks against the project's git history instead.
 *
 * The write mirrors `deployed-state.ts`: temp-file + rename via `atomicWrite`,
 * recursive mkdir, and a `.xano/` gitignore entry.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWrite } from "../util/atomic-write.js";
import { ensureGitignored } from "../auth/store.js";

/** What a site pull recorded for one site. */
export interface SitePullRecord {
  /** The build whose code was written into the site's app folder. */
  buildId: number;
  /** The environment that served it when it was pulled; `null` for a site's newest build that was served nowhere. */
  env: "dev" | "prod" | null;
  /** ISO-8601, when it was pulled. For people and bug reports. */
  pulledAt: string;
}

/** `./.xano/sites.json` resolved against a project directory. */
export function siteRecordPath(dir: string): string {
  return join(resolve(dir), ".xano", "sites.json");
}

/** Every site's record. Never throws: anything unreadable reads as no record. */
export function readSiteRecords(dir: string): Record<string, SitePullRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(siteRecordPath(dir), "utf8"));
  } catch {
    return {};
  }
  const sites = (parsed as { sites?: unknown } | null)?.sites;
  if (sites === null || typeof sites !== "object" || Array.isArray(sites)) return {};
  const out: Record<string, SitePullRecord> = {};
  for (const [site, raw] of Object.entries(sites as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object") continue;
    const { buildId, env, pulledAt } = raw as Record<string, unknown>;
    if (typeof buildId !== "number" || !Number.isInteger(buildId)) continue;
    out[site] = {
      buildId,
      env: env === "dev" || env === "prod" ? env : null,
      pulledAt: typeof pulledAt === "string" ? pulledAt : "",
    };
  }
  return out;
}

/**
 * Record the builds a site pull just wrote, merged over what was recorded
 * before (a pull of one site keeps the others' entries). Returns the path.
 */
export function recordSitePulls(
  dir: string,
  pulled: ReadonlyArray<{ site: string; buildId: number; env: "dev" | "prod" | null }>,
  now: Date = new Date(),
): string {
  const path = siteRecordPath(dir);
  const sites = readSiteRecords(dir);
  for (const p of pulled) sites[p.site] = { buildId: p.buildId, env: p.env, pulledAt: now.toISOString() };
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, JSON.stringify({ version: 1, sites }, null, 2) + "\n");
  ensureGitignored(path);
  return path;
}
