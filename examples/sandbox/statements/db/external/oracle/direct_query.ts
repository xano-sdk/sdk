/**
 * `s.db.external.oracle.direct_query` — run raw SQL against an external
 * oracle database over a connection string. Keep the connection in a workspace
 * environment variable rather than a literal. Binds the result list.
 */
import { defineFunction, s, env, inp, ref, input } from "@xano/sdk";

export const dbExternalOracleDirectQuery = defineFunction({
  name: "ex_db_external_oracle_direct_query",
  input: { id: input.int({ required: true }) },
  stack: [
    s.db.external.oracle.direct_query({
      sql: "SELECT * FROM accounts WHERE id = ?",
      connectionString: env("EXTERNAL_ORACLE_CONNECTION"),
      args: [inp("id")],
      as: "rows",
    }),
  ],
  response: ref("rows"),
});
