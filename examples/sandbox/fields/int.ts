/**
 * `f.int` field type — shown as a column on a table (a field type lives in a
 * table schema, it is not a standalone object).
 *
 * Signed 64-bit, and past `9223372036854775807` it CLAMPS rather than failing:
 * an overflowed count comes back as the ceiling, at HTTP 200, reading like a
 * real number. Worth knowing when this column is the answer to `f.decimal`'s
 * 5dp limit (see `fields/decimal.ts`) — a count of satoshis or cents has room
 * to spare, but nothing warns you at the top. `JSON.parse` also rounds past
 * `9007199254740991`, well below the column bound, so read a count that large
 * as text or BigInt on the client.
 */
import { table, f } from "@xano/sdk";

export const fieldInt = table({
  name: "ex_field_int",
  schema: {
    primary: f.int({ default: "0" }),
    quantity: f.int({ array: true }),
  },
});
