/**
 * Shared handles referenced across the implementation examples.
 *
 * The examples form one deployable workspace (see `index.ts`). Cross-object
 * references — a `db.get` on a table, an `s.function.run` on a function, a query
 * bound to an API group — all point at the handles defined here so the whole set
 * type-checks and exports as a single coherent Xano workspace.
 */
import { apiGroup, table, f, defineFunction, input, s, ref, inp } from "@xano/sdk";

/** The API group every example query is published under. */
export const api = apiGroup({ name: "examples", canonical: "examples" });

/** A canonical auth table — users. Referenced by `auth(...)`, `db.*`, triggers. */
export const users = table({
  name: "users",
  auth: true,
  schema: {
    email: f.email({ required: true }),
    name: f.text(),
    votes: f.int({ default: "0" }),
    password: f.password(),
    role: f.enum(["admin", "member"], { default: "member" }),
    verified: f.bool({ default: "false" }),
    bio: f.text({ format: "markdown" }),
  },
  index: [{ type: "unique", fields: [{ name: "email" }] }],
});

/** A second table with a foreign key to `users`, for join / addon / relation examples. */
export const posts = table({
  name: "posts",
  schema: {
    title: f.text({ required: true }),
    body: f.text(),
    author_id: f.tableRef(users, { required: true }),
    published: f.bool({ default: "false" }),
    tags: f.text({ array: true }),
    score: f.decimal({ default: "0" }),
  },
});

/** A tiny reusable function target for the call-family examples (`s.function.run`, …). */
export const doubleFn = defineFunction({
  name: "ex_shared_double",
  input: { n: input.int({ required: true }) },
  stack: [s.math.mul({ name: "n", value: inp("n") })],
  response: ref("n"),
});
