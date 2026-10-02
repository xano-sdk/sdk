/**
 * Joins the harvested runtime-input enum constraints ({@link ./input-schema.ts})
 * onto an interpreted {@link StatementSpec}'s input rules.
 *
 * ORDER IS LOAD-BEARING: this runs AFTER {@link ./overrides.ts}, never before.
 * The override pass reshapes the input rules — it SYNTHESIZES rules the
 * transform schema never declared (`auth_type` on the search family is one) and
 * RENAMES others (`elasticsearch_request`'s body). Joining first would attach
 * nothing to the synthesized rules and attach to the pre-rename name on the
 * renamed ones, losing those constraints silently. `scripts/codegen.ts` and the
 * reproducibility test both sequence it that way, so the committed catalog and
 * a fresh regeneration agree.
 *
 * The join key is `route.name` — the STORED input name — not `rule.field`, the
 * authoring alias. The two diverge wherever an override renames a field, and
 * wherever upstream's transform schema names a field differently from the input
 * it binds (`mcp_call_tool` authors `tool`, stores `tool_name`). The stored name
 * is the one both sources agree on.
 */
import type { StatementSpec } from "./interpret.js";
import type { StatementEnums } from "./input-schema.js";

/** Stored statement name → its harvested enum constraints. */
export type EnumIndex = ReadonlyMap<string, StatementEnums>;

/**
 * Attach `enum` to every input rule of `spec` the index constrains, in place.
 * Idempotent, and a no-op for a statement the index does not cover.
 */
export function attachEnums(spec: StatementSpec, index: EnumIndex): void {
  const enums = index.get(spec.name);
  if (!enums) return;
  for (const rule of spec.rules) {
    if (rule.route.kind !== "input") continue;
    const values = enums[rule.route.name];
    if (values) rule.enum = [...values];
  }
}
