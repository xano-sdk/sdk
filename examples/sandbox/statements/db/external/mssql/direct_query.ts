/**
 * `s.db.external.mssql.direct_query` — run raw SQL against an external
 * mssql database over a connection string. Keep the connection in a workspace
 * environment variable rather than a literal. Binds the result list.
 */
import { defineFunction, s, env, inp, ref, input } from "@xano/sdk";

export const dbExternalMssqlDirectQuery = defineFunction({
  name: "ex_db_external_mssql_direct_query",
  input: { id: input.int({ required: true }) },
  stack: [
    s.db.external.mssql.direct_query({
      sql: "SELECT * FROM accounts WHERE id = ?",
      connectionString: env("EXTERNAL_MSSQL_CONNECTION"),
      args: [inp("id")],
      as: "rows",
    }),
  ],
  response: ref("rows"),
});
