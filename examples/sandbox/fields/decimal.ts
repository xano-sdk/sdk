/**
 * `f.decimal` field type — shown as a column on a table (a field type lives in a
 * table schema, it is not a standalone object).
 *
 * The column has a FIXED size — 5 decimal places out of 14 total digits — and
 * takes no precision option, so `0.12345678` stores as `0.12346` at HTTP 200
 * with no error. Do not reach for it to hold money at sub-cent precision: a
 * price that rounds on write reconciles against a cost basis computed from the
 * un-rounded number, and the difference shows up as arithmetic that no longer
 * adds up rather than as anything that reports itself. Hold a whole count of
 * the smallest unit in an `f.int` instead — and see `fields/int.ts`, because
 * that column has a silent bound of its own.
 */
import { table, f } from "@xano/sdk";

export const fieldDecimal = table({
  name: "ex_field_decimal",
  schema: {
    primary: f.decimal({ default: "0" }),
    rate: f.decimal(),
  },
});
