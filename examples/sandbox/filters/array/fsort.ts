/**
 * `fl.fsort` filter (group: array).
 * Sort an array of elements with an optional path inside the element.
 *
 * `type` is the comparator, and only `"number"` compares NUMERICALLY. Every
 * other spelling — including an unrecognized one — sorts as case-insensitive
 * text, silently: `[2, 10, 1]` comes back `[1, 10, 2]` with no error, which is
 * how a "top N by score/distance/recency" endpoint returns the right rows in
 * the wrong order.
 *
 * The values below are chosen so the two orderings DISAGREE. A numeric sort of
 * 2/10/1 is `one, two, ten`; a text sort is `one, ten, two`. Sorting [1,2,3]
 * cannot tell you which comparator ran.
 */
import { defineFunction, s, c, ref, withFilters, fl } from "@xano/sdk";

export const filterFsort = defineFunction({
  name: "ex_filter_fsort",
  stack: [
    s.set_var(
      "rows",
      c.array([
        { name: "two", score: 2 },
        { name: "ten", score: 10 },
        { name: "one", score: 1 },
      ]),
    ),
    s.set_var(
      "out",
      // [{one,1},{two,2},{ten,10}] — ascending by `score`, numerically.
      // Spell `type` anything else and this returns one, ten, two.
      withFilters(ref("rows"), fl.fsort({ path: "score", type: "number", asc: true })),
    ),
  ],
  response: ref("out"),
});
