/**
 * `fl.sql_alias` filter (group: text).
 * Wraps text in double quotes and escapes any double quotes within the text to prevent SQL injection attacks. This is useful for safely inserting user input into table names or aliases within SQL queries.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSqlAlias = defineFunction({
  name: "ex_filter_sql_alias",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["sql_alias"]()))],
  response: ref("out"),
});
