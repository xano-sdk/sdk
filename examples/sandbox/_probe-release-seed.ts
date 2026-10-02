/**
 * Probe harness for ROW SELECTION on a release (NOT a shipped example, NOT
 * auto-indexed).
 *
 * `release create --seed` sends `table_ids`, and three things about that path
 * were unknown. Token acceptance across hosts was NOT one of them — that is
 * already measured in
 * `docs/solutions/best-practices/what-the-oauth-workspace-binding-actually-refuses.md`
 * (an OAuth token on a tenant's own host at workspaceId 1 answers 200), so it
 * is deliberately not re-probed here.
 *
 *   Q1  Does table-browse succeed against the BOUND workspace with the scopes
 *       the CLI actually requests? The CLI holds
 *       `offline_access workspace:read workspace:write xano:dev` — no
 *       `workspace:database` — and the table routes reference that scope on
 *       their write verbs. If the read is gated too, `xanosdk tables workspace` and
 *       every `--seed` path fail, not just the tenant one.
 *   Q2  Does table-browse succeed against an EPHEMERAL's own host at
 *       workspaceId 1, where `/auth/me` reports `membership.workspace` as []?
 *       This is a role/RBAC question, not an OAuth scope one, so no consent
 *       change could fix a refusal.
 *   Q3  Is a tenant-sourced cut with NON-EMPTY table_ids accepted at all?
 *       Asking for a tenant's ROWS is a different request from asking for its
 *       schema, and there was reason to think a destination whose own workspace
 *       id matches the tenant's could be refused: a tenant's workspace is always
 *       id 1, and so is the first workspace on an instance. So the DESTINATION
 *       workspace id is recorded alongside the answer, and a single pass does
 *       not generalize without it.
 *
 * Rows landing is proven from the created release's per-table row-count list
 * (`seededTables`), NOT from the audit log: the audit entry's `records` value
 * tracks the REQUEST rather than the result, so it reports what was asked for
 * even when nothing was carried.
 *
 * Run:
 *   npx tsx examples/sandbox/_probe-release-seed.ts
 *
 * Reads only, unless PROBE_WRITE=1 is set (Q3 creates and then deletes a real
 * release in the bound workspace).
 *
 * MEASURED OUTPUT lives at the bottom of this file. Update it if you re-run.
 */
import { getAccessToken } from "../../src/auth/token.js";
import { listTables } from "../../src/deploy/table.js";
import { listAllEphemeral, isExpired } from "../../src/deploy/ephemeral.js";
import { createRelease, findRelease, deleteRelease } from "../../src/deploy/release.js";

/** Report a measurement without ever printing a token or a row value. */
function say(q: string, verdict: string, detail = ""): void {
  console.log(`${q.padEnd(4)} ${verdict}${detail === "" ? "" : `  — ${detail}`}`);
}

async function main(): Promise<void> {
  const auth = await getAccessToken({} as never);
  console.log(`bound workspace id: ${auth.workspaceId}   credential: ${auth.credentialType}`);
  console.log(`instance: ${auth.instance.replace(/https:\/\/([^.]+)/, "https://<instance>")}\n`);

  // ── Q1: table-browse on the bound workspace ───────────────────────────────
  try {
    const tables = await listTables(auth, { workspaceId: auth.workspaceId });
    say("Q1", "200", `${tables.length} table(s); ids are readable with the CLI's own scopes`);
  } catch (err) {
    say("Q1", "REFUSED", (err as Error).message.split("\n")[0] ?? "");
  }

  // ── Q2: table-browse on an ephemeral's own host at workspaceId 1 ──────────
  let host: string | undefined;
  try {
    const envs = await listAllEphemeral(auth);
    const throwaway = envs.find((e) => !isExpired(e.expiresAt));
    host = throwaway?.url;
    if (throwaway !== undefined) console.log(`  (addressing ephemeral ${throwaway.name})`);
    if (host === undefined) {
      say("Q2", "SKIPPED", "no ephemeral or sandbox tenant exists to address");
    } else {
      const tables = await listTables(auth, { workspaceId: 1, base: host });
      say("Q2", "200", `${tables.length} table(s) on the tenant host at workspaceId 1`);
    }
  } catch (err) {
    say("Q2", "REFUSED", (err as Error).message.split("\n")[0] ?? "");
  }

  // ── Q3: a tenant-sourced cut with NON-EMPTY table_ids ─────────────────────
  if (process.env.PROBE_WRITE !== "1" || host === undefined) {
    say("Q3", "NOT RUN", "set PROBE_WRITE=1 with a live ephemeral");
    return;
  }
  const envName = host.split("/").pop() ?? "";
  const name = `probe-seed-${Date.now()}`;
  let created = false;
  try {
    // The ids MUST come from the tenant's own listing: a tenant's workspace is
    // always id 1, and so is the bound workspace here, so ids read from the
    // wrong host would be silently ignored rather than rejected.
    const tenantTables = await listTables(auth, { workspaceId: 1, base: host });
    const ids = tenantTables.filter((t) => t.name.startsWith("probe_")).map((t) => t.id);
    console.log(`  tenant table ids: ${ids.join(", ")}  (names: ${tenantTables.map((t) => t.name).join(", ")})`);

    const cut = await createRelease(auth, {
      workspaceId: auth.workspaceId,
      name,
      branch: "",
      sourceTenant: envName,
      tableIds: ids,
    });
    created = true;
    const landed = (await findRelease(auth, { workspaceId: auth.workspaceId, name })) ?? cut;
    const manifest = landed.seededTables.map((t) => `${t.name}=${t.count ?? "?"}`).join(", ");
    say(
      "Q3",
      "ACCEPTED",
      `dest workspace ${auth.workspaceId}; rows landed: ${manifest === "" ? "(none)" : manifest}`,
    );

    // A CONTROL: the same cut with NO table_ids, to prove the manifest is
    // driven by the selection rather than being populated either way.
    const ctlName = `${name}-control`;
    const ctl = await createRelease(auth, {
      workspaceId: auth.workspaceId,
      name: ctlName,
      branch: "",
      sourceTenant: envName,
    });
    const ctlLanded = (await findRelease(auth, { workspaceId: auth.workspaceId, name: ctlName })) ?? ctl;
    say("CTL", "ACCEPTED", `no table_ids -> seededTables: ${JSON.stringify(ctlLanded.seededTables)}`);
    if (ctlLanded.id !== undefined) await deleteRelease(auth, { workspaceId: auth.workspaceId, id: ctlLanded.id });

    if (landed.id !== undefined) await deleteRelease(auth, { workspaceId: auth.workspaceId, id: landed.id });
    console.log("  (both probe releases deleted)");
  } catch (err) {
    say("Q3", created ? "FAILED AFTER CREATE" : "REFUSED", (err as Error).message.split("\n")[0] ?? "");
    const stray = await findRelease(auth, { workspaceId: auth.workspaceId, name }).catch(() => null);
    if (stray?.id !== undefined) {
      await deleteRelease(auth, { workspaceId: auth.workspaceId, id: stray.id });
      console.log("  (cleaned up the release the refusal left behind)");
    }
  }
}

await main();

/*
 * ── MEASURED OUTPUT ────────────────────────────────────────────────────────
 * Run 2026-09-11 against a dev instance. Bound workspace id 1, OAuth
 * credential, scopes `offline_access workspace:read workspace:write xano:dev`
 * (no `workspace:database`). Source: a freshly deployed ephemeral.
 *
 *   Q1   200  — 5 table(s); ids are readable with the CLI's own scopes
 *   Q2   200  — 3 table(s) on the tenant host at workspaceId 1
 *   Q3   ACCEPTED — dest workspace 1; rows landed:
 *                   probe_widgets=3, probe_crates=1, probe_empties=0
 *   CTL  ACCEPTED — no table_ids -> seededTables: []
 *
 * What that settles:
 *
 *   - Table-browse needs no scope the CLI lacks, on the bound workspace (Q1)
 *     OR on a tenant host where `membership.workspace` is [] (Q2). The
 *     role-permission worry does not bite either path.
 *   - A tenant-sourced cut with non-empty table_ids is NOT refused, even with
 *     the destination workspace at id 1 — the same id the tenant's own
 *     workspace carries, which was the case expected to be rejected.
 *   - The per-table row-count list is driven by the SELECTION: empty without
 *     table_ids (CTL), populated with it (Q3).
 *   - A requested table with no rows is listed with count 0 rather than
 *     omitted (probe_empties). So the manifest enumerates what RESOLVED, and
 *     comparing it against the requested ids is a sound post-cut check.
 *   - The bound workspace held 5 tables and the ephemeral's workspace 1 held 3,
 *     under overlapping ids. Ids are per-host and must be re-listed when the
 *     source changes; that is not theoretical.
 */
