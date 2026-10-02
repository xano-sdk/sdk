/**
 * `fl.sql_esc` filter (group: text).
 * Wraps text in single quotes and escapes any single quotes within the text to prevent SQL injection attacks. This is useful for safely inserting user input into values within SQL queries.
 *
 * Filters attach to a value with `withFilters(value, fl.<name>(...))`.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterSqlEsc = defineFunction({
  name: "ex_filter_sql_esc",
  stack: [s.set_var("out", withFilters(c.text("Hello World"), fl["sql_esc"]()))],
  response: ref("out"),
});
