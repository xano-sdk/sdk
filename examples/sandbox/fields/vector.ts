/**
 * `f.vector(size)` field type — a fixed-dimension embedding column.
 *
 * The index is half of what makes the column useful: pair the `op` with the
 * distance filter the query ranks by (`vector_cosine_ops` ↔
 * `vector_cos_distance`), or the query cannot use it. See
 * `statements/db/query.ts` gate 7 for the search itself.
 */
import { table, f } from "@xano/sdk";

export const fieldVector = table({
  name: "ex_field_vector",
  schema: {
    content: f.text(),
    embedding: f.vector(1536),
  },
  index: [{ type: "vector", fields: [{ name: "embedding", op: "vector_cosine_ops" }] }],
});
