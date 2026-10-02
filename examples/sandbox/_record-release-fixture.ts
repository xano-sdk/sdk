/**
 * Recorder for the live release fixture (NOT a shipped example, NOT
 * auto-indexed).
 *
 * `projectRelease` is deliberately an allow-list against a record shape the SDK
 * does not control, so it keeps needing to match a moving target. Three of its
 * fields shipped structurally dead — `hasResource`, then `workspaceId`
 * and `branch` — because the tests built the raw record BY HAND and so
 * agreed with the projection instead of checking it. This script is the answer
 * to that: it records what the routes really send, and
 * `test/fixtures/release/live-records.json` is its output.
 *
 * Two cuts, because the fields that went dead were the EMPTY ones:
 *   - a default workspace cut (`branch: ""`, no description, no rows), which is
 *     what `xanosdk release create <name>` sends; and
 *   - a cut naming a branch, carrying a description and one table's rows, for
 *     the populated spelling of every field.
 *
 * Both are read back through all three routes — list, by-id, create response —
 * because they do NOT agree with each other: the create route answers
 * `2026-09-15T04:01:28.000000Z` where the read routes answer
 * `2026-09-15 04:01:28+0000`.
 *
 * WRITES: cuts two releases in the bound workspace and deletes both before it
 * returns. Nothing is printed but the records themselves — no token, no row
 * value.
 *
 * Run (redirect into the fixture, then re-run the tests):
 *   npx tsx examples/sandbox/_record-release-fixture.ts
 */
import { getAccessToken } from "../../src/auth/token.js";

/** The table whose ROWS the branch cut carries. Any table id in the workspace. */
const SEED_TABLE_ID = 73;
/** A branch label the workspace HAS. Every workspace has `v1`. */
const BRANCH_LABEL = "v1";

const auth = await getAccessToken({} as never);
const base = `${auth.instance}/api:meta/workspace/${auth.workspaceId}/release`;
const headers = { Authorization: `Bearer ${auth.access_token}`, "Content-Type": "application/json" };

/** Cut one release, read it back through all three routes, then delete it. */
async function record(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const created = (await (
    await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    })
  ).json()) as Record<string, unknown>;
  const id = created.id as number;

  const byId = await (
    await fetch(`${base}/${id}`, { headers, signal: AbortSignal.timeout(30_000) })
  ).json();
  const page = (await (
    await fetch(`${base}?page=1&per_page=100`, { headers, signal: AbortSignal.timeout(30_000) })
  ).json()) as { items: Record<string, unknown>[] };

  const del = await fetch(`${base}/${id}`, {
    method: "DELETE",
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  console.error(`cleanup: deleted release ${id} (${del.status})`);

  return { create: created, byId, list: page.items.find((r) => r.id === id) };
}

const defaultCut = await record({ name: "probe383-record", branch: "" });
const branchCut = await record({
  name: "probe383-record-branch",
  branch: BRANCH_LABEL,
  description: "cut by probe 383",
  hotfix: false,
  table_ids: [SEED_TABLE_ID],
});

console.log(JSON.stringify({ defaultCut, branchCut }, null, 2));
