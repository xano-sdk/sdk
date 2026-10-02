/**
 * `obj({...})` — a DYNAMIC object value, the sibling of `c.obj`.
 *
 * `c.obj` takes plain JSON only and rejects nested tagged values, so it cannot
 * express `{ id: inp("id") }`. `obj()` can: members may be `inp`/`ref`/`auth`/
 * `col`, `env()`/`sys.*`, `c.now()`, `c.*` constants, nested records and arrays.
 *
 * PARAM GATE: a member may carry a FILTER CHAIN. That is what makes gate 2 the
 * normal shape rather than a workaround — `db.get` binds null on a miss, so the
 * null-safe drill (which compiles through the `get` filter) belongs inline, not
 * hoisted into an `s.set_var` per member.
 */
import { defineFunction, s, c, ref, inp, obj, sys, withFilters, fl, input } from "@xano/sdk";
import { posts } from "../_shared.js";

/** Gate 1 — live references and constants side by side in one object. */
export const objDynamic = defineFunction({
  name: "ex_value_obj_dynamic",
  input: { title: input.text() },
  stack: [s.set_var("payload", obj({ title: inp("title"), at: c.now(), ip: sys.remoteIp() }))],
  response: ref("payload"),
});

/**
 * Gate 2 — filtered members, including the null-safe drill.
 *
 * `owner` is null when no row matches, so `ref(path, { safe: true })` yields
 * null instead of raising "Unable to locate var". Both members render as the
 * expression pipe (`$var.owner|get:"author_id":null`), which is one value — no
 * intermediate variables.
 */
export const objFiltered = defineFunction({
  name: "ex_value_obj_filtered",
  stack: [
    s.db.get({ table: posts, fieldValue: c.int(1), as: "owner" }),
    s.set_var(
      "summary",
      obj({
        author_id: ref("owner.author_id", { safe: true }),
        title_upper: withFilters(ref("owner.title", { safe: true }), fl.upper()),
      }),
    ),
  ],
  response: ref("summary"),
});
