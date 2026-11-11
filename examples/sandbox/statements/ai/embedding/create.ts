/**
 * `s.ai.embedding.create` — vectors from a Xano AI embedding model.
 *
 * REQUIRED: `input`, a text, a file resource, or a list of either. Optional:
 * `task_type` (`RETRIEVAL_QUERY`, `RETRIEVAL_DOCUMENT`, `SEMANTIC_SIMILARITY`,
 * …), `dimensions` (up to the model's `max_dimensions`), and `model`.
 *
 * `.embeddings` is ALWAYS a list, one vector per input in input order: a
 * single input still binds a list of one, so read `embeddings[0]`.
 *
 * `location` blank inherits the workspace's Xano AI location.
 */
import { c, defineFunction, inp, input, ref, s } from "@xano/sdk";

export const aiEmbeddingCreate = defineFunction({
  name: "ex_ai_embedding_create",
  input: { query: input.text({ required: true }) },
  stack: [
    s.ai.embedding.create({
      as: "vectors",
      model: "gemini-embedding-2",
      input: inp("query"),
      task_type: c.text("RETRIEVAL_QUERY"),
      dimensions: c.int(768),
      location: "",
    }),
  ],
  // One input, so a list holding one vector.
  response: ref("vectors.embeddings"),
});
