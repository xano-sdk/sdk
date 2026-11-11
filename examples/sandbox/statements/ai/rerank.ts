/**
 * `s.ai.rerank` — order documents by relevance to a query.
 *
 * REQUIRED: `query` and `documents`, a non-empty list of texts or
 * `{ id?, title?, content }` objects (ids unique when given). Optional: `top_n`
 * (keep the best N) and `model`.
 *
 * `.results` comes back best first. Each result's `index` is its position in
 * `documents`; `id` is the document's own id, or that index as a string.
 *
 * `location` blank inherits the workspace's Xano AI location.
 */
import { c, defineFunction, inp, input, ref, s } from "@xano/sdk";

export const aiRerank = defineFunction({
  name: "ex_ai_rerank",
  input: { query: input.text({ required: true }) },
  stack: [
    s.ai.rerank({
      as: "ranked",
      model: "semantic-ranker-default-005",
      query: inp("query"),
      documents: c.array([
        { id: "refunds", content: "Refunds are issued within 5 business days." },
        { id: "shipping", content: "Orders ship from our warehouse in 2 days." },
      ]),
      top_n: c.int(1),
      location: "",
    }),
  ],
  response: ref("ranked.results"),
});
