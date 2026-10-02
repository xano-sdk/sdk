/**
 * Probe harness for `deploy --keep-data` (NOT a shipped example, NOT
 * auto-indexed).
 *
 * `--keep-data` merges into an environment a previous deploy filled, through
 * the SDK import route, instead of full-replacing it. Four things about that
 * were unmeasured, on both destinations the flag serves (an ephemeral and a
 * local engine):
 *
 *   Q1  Does the SDK import route answer there at all? A bodyless `dry_run`
 *       POST: 404 means absent, 400/422/2xx means present.
 *   Q2  Does a merge (prune on, no records) keep the rows a table already holds
 *       when that table's schema gains a field — and write no seed rows?
 *   Q3  Does the dry run list a table removed from the project as a delete, and
 *       does the apply drop it? Does it list a new seeded table as a create?
 *   Q4  Does the merge keep an env var's LIVE value when the project's differs,
 *       as release documents? Does the configuration-only export work with the
 *       destination's own bearer?
 *   Q5  (ephemeral only) Does a merge leave a published static host serving?
 *   Q6  Is a schema change that conflicts with populated rows (a retype) refused
 *       whole, and do the rows survive?
 *
 * Rows are counted by reading them back through the deployed API, never from a
 * response flag — see `docs/solutions/best-practices/what-table-ids-selects-on-a-release.md`.
 *
 * Run (`local` resolves the latest published engine; the env file carries ephemeral credentials):
 *   npx tsx --env-file=.env examples/sandbox/_probe-keep-data.ts [ephemeral|local|both]
 *
 * Creates and deletes one throwaway ephemeral, and starts and stops one local
 * engine under a scratch project directory.
 *
 * MEASURED OUTPUT lives at the bottom of this file. Update it if you re-run.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The authoring API comes from source, like the deploy internals below: mixing
// the published types with source ones gives two unrelated `TableDef`s.
import { workspace, workspaceConfig, apiGroup, table, f, query, s, inp, input, ref } from "../../src/index.js";
import type { TableDef } from "../../src/index.js";
import { getAccessToken, type ResolvedAuth } from "../../src/auth/token.js";
import { encodeWorkspaceArchive } from "../../src/validate/archive.js";
import { buildSeedContentFiles } from "../../src/workspace/seed.js";
import { xanosdkImport, XanoSdkImportRefusal } from "../../src/deploy/xanosdk-import.js";
import { exportWorkspaceBundle } from "../../src/deploy/workspace-export.js";
import { envValuesOf } from "../../src/deploy/live-diff.js";
import { createEphemeral, deleteEphemeral, waitUntilReady } from "../../src/deploy/ephemeral.js";

type Variant = "v1" | "v2" | "v3";

/**
 * v1: notes(title) seeded 2, gone(label) seeded 1, env PROBE_KEY=one.
 * v2: notes gains `body`, gone is removed, fresh(code) is added seeded 2,
 *     env PROBE_KEY=two.
 * v3: v2 with notes.title RETYPED text → int, which the stored text rows violate.
 */
function build(variant: Variant) {
  const api = apiGroup({ name: "keepprobe", canonical: "keepprobe" });
  const notes = table({
    name: "notes",
    schema: {
      title: variant === "v3" ? f.int() : f.text(),
      ...(variant === "v1" ? {} : { body: f.text() }),
    },
    seed: variant === "v3" ? [{ title: 1 }, { title: 2 }] : [{ title: "seed-a" }, { title: "seed-b" }],
  });
  const gone = table({ name: "gone", schema: { label: f.text() }, seed: [{ label: "doomed" }] });
  const fresh = table({ name: "fresh", schema: { code: f.text() }, seed: [{ code: "x" }, { code: "y" }] });
  const tables: TableDef[] = variant === "v1" ? [notes, gone] : [notes, fresh];

  const list = query({
    name: "notes",
    verb: "GET",
    apiGroup: api,
    stack: [s.db.query({ table: notes, as: "rows" })],
    response: ref("rows"),
  });
  const add = query({
    name: "notes",
    verb: "POST",
    apiGroup: api,
    input: { title: variant === "v3" ? input.int() : input.text() },
    stack: [s.db.add({ table: notes, row: { title: inp("title") }, as: "created" })],
    response: ref("created"),
  });
  const ws = workspace("keep-probe")
    .registerWorkspace(workspaceConfig({ name: "keep-probe", env: { PROBE_KEY: variant === "v1" ? "one" : "two" } }))
    .registerTables(tables)
    .registerApiGroups([api])
    .registerQueries([list, add]);
  return { ws, tables };
}

async function archiveFor(variant: Variant, withSeed: boolean): Promise<Uint8Array> {
  const { ws, tables } = build(variant);
  const bundle = JSON.stringify(ws.export());
  const content = withSeed ? await buildSeedContentFiles(tables) : [];
  return encodeWorkspaceArchive(bundle, content);
}

interface Target {
  label: string;
  base: string;
  workspaceId: number;
  auth: ResolvedAuth;
}

function say(q: string, verdict: string, detail = ""): void {
  console.log(`${q.padEnd(5)} ${verdict}${detail === "" ? "" : `  — ${detail}`}`);
}

async function probeRoute(t: Target): Promise<number> {
  const res = await fetch(`${t.base.replace(/\/$/, "")}/api:meta/workspace/${t.workspaceId}/xanosdk/import?dry_run=true`, {
    method: "POST",
    headers: { accept: "application/json", Authorization: `Bearer ${t.auth.access_token}` },
  });
  await res.text();
  return res.status;
}

async function rows(t: Target): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${t.base.replace(/\/$/, "")}/api:keepprobe/notes`);
  const text = await res.text();
  if (!res.ok) throw new Error(`list notes ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as Array<Record<string, unknown>>;
}

async function addRow(t: Target, title: string): Promise<void> {
  const res = await fetch(`${t.base.replace(/\/$/, "")}/api:keepprobe/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`add note ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function merge(t: Target, variant: Variant, dryRun: boolean) {
  return xanosdkImport(t.auth, {
    baseUrl: t.base,
    workspaceId: t.workspaceId,
    archive: await archiveFor(variant, false),
    dryRun,
    mode: "merge",
    prune: true,
  });
}

async function tableNames(t: Target): Promise<string[]> {
  const bundle = await exportWorkspaceBundle(t.auth, { base: t.base, workspaceId: t.workspaceId, label: "probe export" });
  const dbo = (bundle.payload as { dbo?: Array<{ name?: string }> }).dbo ?? [];
  return dbo.map((d) => d.name ?? "?").sort();
}

async function run(t: Target, opts: { staticCheck?: () => Promise<string> }): Promise<void> {
  console.log(`\n── ${t.label} ──`);

  // Q1
  const status = await probeRoute(t);
  say("Q1", status === 404 ? "ABSENT" : "PRESENT", `bodyless dry_run POST answered ${status}`);
  if (status === 404) return;

  // Baseline: a plain full replace with seeds, as deploy does today.
  await xanosdkImport(t.auth, {
    mode: "replace",
    dryRun: false,
    baseUrl: t.base,
    workspaceId: t.workspaceId,
    archive: await archiveFor("v1", true),
    preserveGuids: true,
  });
  for (const title of ["user-1", "user-2", "user-3"]) await addRow(t, title);
  const before = await rows(t);
  console.log(
    `      baseline: ${before.length} notes (2 seed + 3 added), tables ${(await tableNames(t)).join(",")}`,
  );

  let staticBefore: string | undefined;
  if (opts.staticCheck) staticBefore = await opts.staticCheck();

  // Q2/Q3 dry run
  const plan = await merge(t, "v2", true);
  const ops = plan.plan.operations.map((o) => `${o.action}:${o.type}:${o.name}`);
  say("Q3a", "DRY RUN", `hasRecords=${plan.plan.hasRecords} ops=[${ops.join(", ")}]`);
  const counts = await rows(t);
  say("Q3b", counts.length === before.length ? "dry run wrote nothing" : "DRY RUN CHANGED ROWS", `${counts.length} notes`);

  // Q2/Q3 apply
  await merge(t, "v2", false);
  const after = await rows(t);
  const hasBody = after.every((r) => "body" in r);
  say(
    "Q2",
    after.length === before.length && hasBody ? "ROWS KEPT" : "ROWS CHANGED",
    `${before.length} → ${after.length} notes; new field present on every row: ${hasBody}`,
  );
  const names = await tableNames(t);
  say("Q3c", names.includes("gone") ? "NOT DROPPED" : "DROPPED", `tables after merge: ${names.join(",")}`);

  // Q4
  const live = envValuesOf(await exportWorkspaceBundle(t.auth, { base: t.base, workspaceId: t.workspaceId, label: "probe export" }));
  say("Q4", live.get("PROBE_KEY") === "one" ? "LIVE VALUE KEPT" : `LIVE VALUE IS ${JSON.stringify(live.get("PROBE_KEY"))}`, "project says \"two\"");

  // Q5
  if (opts.staticCheck) {
    const staticAfter = await opts.staticCheck();
    say("Q5", `static before=${staticBefore} after=${staticAfter}`);
  }

  // Q6
  try {
    await merge(t, "v3", true);
    say("Q6a", "DRY RUN ACCEPTED the retype");
  } catch (err) {
    say("Q6a", err instanceof XanoSdkImportRefusal ? `REFUSED (${err.code})` : "FAILED", (err as Error).message.split("\n")[0] ?? "");
  }
  try {
    await merge(t, "v3", false);
    say("Q6b", "APPLY ACCEPTED the retype");
  } catch (err) {
    say("Q6b", err instanceof XanoSdkImportRefusal ? `REFUSED (${err.code})` : "FAILED", (err as Error).message.split("\n")[0] ?? "");
  }
  try {
    const survived = await rows(t);
    say("Q6c", `${survived.length} notes after the retype attempt`, JSON.stringify(survived.map((r) => r.title)));
  } catch (err) {
    say("Q6c", "READ FAILED", (err as Error).message);
  }
}

async function ephemeral(): Promise<void> {
  const auth = await getAccessToken({} as never);
  const parentWorkspaceId = auth.workspaceId;
  const fresh = await createEphemeral(auth, { parentWorkspaceId, display: "keep-data-probe", expiresHours: 1 });
  try {
    const env = await waitUntilReady(auth, { parentWorkspaceId, name: fresh.name });
    const base = env.url!;
    const t: Target = { label: `ephemeral ${fresh.name}`, base, workspaceId: 1, auth };

    const siteDir = mkdtempSync(join(tmpdir(), "keep-probe-site-"));
    writeFileSync(join(siteDir, "index.html"), "<!doctype html><html><head></head><body>probe</body></html>");
    let siteUrl: string | undefined;
    const staticCheck = async (): Promise<string> => {
      if (siteUrl === undefined) {
        const { deployStaticHost } = await import("../../src/deploy/static-host.js");
        const sh = await deployStaticHost({ dir: siteDir, workspaceId: 1, baseUrl: base, accessToken: auth.access_token, env: {} });
        siteUrl = sh.url;
        // Give the edge a moment to serve the first build.
        await new Promise((r) => setTimeout(r, 15_000));
      }
      if (siteUrl === undefined) return "no-url";
      const res = await fetch(siteUrl);
      const text = await res.text();
      return `${res.status}${text.includes("probe") ? "(serving)" : ""}`;
    };
    await run(t, { staticCheck });
  } finally {
    await deleteEphemeral(auth, { parentWorkspaceId, name: fresh.name }).catch(() => undefined);
    console.log(`      (ephemeral ${fresh.name} deleted)`);
  }
}

async function local(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "keep-probe-project-"));
  mkdirSync(dir, { recursive: true });
  const { ensureProjectEngine } = await import("../../src/deploy/local-engine-deploy.js");
  const { stopEngineNamed } = await import("../../src/deploy/local-engine-process.js");
  const { clearEngineRecord } = await import("../../src/deploy/local-engine-state.js");
  const { resolveEngineSource } = await import("../../src/deploy/local-engine-config.js");
  const { engine, entry } = await ensureProjectEngine({ dir, source: resolveEngineSource(undefined) });
  try {
    const auth = { access_token: engine.token, instance: engine.url } as unknown as ResolvedAuth;
    await run({ label: `local engine ${engine.name}`, base: engine.url, workspaceId: engine.workspaceId, auth }, {});
  } finally {
    stopEngineNamed(engine.name, { entry });
    clearEngineRecord(dir);
    console.log(`      (engine ${engine.name} stopped)`);
  }
}

const which = process.argv[2] ?? "ephemeral";
if (which === "local" || which === "both") await local().catch((e: unknown) => console.log("LOCAL FAILED:", e));
if (which === "ephemeral" || which === "both") await ephemeral().catch((e: unknown) => console.log("EPHEMERAL FAILED:", e));

/*
 * ── MEASURED OUTPUT ────────────────────────────────────────────────────────
 * Run 2026-09-22 against a dev instance, one throwaway ephemeral.
 *
 *   Q1    PRESENT  — bodyless dry_run POST answered 400
 *         baseline: 5 notes (2 seed + 3 added), tables gone,notes
 *   Q3a   DRY RUN  — hasRecords=false ops=[update:workspace:keep-probe,
 *                    update:query:notes, update:query:notes,
 *                    update:api_group:keepprobe, update:table:notes,
 *                    create:table:fresh, delete:table:gone]
 *   Q3b   dry run wrote nothing  — 5 notes
 *   Q2    ROWS KEPT  — 5 → 5 notes; new field present on every row: true
 *   Q3c   DROPPED  — tables after merge: fresh,notes
 *   Q4    LIVE VALUE KEPT  — project says "two"
 *   Q5    static before=200(serving) after=200(serving)
 *   Q6a   DRY RUN ACCEPTED the retype
 *   Q6b   APPLY ACCEPTED the retype
 *   Q6c   5 notes after the retype attempt  — [null,null,null,null,null]
 *
 * What that settles:
 *
 *   - The route is present, and a merge with prune and no records keeps every
 *     row (seeded AND added) and adds the new field. No seed row is re-written:
 *     the count stayed 5, not 7.
 *   - The dry run names a removed table as `delete:table` and a new one as
 *     `create:table`, and the apply does both. The new seeded table lands EMPTY.
 *   - The merge keeps the live env value, exactly as release documents.
 *   - A merge does NOT tear down static hosting: the site served 200 before and
 *     after. That is the opposite of a replace.
 *   - A retype that the stored values cannot survive is NOT refused. The dry run
 *     and the apply both accept it, the rows survive, and every value in the
 *     retyped column comes back null. So a retype is a silent column wipe, and
 *     the preview has to name it the way it names a dropped column.
 */
