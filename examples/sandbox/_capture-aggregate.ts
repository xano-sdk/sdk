/**
 * db.query aggregate capture harness (NOT a shipped example, NOT auto-indexed).
 *
 * RE-SOURCES `test/fixtures/statements/db_query_aggregate.json`. A golden
 * storing `group`/`eval` names qualified by the table name (`posts.published`)
 * with NO `context.dbo.as` beside them is a statement that does not run: the
 * engine resolves a qualifier against the alias the statement declares, and one
 * that declares none answers `Unsupported object reference - posts.published`.
 * A faithful readback of bytes this SDK imported proves the engine STORES them,
 * not that it can execute them. A round-trip oracle can freeze a broken
 * statement; only running it catches that.
 *
 * `db.query` emits `dbo.as` whenever it adds the qualifier itself, so this
 * capture pins the shape that both round-trips AND executes. Captured with
 * `--runtime` for exactly that reason.
 *
 * One statement per function so the golden promotes straight out of `run[0]`.
 * The table and the aggregate block mirror the `db_query_aggregate` corpus row
 * in test/conformance/corpus.test.ts — keep the two in step.
 *
 * Run:  node dist/bin.js validate examples/sandbox/_capture-aggregate.ts --capture --runtime --out validate-out
 */
import { workspace, defineFunction, table, f, s, ref } from "@xano/sdk";

const defs = (xs: unknown[]) => xs as never[];

/** Mirrors `capPosts` in the corpus — the dbo guid and the qualified names both derive from the name. */
const posts = table({ name: "posts", schema: { published: f.bool(), score: f.decimal() } });

/**
 * Bare authored names (`"published"`, `"id"`, `"score"`) — the documented form.
 * The SDK qualifies them to `posts.<col>` on emit and declares `posts` as the
 * statement's alias so the qualifier resolves.
 */
const probeQueryAggregate = defineFunction({
  name: "ex_probe_query_aggregate",
  stack: [
    s.db.query({
      table: posts,
      returnType: "aggregate",
      aggregate: {
        group: [{ name: "published", as: "published" }],
        eval: [
          { name: "id", as: "count", filters: [{ name: "count" }] },
          { name: "score", as: "total", filters: [{ name: "sum" }] },
        ],
      },
      as: "rollup",
    }),
  ],
  response: ref("rollup"),
});

export default workspace("xanosdk-capture-aggregate")
  .registerTables(defs([posts]))
  .registerFunctions(defs([probeQueryAggregate]));
