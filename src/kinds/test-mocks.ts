/**
 * Rewrite a stack's per-test mock keys from TEST NAME to TEST ID.
 *
 * Mocks are authored by name (what the editor shows, what XanoScript spells)
 * and stored by id. A statement factory cannot do the rewrite itself — it has
 * no access to the enclosing object's test list — so it happens here, at
 * kind-encode time, once both the tests and the stack are encoded.
 *
 * ## Why the walk is structural rather than a list of containers
 *
 * Mocks can sit on a statement nested inside a conditional branch, a loop body,
 * a group, a try/catch arm, a switch case, a post-process block — and whatever
 * container gets added next. Enumerating those would mean a mock inside a
 * container the list forgot stays keyed by name, and the engine SILENTLY
 * ignores a mock whose key is not a real test id: the deploy succeeds and the
 * mock just never applies.
 *
 * So this walks the encoded tree structurally and rewrites every stack item it
 * finds, wherever it is. A new container costs nothing and cannot be missed.
 */
import type { MockXdo } from "../values/mock.js";
import type { TestXdo } from "./test.js";
import { AUTHOR_KIND_NAME } from "./def-shape.js";
import { statementLabel } from "../statements/statement.js";
import { withArticle } from "../util/article.js";

/**
 * The forms a stored test id takes: 32 lowercase hex characters (what the
 * engine derives today) or a lowercase dashed UUID (what older workspaces hold).
 * The engine matches a mock to its test by exact string, so both resolve.
 */
const STORED_TEST_ID = /^[\da-f]{8}(-?)([\da-f]{4}\1){3}[\da-f]{12}$/;

/** A node that is a stack item carrying mocks: `{name, …, mocks}`. */
function mockBearingItem(node: unknown): { mocks: Record<string, unknown> } | null {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return null;
  const rec = node as Record<string, unknown>;
  // Gate on `name` too: `mocks` alone would also match a stored map that merely
  // happens to hold that key, where a stack item always carries both.
  if (typeof rec.name !== "string") return null;
  const mocks = rec.mocks;
  if (mocks === null || typeof mocks !== "object" || Array.isArray(mocks)) return null;
  if (Object.keys(mocks).length === 0) return null;
  return rec as { mocks: Record<string, unknown> };
}

/**
 * Rewrite every mock key in `run` (and everything nested inside it) from test
 * name to test id, in place on the already-encoded tree.
 *
 * Throws on a name that matches no test: a mock keyed to nothing is dead
 * weight the engine will not report, and a typo in a test name is exactly the
 * mistake this catches.
 */
export function resolveMockKeys(
  run: readonly unknown[],
  tests: readonly TestXdo[],
  ownerKind: string,
  ownerName: string,
): void {
  const byName = new Map(tests.map((t) => [t.name, t.id]));

  const rewrite = (item: { mocks: Record<string, unknown> }): void => {
    const resolved: Record<string, MockXdo> = {};
    for (const [testName, entry] of Object.entries(item.mocks)) {
      const id = byName.get(testName);
      if (id === undefined) {
        // A key that is ALREADY a stored id passes through untouched. That is
        // the escape hatch a pulled tree needs: a mock can outlive the test it
        // was keyed to (deleting a test in the editor does not always sweep
        // them), and such an orphan has no name to author it by. It is dead
        // weight the engine ignores either way — but dropping it would make the
        // pulled tree re-export differently from what it was pulled from.
        if (STORED_TEST_ID.test(testName)) {
          resolved[testName] = entry as MockXdo;
          continue;
        }
        throw new Error(
          `${ownerKind} "${ownerName}": a statement mocks a test named "${testName}", ` +
            `which this object does not declare. ` +
            (tests.length === 0
              ? `It declares no tests at all — add one to \`tests\`, or drop the mock. `
              : `Declared tests: ${tests.map((t) => `"${t.name}"`).join(", ")}. `) +
            `A mock is stored against a test's id, so a name that matches nothing ` +
            `would deploy clean and then never apply.`,
        );
      }

      resolved[id] = entry as MockXdo;
    }
    item.mocks = resolved;
  };

  // ITERATIVE, with an explicit stack. A recursive walk overflows on a deeply
  // nested object — the reference walk hit exactly that and is iterative for
  // the same reason, and its regression test catches this one too.
  const pending: unknown[] = [run];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (const child of node) pending.push(child);
      continue;
    }
    if (node === null || typeof node !== "object") continue;
    const item = mockBearingItem(node);
    if (item) rewrite(item);
    // Descend regardless: a container's nested `run[]` lives under `context`,
    // and a stack item carrying mocks may itself be a container.
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      // `mocks` was just rewritten to id-keyed entries; descending would find
      // nothing, and skipping keeps the intent obvious.
      if (key === "mocks") continue;
      pending.push(child);
    }
  }
}

/**
 * Refuse any mock key left unresolved after a kind finished encoding.
 *
 * `mock` is offered on EVERY statement, but only the three kinds that carry
 * `test[]` run {@link resolveMockKeys}. On a task, tool, trigger, agent, or
 * workflow-test stack a mock would otherwise encode still keyed by name, and
 * the engine ignores a mock whose key is not a test id — so it would deploy
 * clean and silently never apply, which is the exact failure the name→id
 * rewrite exists to make impossible.
 *
 * Keyed on the shape of a resolved key (a stored test id) rather than on the kind,
 * so a kind that gains tests later is covered without being listed here.
 */
export function assertMockKeysResolved(xdo: unknown, kindName: string): void {
  // The OBJECT is named, not the stack item the mock sits on: the item's own
  // `name` is its stored statement name (`mvp:workspace_run_function`), which
  // read as though that were the workflow test.
  const kind = AUTHOR_KIND_NAME[kindName] ?? kindName;
  const objectName = (xdo as { name?: unknown } | null)?.name;
  const owner = typeof objectName === "string" ? `${kind} "${objectName}"` : kind;
  const pending: unknown[] = [xdo];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (const child of node) pending.push(child);
      continue;
    }
    if (node === null || typeof node !== "object") continue;
    const item = mockBearingItem(node);
    if (item) {
      for (const key of Object.keys(item.mocks)) {
        if (STORED_TEST_ID.test(key)) continue;
        const stored = (node as { name?: unknown }).name;
        const step = typeof stored === "string" ? `\`${statementLabel(stored)}\`` : "a statement";
        throw new Error(
          `${owner}: ${step} carries \`mock: { "${key}": … }\`, but ${withArticle(kind)} does not store unit tests — ` +
            `only a query, function, or middleware does. A mock is stored against a test's id, ` +
            `so this one would deploy clean and never apply. Move the step into a function ` +
            `that declares the test, or drop the mock.`,
        );
      }
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key === "mocks") continue;
      pending.push(child);
    }
  }
}

/**
 * Refuse a unit test `id` that is not a stored test id, or that two tests of one
 * object share. A stored id is 32 lowercase hex characters or a lowercase dashed
 * UUID — the forms a statement's `mock` is resolved to and checked against — so
 * any other spelling would leave its mocks keyed to nothing.
 */
export function assertTestIds(xdo: unknown, kindName: string): void {
  const tests = (xdo as { test?: unknown } | null)?.test;
  if (!Array.isArray(tests)) return;
  const kind = AUTHOR_KIND_NAME[kindName] ?? kindName;
  const owner = `${kind} "${String((xdo as { name?: unknown }).name)}"`;
  const byId = new Map<unknown, unknown>();
  for (const t of tests as Array<{ id?: unknown; name?: unknown }>) {
    if (typeof t?.id !== "string" || !STORED_TEST_ID.test(t.id)) {
      throw new Error(
        `${owner}: test "${String(t?.name)}" has \`id: ${JSON.stringify(t?.id)}\` — a test id is 32 lowercase hex ` +
          `characters or a dashed UUID. Omit \`id\` to derive one from the test name, or copy the stored id.`,
      );
    }
    if (byId.has(t.id)) {
      throw new Error(`${owner}: tests "${String(byId.get(t.id))}" and "${String(t.name)}" share \`id: "${t.id}"\` — each test needs its own.`);
    }
    byId.set(t.id, t.name);
  }
}
